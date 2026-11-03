"""가로수 공백 진단: 행정동별·전북대 캠퍼스·주요 생활권 반경 안 그루 수.

  python -m pipeline.coverage                         # docs/data/trees.json 기준
  python -m pipeline.coverage --trees 다른/trees.json --out data/out/coverage.json

웹 데이터(trees.json, 열 지향 배열)를 그대로 읽어 출처(src)별로 센다. 원본 자체가 비어 있는 구역을 찾는 진단이며,
결과는 시민 직접 등록 기능의 우선 지역을 고르는 근거로 쓴다.
"""

import argparse
import json
import math

import numpy as np
import shapely
from shapely.geometry import shape

from .schema import CONFIG_DIR, RAW_DIR, ROOT

HJD_FILE = CONFIG_DIR / "boundaries" / "jeonju_hangjeongdong.geojson"
# 전주시가 공공데이터포털에 올린 노선별 가로수 그루 수(완산구 공원녹지과, 2026-03-17). 좌표가 없어 나무로는 못 넣고 대조에만 쓴다
CITY_FILE = RAW_DIR / "jeonju_city_street_trees_wansan_20260317.csv"
CAMPUS_FILE = CONFIG_DIR / "boundaries" / "jbnu_campus_osm.geojson"
RADIUS_M = 300
# 주요 생활권 기준점(경도, 위도). OpenStreetMap Nominatim(2026-11) 검색값, 전북대는 캠퍼스 경계의 무게중심
HUBS = {
    "전북대학교(캠퍼스 중심)": (127.13368, 35.84715),
    "한옥마을(경기전 앞)": (127.1500, 35.8153),
    "전주역": (127.16236, 35.85005),
    "서부신시가지(도청)": (127.10796, 35.82008),
    "전주시청": (127.14811, 35.82415),
    "객사(중앙동)": (127.14545, 35.81810),
    "덕진공원": (127.12304, 35.84861),
    "에코시티(세병공원)": (127.1195, 35.8735),
    "혁신도시(국민연금공단)": (127.07111, 35.83722),
}
M_PER_DEG_LAT = 111320.0


def _load_trees(path):
    t = json.loads(open(path, encoding="utf-8").read())
    lon = np.array([np.nan if v is None else v for v in t["lon"]], float)
    lat = np.array([np.nan if v is None else v for v in t["lat"]], float)
    srcs = t.get("srcs") or ["forest"]
    src = np.array([srcs[i] for i in t["src"]]) if "src" in t else np.array(["forest"] * len(lon))
    return lon, lat, src


def _by_src(mask, src):
    out = {"total": int(mask.sum())}
    for s in sorted(set(src)):
        out[s] = int((mask & (src == s)).sum())
    return out


def diagnose(trees_path) -> dict:
    lon, lat, src = _load_trees(trees_path)
    ok = ~np.isnan(lon)
    result = {"trees": _by_src(ok, src), "radius_m": RADIUS_M}

    # 행정동: 좌표가 경계 안에 드는 나무 수와 면적당 밀도(UTM-K 근사 대신 위도 보정 어림)
    gj = json.loads(HJD_FILE.read_text(encoding="utf-8"))
    rows = []
    in_any = np.zeros(len(lon), bool)
    for f in gj["features"]:
        geom = shape(f["geometry"])
        inside = np.zeros(len(lon), bool)
        inside[ok] = shapely.contains_xy(geom, lon[ok], lat[ok])
        in_any |= inside
        k = math.cos(math.radians(geom.centroid.y))
        km2 = geom.area * (M_PER_DEG_LAT ** 2) * k / 1e6
        rows.append({"dong": f["properties"]["adm_nm"].split()[-1], "km2": round(km2, 2),
                     **_by_src(inside, src), "per_km2": round(int(inside.sum()) / km2, 1)})
    result["dongs"] = sorted(rows, key=lambda r: r["total"])
    result["outside_dongs"] = _by_src(ok & ~in_any, src)

    # 전북대 캠퍼스(OSM 경계). 둘레 도로에 심긴 나무와 구분하려고 경계에서 30m 넘게 안쪽인 나무도 센다
    campus = shapely.union_all([shape(f["geometry"]) for f in json.loads(CAMPUS_FILE.read_text(encoding="utf-8"))["features"]])
    k = math.cos(math.radians(campus.centroid.y))
    inside = np.zeros(len(lon), bool)
    inside[ok] = shapely.contains_xy(campus, lon[ok], lat[ok])
    inner = campus.buffer(-30 / M_PER_DEG_LAT / k)
    deep = np.zeros(len(lon), bool)
    deep[ok] = shapely.contains_xy(inner, lon[ok], lat[ok])
    result["campus"] = {"name": "전북대학교 전주캠퍼스", "ha": round(campus.area * M_PER_DEG_LAT ** 2 * k / 1e4, 1),
                        "inside": _by_src(inside, src), "inside_30m_from_edge": _by_src(deep, src)}

    # 주요 생활권 반경 안
    hubs = []
    for name, (x, y) in HUBS.items():
        kx = math.cos(math.radians(y)) * M_PER_DEG_LAT
        d = np.hypot((lon - x) * kx, (lat - y) * M_PER_DEG_LAT)
        hubs.append({"hub": name, "lon": x, "lat": y, **_by_src(ok & (d <= RADIUS_M), src)})
    result["hubs"] = hubs
    return result


