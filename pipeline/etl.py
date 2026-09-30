"""원본 정제·좌표 변환·품질 감사.

품질 등급
  A: 문제 없음
  B: 경미 (수종명 공백 정리, 목록에 없는 수종 → '기타')
  C: 흉고 결측·이상 → 탄소 계산 제외, 지도에는 표시("측정 필요")
  X: 위치 사용 불가(결측·좌표계 불명·범위 밖·중복) → 지도·계산 모두 제외
참고 기록(시군구명 공란, 좌표계 변환)은 원본 전체의 특성이라 등급에 반영하지 않고 건수만 센다.
"""

from collections import Counter

import numpy as np
import pandas as pd
from pyproj import Transformer

from .schema import (CONFIG_DIR, CRS_ALIASES, DBH_BLOCK_MIN_REPEAT, DBH_MAX_PLAUSIBLE_CM, JEONJU_BBOX,
                      LARGE_TREE_DBH_CM, SOURCE_COLUMNS, SOURCE_COLUMNS_EN)

ISSUE_LABELS = {
    "species_alias": "수종명 공백 정리",
    "species_unmapped": "수종 목록에 없음 → 기타",
    "species_missing": "수종 결측·미상",
    "dbh_missing": "흉고 결측",
    "dbh_non_numeric": "흉고 숫자 아님",
    "dbh_nonpositive": "흉고 0 이하",
    "dbh_outlier": f"흉고 {DBH_MAX_PLAUSIBLE_CM:.0f}cm 초과",
    "coord_missing": "좌표 결측",
    "crs_unknown": "좌표계코드 불명",
    "crs_converted": "좌표계 변환(→WGS84)",
    "xy_swapped": "X·Y 뒤바뀜 의심",
    "out_of_bounds": "전주 범위 밖",
    "duplicate": "중복(같은 위치·수종)",
    "sgg_missing": "시군구명 공란",
    "dbh_block": f"흉고 일괄 입력 의심(구간·수종 내 같은 값 {DBH_BLOCK_MIN_REPEAT}그루 이상)",
}
GRADE_X = {"coord_missing", "crs_unknown", "xy_swapped", "out_of_bounds", "duplicate"}
GRADE_C = {"dbh_missing", "dbh_non_numeric", "dbh_nonpositive", "dbh_outlier"}
GRADE_B = {"species_alias", "species_unmapped", "species_missing"}
INFO_ONLY = {"crs_converted", "sgg_missing", "dbh_block"}
DESCRIPTIVE_FIELDS = {"street_green_type": "가로내녹지유형명", "roadside_green_type": "도로변녹지유형명",
                      "climate_zone": "기후대구분명", "site_type": "입지명"}


