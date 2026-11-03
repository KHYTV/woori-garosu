"""동네 경계(docs/data/dongs.geojson): 홈 앱 '동네 전체 보기'용 단순화 폴리곤.

- 행정동 35개: config/boundaries/jeonju_hangjeongdong.geojson (vuski/admdongkor ver20260701, 통계청·행안부 경계 기반).
  나무의 동 배정(export_web.assign_dong)과 같은 원본이다.
- 법정동: 신뢰할 만한 공개 경계를 찾지 못해 기본으로는 넣지 않는다(2026-11 확인: OSM 전주 경계 안에는
  admin_level 8 행정동 12개만 있고 법정동(admin_level 10 등) 경계가 없다). 국가공간정보포털·브이월드의
  「법정구역경계(읍면동)」 같은 파일을 GeoJSON(WGS84)으로 받아 --jibun 으로 넘기면 함께 넣는다.
  이름 칸은 EMD_KOR_NM 또는 name, '호성동1가'처럼 붙여 쓴 이름이어야 한다.

단순화: 이웃 동과 틈·겹침이 생기지 않게 coverage_simplify(shapely 2.1+)를 쓰고, 없으면 동마다 simplify.
허용 오차는 약 10m(0.0001도), 좌표는 소수 5자리(약 1m)로 자른다.

    python -m pipeline.export_dongs [--jibun 법정동.geojson] [--tolerance 0.0001]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import shapely
from shapely.geometry import mapping, shape

ROOT = Path(__file__).resolve().parents[1]
HJD = ROOT / "config" / "boundaries" / "jeonju_hangjeongdong.geojson"
CITY = ROOT / "config" / "boundaries" / "jeonju_osm.geojson"
OUT = ROOT / "docs" / "data" / "dongs.geojson"



def _simplify(geoms, tol):
    if hasattr(shapely, "coverage_simplify"):
        # 꼭짓점 제거 기준이 면적(삼각형 넓이의 제곱근)이라 거리 허용치와 비슷하게 맞춘다
        return list(shapely.coverage_simplify(geoms, tol))
    return [g.simplify(tol, preserve_topology=True) for g in geoms]


def _coords(geom):
    """GeoJSON 좌표를 소수 5자리로."""
    def walk(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], 5), round(c[1], 5)]
        return [walk(x) for x in c]
    m = mapping(geom)
    return {"type": m["type"], "coordinates": walk(m["coordinates"])}


def hangjeongdong(tol):
    gj = json.loads(HJD.read_text(encoding="utf-8"))
    names, gus, geoms = [], [], []
    for f in gj["features"]:
        p = f["properties"]
        names.append(p["adm_nm"].split()[-1])
        gus.append(p.get("sggnm", "").replace("전주시", "") or None)
        geoms.append(shape(f["geometry"]))
    simple = _simplify(geoms, tol)
    return [{"type": "Feature", "properties": {"name": n, "kind": "dong", "gu": g}, "geometry": _coords(s)}
            for n, g, s in zip(names, gus, simple)]


def jibundong(path: Path, tol):
    city = shape(json.loads(CITY.read_text(encoding="utf-8"))["features"][0]["geometry"])
    gj = json.loads(path.read_text(encoding="utf-8"))
    names, gus, geoms = [], [], []
    for f in gj["features"]:
        p = f["properties"]
        name = (p.get("EMD_KOR_NM") or p.get("name") or "").replace(" ", "")
        g = shape(f["geometry"])
        if not name or g.intersection(city).area < 0.5 * g.area:
            continue
        names.append(name)
        gus.append(p.get("gu") or p.get("SIG_KOR_NM", "").replace("전주시", "") or None)
        geoms.append(g)
    simple = _simplify(geoms, tol)
    return [{"type": "Feature", "properties": {"name": n, "kind": "jibun", "gu": g}, "geometry": _coords(s)}
            for n, g, s in zip(names, gus, simple)]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--jibun", type=Path, help="법정동 경계 GeoJSON(WGS84), 없으면 행정동만")
    ap.add_argument("--tolerance", type=float, default=0.0001, help="단순화 허용치(도), 기본 0.0001 ≈ 10m")
    args = ap.parse_args(argv)
    feats = hangjeongdong(args.tolerance)
    if args.jibun:
        feats += jibundong(args.jibun, args.tolerance)
    out = {"type": "FeatureCollection",
           "source": "행정동: vuski/admdongkor ver20260701(통계청·행안부 경계 기반)" + (f", 법정동: {args.jibun.name}" if args.jibun else ""),
           "simplify_deg": args.tolerance,
           "features": feats}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {len(feats)}개, {OUT.stat().st_size / 1024:.1f}KB")


if __name__ == "__main__":
    main()