def city_road_gap(trees_path, city_csv=CITY_FILE, top=20) -> dict | None:
    """전주시 노선별 그루 수(완산구)와 지도 나무 수를 도로 이름으로 맞대어 빠진 노선을 찾는다."""
    import pandas as pd
    if not city_csv.exists():
        return None
    city = pd.read_csv(city_csv, dtype=str, keep_default_na=False)
    city["n"] = pd.to_numeric(city["가로수 그루수"].str.replace(",", ""), errors="coerce").fillna(0).astype(int)
    city_by_road = city.groupby(city["노선명"].str.replace(" ", ""))["n"].sum()
    t = json.loads(open(trees_path, encoding="utf-8").read())
    gj = json.loads(HJD_FILE.read_text(encoding="utf-8"))
    wansan = shapely.union_all([shape(f["geometry"]) for f in gj["features"] if "완산구" in f["properties"]["sggnm"]])
    lon = np.array([np.nan if v is None else v for v in t["lon"]], float)
    lat = np.array([np.nan if v is None else v for v in t["lat"]], float)
    ok = ~np.isnan(lon)
    inw = np.zeros(len(lon), bool)
    inw[ok] = shapely.contains_xy(wansan, lon[ok], lat[ok])
    roads = pd.Series([t["roads"][r].replace(" ", "") if r is not None else None for r in t["rd"]])
    ours = roads[inw].value_counts()
    cmp = pd.DataFrame({"city": city_by_road, "ours": ours.reindex(city_by_road.index).fillna(0).astype(int)})
    cmp["gap"] = cmp["city"] - cmp["ours"]
    missing = cmp[cmp["ours"] == 0]
    return {
        "source": city_csv.name, "city_total": int(city["n"].sum()), "city_roads": int(len(cmp)),
        "ours_in_wansan": int(inw.sum()),
        "roads_missing": int(len(missing)), "trees_on_missing_roads": int(missing["city"].sum()),
        "trees_short_on_listed_roads": int(cmp["gap"].clip(lower=0).sum()),
        "top_gaps": [{"road": k, "city": int(v.city), "ours": int(v.ours)}
                     for k, v in cmp.sort_values("gap", ascending=False).head(top).iterrows()],
    }


def to_markdown(r: dict) -> str:
    srcs = [k for k in r["trees"] if k != "total"]
    head = "| 구역 | 전체 | " + " | ".join(srcs) + " |"
    sep = "|---|---:|" + "---:|" * len(srcs)
    lines = [f"나무 {r['trees']['total']:,}그루", "", "### 주요 생활권 반경 %dm" % r["radius_m"], "", head, sep]
    lines += [f"| {h['hub']} | {h['total']:,} | " + " | ".join(f"{h.get(s, 0):,}" for s in srcs) + " |" for h in r["hubs"]]
    c = r["campus"]
    lines += ["", f"### {c['name']} ({c['ha']} ha)", "", head, sep,
              f"| 캠퍼스 경계 안 | {c['inside']['total']:,} | " + " | ".join(f"{c['inside'].get(s, 0):,}" for s in srcs) + " |",
              f"| 경계에서 30m 넘게 안쪽 | {c['inside_30m_from_edge']['total']:,} | "
              + " | ".join(f"{c['inside_30m_from_edge'].get(s, 0):,}" for s in srcs) + " |"]
    lines += ["", "### 행정동(적은 순)", "", "| 행정동 | 면적 km² | 전체 | 1km²당 | " + " | ".join(srcs) + " |",
              "|---|---:|---:|---:|" + "---:|" * len(srcs)]
    lines += [f"| {d['dong']} | {d['km2']} | {d['total']:,} | {d['per_km2']:,} | " + " | ".join(f"{d.get(s, 0):,}" for s in srcs) + " |"
              for d in r["dongs"]]
    lines += [f"| (행정동 경계 밖) | | {r['outside_dongs']['total']:,} | | " + " | ".join(f"{r['outside_dongs'].get(s, 0):,}" for s in srcs) + " |"]
    g = r.get("city_roads")
    if g:
        lines += ["", f"### 전주시 노선별 그루 수(완산구) 대조: 시 {g['city_total']:,}그루 · 지도 완산구 {g['ours_in_wansan']:,}그루", "",
                  f"지도에 한 그루도 없는 노선 {g['roads_missing']}개({g['trees_on_missing_roads']:,}그루), "
                  f"노선별로 시 자료보다 모자란 그루 합 {g['trees_short_on_listed_roads']:,}", "",
                  "| 노선 | 시 자료 | 지도 |", "|---|---:|---:|"]
        lines += [f"| {x['road']} | {x['city']:,} | {x['ours']:,} |" for x in g["top_gaps"]]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trees", default=str(ROOT / "docs" / "data" / "trees.json"))
    ap.add_argument("--out", help="결과 JSON 경로(선택)")
    ap.add_argument("--markdown", action="store_true", help="표(마크다운)로 출력")
    args = ap.parse_args()
    r = diagnose(args.trees)
    r["city_roads"] = city_road_gap(args.trees)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(r, f, ensure_ascii=False, indent=1)
    print(to_markdown(r) if args.markdown else json.dumps(r, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
