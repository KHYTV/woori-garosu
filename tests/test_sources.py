"""보충 자료(OSM)·경계 여유 추출·공백 진단 검사."""

import json

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import box

from pipeline import coverage, etl, extract_region, osm_trees
from pipeline.schema import ROOT


def _raw(rows):
    cols = ["시군구명", "도로구간명", "구간시점명", "구간종점명", "수종명", "수목흉고직경", "가로내녹지유형명", "도로변녹지유형명",
            "기후대구분명", "입지명", "지역X좌표", "지역Y좌표", "좌표계코드", "시군구별가로수번호"]
    return pd.DataFrame([dict(zip(cols, r)) for r in rows], dtype=str)


def test_extract_accepts_blank_sgg_rows_just_outside_boundary():
    boundary = box(127.0, 35.8, 127.1, 35.9)
    shapely.prepare(boundary)
    row = lambda sgg, lon, no: (sgg, "길", "", "", "벚나무", "20", "기타", "기타", "기타", "기타", str(lon), "35.85", "EPSG:4326", no)
    df = _raw([row("", 127.05, "1"),            # 경계 안
               row("", 127.1015, "2"),          # 경계 밖 약 135m
               row("", 127.11, "3"),            # 경계 밖 약 900m
               row("완주군", 127.1015, "4")])   # 시군구명이 있는 이웃 시군
    sub, summary = extract_region.extract(df, boundary, "전주", buffer_m=300)
    assert sub["시군구별가로수번호"].tolist() == ["1", "2"]
    assert summary["near_boundary_blank_sgg"] == 1
    sub0, _ = extract_region.extract(df, boundary, "전주", buffer_m=0)
    assert sub0["시군구별가로수번호"].tolist() == ["1"]


def test_osm_species_from_tags():
    table = etl.load_species_table()
    assert osm_trees.species_of({"name:ko": "은행나무"}, table) == "은행나무"
    assert osm_trees.species_of({"species": "Ginkgo biloba"}, table) == "은행나무"
    assert osm_trees.species_of({"genus": "Ginkgo"}, table) == "은행나무"
    assert osm_trees.species_of({"name": "곰솔나무"}, table) == "소나무"
    assert osm_trees.species_of({"leaf_type": "broadleaved"}, table) == "기타"


def test_osm_duplicates_within_5m_same_or_unknown_species():
    base = pd.DataFrame({"lon": [127.1], "lat": [35.8], "species_ko": ["벚나무"]})
    m = 1 / 111320  # 위도 1m
    extra = pd.DataFrame({"lon": [127.1, 127.1, 127.1, 127.1], "lat": [35.8 + 3 * m, 35.8 + 3 * m, 35.8 + 8 * m, 35.8 + 3 * m],
                          "species_ko": ["벚나무", "기타", "기타", "은행나무"]})
    # 같은 수종 3m → 중복, 수종 미상 3m → 중복(보수적), 8m → 별개, 다른 수종 3m → 별개
    assert osm_trees.near_duplicates(extra, base).tolist() == [True, True, False, False]


def test_osm_loader_marks_trees_without_dbh(tmp_path):
    p = tmp_path / "osm.csv"
    p.write_text("osm_id,lon,lat,species_ko,tags\n42,127.1,35.8,기타,\n", encoding="utf-8")
    df = osm_trees.load(p)
    assert df.loc[0, "tree_id"] == "osm-42" and df.loc[0, "src"] == "osm"
    assert df.loc[0, "grade"] == "C" and np.isnan(df.loc[0, "dbh_cm"]) and df.loc[0, "road_section"] is None


def test_exported_trees_have_source_and_no_carbon_without_dbh():
    t = json.loads((ROOT / "docs" / "data" / "trees.json").read_text(encoding="utf-8"))
    n = len(t["id"])
    assert t["srcs"][0] == "forest" and len(t["src"]) == n and len(t["rd"]) == n
    for i in range(n):
        if t["dbh"][i] is None:
            assert t["seq"][1][i] is None and t["point_seq"][i] is None
        if t["srcs"][t["src"][i]] == "osm":
            assert t["rd"][i] is None and t["id"][i].startswith("osm-")
    s = json.loads((ROOT / "docs" / "data" / "summary.json").read_text(encoding="utf-8"))
    assert sum(x["count"] for x in s["sources"]) == n == s["trees_total"]


def test_coverage_counts_hubs_campus_and_dongs():
    r = coverage.diagnose(ROOT / "docs" / "data" / "trees.json")
    assert r["trees"]["total"] == sum(d["total"] for d in r["dongs"]) + r["outside_dongs"]["total"]
    assert len(r["dongs"]) == 35 and len(r["hubs"]) == len(coverage.HUBS)
    assert r["campus"]["inside"]["total"] >= r["campus"]["inside_30m_from_edge"]["total"]


def test_city_road_gap_compares_wansan_roads():
    g = coverage.city_road_gap(ROOT / "docs" / "data" / "trees.json")
    assert g is not None and g["city_roads"] == 148 and g["city_total"] == 23728
    assert g["roads_missing"] <= g["city_roads"] and g["top_gaps"][0]["city"] >= g["top_gaps"][0]["ours"]