def read_source(path) -> pd.DataFrame:
    for enc in ("utf-8-sig", "cp949"):
        try:
            df = pd.read_csv(path, dtype=str, keep_default_na=False, encoding=enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError(f"인코딩을 판별할 수 없음: {path}")
    mapping = SOURCE_COLUMNS if "수종명" in df.columns else SOURCE_COLUMNS_EN
    missing = [c for c in mapping if c not in df.columns]
    if missing:
        raise ValueError(f"원본 컬럼 누락: {missing}")
    return df.rename(columns=mapping)[list(mapping.values())]


def load_species_table() -> pd.DataFrame:
    return pd.read_csv(CONFIG_DIR / "species.csv", dtype=str, keep_default_na=False)


def _species_lookup(table: pd.DataFrame) -> dict:
    lookup = {}
    for _, r in table.iterrows():
        lookup[r.species_ko] = r.species_ko
        for alias in filter(None, r.aliases.split("|")):
            lookup[alias] = r.species_ko
    return lookup


def normalize_species(raw: pd.Series, table: pd.DataFrame):
    lookup = _species_lookup(table)
    names, issues = [], []
    for value in raw:
        key = "".join(str(value).split())
        if key in ("", "미상", "모름", "불명"):
            names.append("기타"); issues.append("species_missing")
        elif key in lookup:
            # 별칭(왕벚나무→벚나무 등)은 정상 표기로 보고, 공백이 섞인 경우만 기록한다
            names.append(lookup[key])
            issues.append("species_alias" if key != str(value) else None)
        else:
            names.append("기타"); issues.append("species_unmapped")
    return names, issues


def parse_dbh(raw: pd.Series):
    values, issues = [], []
    for v in raw:
        s = str(v).strip()
        if s == "":
            values.append(np.nan); issues.append("dbh_missing"); continue
        try:
            d = float(s)
        except ValueError:
            values.append(np.nan); issues.append("dbh_non_numeric"); continue
        if d <= 0:
            values.append(np.nan); issues.append("dbh_nonpositive")
        elif d > DBH_MAX_PLAUSIBLE_CM:
            values.append(np.nan); issues.append("dbh_outlier")
        else:
            values.append(d); issues.append(None)
    return values, issues


def _in_bbox(lon, lat):
    b = JEONJU_BBOX
    return (b["lon_min"] <= lon <= b["lon_max"]) and (b["lat_min"] <= lat <= b["lat_max"])


def transform_coords(df: pd.DataFrame):
    lon = np.full(len(df), np.nan)
    lat = np.full(len(df), np.nan)
    issues = [[] for _ in range(len(df))]
    x = pd.to_numeric(df["x_raw"], errors="coerce").to_numpy()
    y = pd.to_numeric(df["y_raw"], errors="coerce").to_numpy()
    crs = df["crs_raw"].str.upper().str.replace(" ", "", regex=False).map(CRS_ALIASES)
    for code in crs.dropna().unique():
        mask = (crs == code).to_numpy() & ~np.isnan(x) & ~np.isnan(y)
        if not mask.any():
            continue
        if code == "EPSG:4326":
            lon[mask], lat[mask] = x[mask], y[mask]
        else:
            tr = Transformer.from_crs(code, "EPSG:4326", always_xy=True)
            lon[mask], lat[mask] = tr.transform(x[mask], y[mask])
            for i in np.flatnonzero(mask):
                issues[i].append("crs_converted")
    for i in range(len(df)):
        if np.isnan(x[i]) or np.isnan(y[i]):
            issues[i].append("coord_missing")
        elif pd.isna(crs.iloc[i]):
            issues[i].append("crs_unknown")
        elif not _in_bbox(lon[i], lat[i]):
            swapped = crs.iloc[i] == "EPSG:4326" and _in_bbox(lat[i], lon[i])
            issues[i].append("xy_swapped" if swapped else "out_of_bounds")
            lon[i] = lat[i] = np.nan
    return lon, lat, issues


def grade(issue_list) -> str:
    s = set(issue_list)
    if s & GRADE_X:
        return "X"
    if s & GRADE_C:
        return "C"
    if s & GRADE_B:
        return "B"
    return "A"


def clean(raw: pd.DataFrame) -> pd.DataFrame:
    table = load_species_table().set_index("species_ko")
    df = raw.copy()
    species, sp_issue = normalize_species(df["species_raw"], table.reset_index())
    dbh, dbh_issue = parse_dbh(df["dbh_raw"])
    lon, lat, coord_issues = transform_coords(df)
    df["species_ko"] = species
    df["dbh_cm"] = dbh
    df["lon"], df["lat"] = lon, lat
    sgg_issue = ["sgg_missing" if not str(v).strip() else None for v in df["sgg_name"]]
    issues = [[i for i in (a, b, s) if i] + c for a, b, s, c in zip(sp_issue, dbh_issue, sgg_issue, coord_issues)]
    # 같은 위치(약 1m)·같은 수종이면 두 번째 이후를 중복으로 본다
    key = df["lat"].round(5).astype(str) + "|" + df["lon"].round(5).astype(str) + "|" + df["species_ko"]
    dup = df["lat"].notna() & key.duplicated(keep="first")
    for i in np.flatnonzero(dup.to_numpy()):
        issues[i].append("duplicate")
    # 흉고 일괄 입력 의심: 탄소 계산에서 흉고 오차를 크게 잡는 데 쓴다
    repeat = df.groupby(["road_section", "species_ko", "dbh_cm"])["dbh_cm"].transform("size")
    df["dbh_block"] = df["dbh_cm"].notna() & (repeat >= DBH_BLOCK_MIN_REPEAT)
    for i in np.flatnonzero(df["dbh_block"].to_numpy()):
        issues[i].append("dbh_block")
    df["issues"] = [";".join(x) for x in issues]
    df["grade"] = [grade(x) for x in issues]
    df["tree_id"] = df["tree_no"].where(df["tree_no"] != "", pd.Series(df.index).map(lambda i: f"ROW-{i:06d}"))
    for col in ("scientific_name", "jenkins_group", "alt_group", "growth_class", "mature_height_class", "mapping_note"):
        df[col] = df["species_ko"].map(table[col])
    df["on_map"] = df["grade"] != "X"
    df["carbon_eligible"] = df["grade"].isin(["A", "B"])
    return df


def _dbh_digit_profile(dbh: pd.Series) -> dict:
    """흉고 끝자리 분포. 실측이면 끝자리가 고르게, 눈대중·반올림이면 0과 5에 몰린다."""
    d = dbh.dropna()
    if d.empty:
        return {}
    last = (d.round() % 10).astype(int)
    return {
        "n": int(len(d)),
        "share_0_or_5": round(float(last.isin([0, 5]).mean()), 4),
        "by_last_digit": {int(k): round(float(v), 4) for k, v in last.value_counts(normalize=True).sort_index().items()},
        "large_tree_share": round(float((d >= LARGE_TREE_DBH_CM).mean()), 4),
    }


def quality_report(df: pd.DataFrame) -> dict:
    counts = Counter(i for s in df["issues"] for i in s.split(";") if i)
    n = len(df)
    return {
        "rows": n,
        "grades": {g: int((df["grade"] == g).sum()) for g in "ABCX"},
        "issues": [
            {"code": code, "label": ISSUE_LABELS[code], "count": int(counts.get(code, 0)),
             "share": round(counts.get(code, 0) / n, 4), "info_only": code in INFO_ONLY}
            for code in ISSUE_LABELS if counts.get(code, 0)
        ],
        # 한 값이 99% 이상을 차지해 정보가 없는 설명 항목
        "uninformative_fields": [
            {"field": label, "value": str(df[col].mode().iloc[0]),
             "share": round(float((df[col] == df[col].mode().iloc[0]).mean()), 4)}
            for col, label in DESCRIPTIVE_FIELDS.items()
            if len(df) and (df[col] == df[col].mode().iloc[0]).mean() >= 0.99
        ],
        "completeness": {
            "수종": round(1 - (counts["species_missing"]) / n, 4),
            "흉고직경": round(df["dbh_cm"].notna().mean(), 4),
            "좌표": round(df["lat"].notna().mean(), 4),
        },
        "dbh_digits": _dbh_digit_profile(df["dbh_cm"]),
        "on_map": int(df["on_map"].sum()),
        "carbon_eligible": int(df["carbon_eligible"].sum()),
    }
