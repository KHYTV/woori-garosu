"""웹 데모(docs/)용 정적 데이터를 만든다.

  python -m pipeline.export_web                       # data/out/jeonju_extract → docs/data
  python -m pipeline.export_web --dataset sample_jeonju_synthetic

run_all이 만든 carbon_profiles.csv·results.json을 읽어, 지도가 바로 쓰는 열 단위 JSON과
요약·계수 JSON을 docs/data/에 쓰고, 분석 보고서를 docs/report/에 복사한다.
"""

import argparse
import json
import re
import shutil

import pandas as pd
from shapely.geometry import Point, shape
from shapely.prepared import prep

from . import carbon, etl
from .schema import CONFIG_DIR, OUT_DIR, RAW_DIR, ROOT

DOCS = ROOT / "docs"
GRADES = ["A", "B", "C", "X"]
# 구간 시점·종점명("호성동1가 743-158 잡")에서 동 이름만 뽑는다
DONG_PATTERN = re.compile(r"([가-힣]{1,6}(?:동|가|리)(?:\d+가)?)")


def _round_list(series, digits):
    return [None if pd.isna(v) else round(float(v), digits) for v in series]


def raw_by_tree(dataset: str) -> dict[str, dict]:
    """원자료의 구간 시점·종점명에서 나무별 동 이름과 '시점 → 종점' 구간 문자열을 찾는다. 원자료가 없으면 빈 dict."""
    raw = RAW_DIR / f"{dataset}.csv"
    if not raw.exists():
        return {}
    df = etl.read_source(raw)
    found = {}
    for tid, start, end in zip(df["tree_no"].astype(str), df["section_start"].fillna(""), df["section_end"].fillna("")):
        if tid in found:
            continue
        start, end = str(start).strip(), str(end).strip()
        m = DONG_PATTERN.search(start) or DONG_PATTERN.search(end)
        section = " → ".join(x for x in (start, end) if x) or None
        found[tid] = {"dong": m.group(1) if m else None, "section": section}
    return found


def dong_by_tree(dataset: str) -> dict[str, str]:
    return {k: v["dong"] for k, v in raw_by_tree(dataset).items() if v["dong"]}


HJD_FILE = CONFIG_DIR / "boundaries" / "jeonju_hangjeongdong.geojson"


def load_hangjeongdong():
    """전주시 행정동 경계(vuski/admdongkor, 통계청·행안부 경계 기반). [(이름, prepared polygon)]"""
    if not HJD_FILE.exists():
        return []
    gj = json.loads(HJD_FILE.read_text(encoding="utf-8"))
    out = []
    for f in gj["features"]:
        name = f["properties"]["adm_nm"].split()[-1]
        out.append((name, prep(shape(f["geometry"]))))
    return out


def assign_dong(lons, lats, polygons) -> list:
    """좌표가 들어 있는 행정동 이름. 경계 밖이면 None. 구간 이름 글자에서 뽑는 것보다 정확하다."""
    out = []
    for lon, lat in zip(lons, lats):
        if pd.isna(lon) or pd.isna(lat):
            out.append(None)
            continue
        pt = Point(float(lon), float(lat))
        out.append(next((name for name, poly in polygons if poly.contains(pt)), None))
    return out


def places(df: pd.DataFrame) -> list[dict]:
    """주소 검색용 장소 목록: 동과 도로구간마다 나무 수와 중심 좌표."""
    out = []
    for kind, col in (("dong", "dong"), ("jibun", "jibun_dong"), ("road", "road_section")):
        if col not in df.columns:
            continue
        grouped = df.dropna(subset=[col]).groupby(col)
        for name, g in grouped:
            out.append({"kind": kind, "name": str(name), "count": int(len(g)),
                        "lon": round(float(g["lon"].mean()), 5), "lat": round(float(g["lat"].mean()), 5)})
    return sorted(out, key=lambda p: (p["kind"], -p["count"]))


