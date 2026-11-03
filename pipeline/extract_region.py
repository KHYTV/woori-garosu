"""전국 원본에서 한 도시의 가로수만 뽑는다.

2025-08-26판 원본은 전북 지역 행의 시군구명이 비어 있어 이름으로는 전주를 찾을 수 없다.
시군구명에 도시명이 있거나, 시군구명이 비어 있고 좌표가 행정경계 안(또는 경계 밖 buffer_m 안)에 있는 행을 고른다.
OSM 경계선과 산림청 좌표가 조금씩 어긋나 경계 바로 밖(최대 약 170m)에 찍힌 전주 나무 36그루가 있어 기본 300m 여유를 둔다.
2025-08-26판에서 시군구명이 빈 행 중 전주 경계 3km 안에 드는 것은 이 36그루뿐이라 이웃 시군 나무가 섞이지 않는다.

  python -m pipeline.extract_region --input 전국원본.csv --boundary config/boundaries/jeonju_osm.geojson --name 전주
"""

import argparse
import json

import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from shapely.geometry import shape

from .schema import CONFIG_DIR, CRS_ALIASES, RAW_DIR


def read_raw(path) -> pd.DataFrame:
    for enc in ("utf-8-sig", "cp949"):
        try:
            return pd.read_csv(path, dtype=str, keep_default_na=False, encoding=enc)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"인코딩을 판별할 수 없음: {path}")


def to_lonlat(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    lon = np.full(len(df), np.nan)
    lat = np.full(len(df), np.nan)
    x = pd.to_numeric(df["지역X좌표"], errors="coerce").to_numpy()
    y = pd.to_numeric(df["지역Y좌표"], errors="coerce").to_numpy()
    crs = df["좌표계코드"].str.upper().str.replace(" ", "", regex=False).map(CRS_ALIASES)
    for code in crs.dropna().unique():
        m = (crs == code).to_numpy() & ~np.isnan(x) & ~np.isnan(y)
        if code == "EPSG:4326":
            lon[m], lat[m] = x[m], y[m]
        else:
            lon[m], lat[m] = Transformer.from_crs(code, "EPSG:4326", always_xy=True).transform(x[m], y[m])
    return lon, lat


BUFFER_M = 300


def buffered(boundary, buffer_m: float):
    """경계를 buffer_m만큼 넓힌다. 경도 1도가 위도 1도보다 짧으므로 경도 방향 기준으로 잡아 어느 방향이든 buffer_m 이상이 되게 한다."""
    if not buffer_m:
        return boundary
    lat = boundary.centroid.y
    out = boundary.buffer(buffer_m / (111320 * np.cos(np.radians(lat))))
    shapely.prepare(out)
    return out


def extract(df: pd.DataFrame, boundary, name: str, buffer_m: float = BUFFER_M) -> tuple[pd.DataFrame, dict]:
    lon, lat = to_lonlat(df)
    sgg = df["시군구명"].str.strip()
    located = ~np.isnan(lon)
    inside = np.zeros(len(df), dtype=bool)
    inside[located] = shapely.contains_xy(boundary, lon[located], lat[located])
    near = inside.copy()
    near[located] = shapely.contains_xy(buffered(boundary, buffer_m), lon[located], lat[located])
    by_name = sgg.str.contains(name, regex=False).to_numpy()
    blank = (sgg == "").to_numpy()
    selected = by_name | (blank & near)
    summary = {
        "national_rows": int(len(df)),
        "national_blank_sgg_rows": int(blank.sum()),
        "national_blank_crs_rows": int((df["좌표계코드"].str.strip() == "").sum()),
        "national_crs": {k or "(빈 값)": int(v) for k, v in df["좌표계코드"].value_counts().items()},
        "sgg_count": int(sgg[sgg != ""].nunique()),
        "matched_by_name": int(by_name.sum()),
        "inside_boundary": int(inside.sum()),
        "inside_boundary_blank_sgg": int((inside & blank).sum()),
        "buffer_m": buffer_m,
        "near_boundary_blank_sgg": int((near & ~inside & blank).sum()),
        "inside_boundary_other_sgg": sorted(set(sgg[inside & ~blank & ~by_name])),
        "blank_sgg_unlocatable": int((blank & ~located).sum()),
        "selected_rows": int(selected.sum()),
    }
    return df[selected].copy(), summary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True)
    ap.add_argument("--boundary", default=str(CONFIG_DIR / "boundaries" / "jeonju_osm.geojson"))
    ap.add_argument("--name", default="전주")
    ap.add_argument("--out", default=str(RAW_DIR / "jeonju_extract.csv"))
    ap.add_argument("--buffer-m", type=float, default=BUFFER_M, help="시군구명이 빈 행을 경계 밖 이 거리(m)까지 받아들인다")
    args = ap.parse_args()

    fc = json.loads(open(args.boundary, encoding="utf-8").read())
    boundary = shapely.union_all([shape(f["geometry"]) for f in fc["features"]])
    shapely.prepare(boundary)
    sub, summary = extract(read_raw(args.input), boundary, args.name, args.buffer_m)
    summary.update({"input": args.input, "boundary": args.boundary,
                    "boundary_source": fc["features"][0]["properties"].get("source", ""), "name": args.name})
    sub.to_csv(args.out, index=False, encoding="utf-8-sig")
    with open(args.out.rsplit(".", 1)[0] + "_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