def export(dataset: str) -> dict:
    src = OUT_DIR / dataset
    df = pd.read_csv(src / "carbon_profiles.csv", encoding="utf-8-sig", dtype={"tree_id": str})
    result = json.loads((src / "results.json").read_text(encoding="utf-8"))
    df = df[df["grade"] != "X"].reset_index(drop=True)

    species = sorted(df["species_ko"].unique())
    roads = sorted(df["road_section"].astype(str).unique())
    sp_idx = {s: i for i, s in enumerate(species)}
    rd_idx = {r: i for i, r in enumerate(roads)}
    issues = df["issues"].fillna("")
    raw = raw_by_tree(dataset)
    df["section"] = df["tree_id"].map({k: v["section"] for k, v in raw.items()})
    # 동은 좌표를 행정동 경계에 넣어 정한다. 경계 파일이 없을 때만 구간 이름 글자(법정동)로 대신한다
    polygons = load_hangjeongdong()
    df["jibun_dong"] = df["tree_id"].map({k: v["dong"] for k, v in raw.items()})
    df["dong"] = assign_dong(df["lon"], df["lat"], polygons) if polygons else df["jibun_dong"]
    dongs = sorted(df["dong"].dropna().unique())
    dong_idx = {d: i for i, d in enumerate(dongs)}
    sections = sorted(df["section"].dropna().unique())
    sec_idx = {x: i for i, x in enumerate(sections)}
    trees = {
        "species": species, "roads": roads, "dongs": dongs, "sections": sections, "grades": GRADES,
        "id": df["tree_id"].tolist(),
        "dong": [None if pd.isna(d) else dong_idx[d] for d in df["dong"]],
        "sec": [None if pd.isna(x) else sec_idx[x] for x in df["section"]],
        "lon": _round_list(df["lon"], 6), "lat": _round_list(df["lat"], 6),
        "dbh": _round_list(df["dbh_cm"], 1),
        "sp": df["species_ko"].map(sp_idx).tolist(),
        "rd": df["road_section"].astype(str).map(rd_idx).tolist(),
        "grade": df["grade"].map(GRADES.index).tolist(),
        "block": issues.str.contains("dbh_block").astype(int).tolist(),
        "seq": [_round_list(df[f"seq_co2_p{q}"], 1) for q in (10, 50, 90)],
        "stor": [_round_list(df[f"storage_co2_p{q}"], 0) for q in (10, 50, 90)],
        "point_seq": _round_list(df["point_seq_co2"], 1),
    }

    table = etl.load_species_table().set_index("species_ko")
    species_info = {
        s: {k: table.loc[s, k] for k in ("scientific_name", "jenkins_group", "alt_group", "growth_class",
                                         "mature_height_class", "crown_shape", "leaf_habit", "autumn_color",
                                         "autumn_color_name", "mapping_note")}
        for s in species
    }
    summary = {
        "meta": result["meta"], "extraction": result["extraction"], "quality": result["quality"],
        "totals": result["totals"], "model_notes": result["model_notes"],
        "species": [{k: s[k] for k in ("species", "scientific_name", "count", "median_dbh", "total_seq_t",
                                        "total_storage_t", "rep_seq", "dbh_block_share")} for s in result["species"]],
        "roads": sorted(result["roads"], key=lambda r: -r["count"])[:30],
        "species_info": species_info,
    }

    out = DOCS / "data"
    out.mkdir(parents=True, exist_ok=True)
    compact = {"separators": (",", ":"), "ensure_ascii": False}
    (out / "trees.json").write_text(json.dumps(trees, **compact), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, **compact), encoding="utf-8")
    (out / "params.json").write_text(json.dumps(carbon.load_params(), **compact), encoding="utf-8")
    (out / "places.json").write_text(json.dumps(places(df), **compact), encoding="utf-8")
    shutil.copyfile(CONFIG_DIR / "boundaries" / "jeonju_osm.geojson", out / "boundary.geojson")
    shutil.copyfile(CONFIG_DIR / "tree_form.json", out / "tree_form.json")
    shutil.copyfile(CONFIG_DIR / "activities.json", out / "activities.json")

    reports = DOCS / "report"
    reports.mkdir(parents=True, exist_ok=True)
    for name, target in (("jeonju_extract", "jeonju.html"), ("sample_jeonju_synthetic", "sample.html")):
        report = OUT_DIR / name / "report.html"
        if report.exists():
            html = report.read_text(encoding="utf-8")
            # 보고서는 게시용 뼈대 없이 만들어지므로 독립 페이지로 쓸 수 있게 문서 틀을 씌운다
            if not html.lstrip().lower().startswith("<!doctype"):
                html = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
                        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                        '<style>body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
                        + html + "\n</body>\n</html>\n")
            (reports / target).write_text(html, encoding="utf-8")
    return {"trees": len(df), "species": len(species), "roads": len(roads), "dongs": len(dongs),
            "dong_source": "행정동 경계(좌표)" if polygons else "구간 이름 글자(법정동)",
            "trees_without_dong": int(df["dong"].isna().sum()),
            "bytes": {p.name: p.stat().st_size for p in out.iterdir()}}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="jeonju_extract")
    args = ap.parse_args()
    print(json.dumps(export(args.dataset), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
