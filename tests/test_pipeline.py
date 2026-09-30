import numpy as np
import pandas as pd
from pyproj import Transformer

from pipeline import carbon, etl


def _tree(species="느티나무", dbh=30.0, group="mixed_hardwood", alt="hard_maple_oak", growth="moderate",
          height="large"):
    return pd.DataFrame([{"species_ko": species, "dbh_cm": dbh, "jenkins_group": group,
                          "alt_group": alt, "growth_class": growth, "mature_height_class": height}])


def test_percentiles_ordered_and_sequestration_positive():
    params = carbon.load_params()
    out, _ = carbon.simulate(_tree(), params, n=2000)
    r = out.iloc[0]
    assert r.storage_co2_p10 < r.storage_co2_p50 < r.storage_co2_p90
    assert 0 < r.seq_co2_p10 < r.seq_co2_p50 < r.seq_co2_p90


def test_storage_increases_with_dbh():
    params = carbon.load_params()
    small, _ = carbon.simulate(_tree(dbh=15), params, n=2000, seed=1)
    large, _ = carbon.simulate(_tree(dbh=45), params, n=2000, seed=1)
    assert large.storage_co2_p50.iloc[0] > 3 * small.storage_co2_p50.iloc[0]


def test_same_seed_is_reproducible():
    params = carbon.load_params()
    a, _ = carbon.simulate(_tree(), params, n=500, seed=42)
    b, _ = carbon.simulate(_tree(), params, n=500, seed=42)
    pd.testing.assert_frame_equal(a, b)


def test_fixing_all_sources_collapses_to_point_estimate():
    params = carbon.load_params()
    out, _ = carbon.simulate(_tree(), params, n=200, fixed=frozenset(carbon.SOURCES))
    point = carbon.point_estimate(_tree(), params).iloc[0]
    assert np.isclose(out.storage_co2_p10.iloc[0], out.storage_co2_p90.iloc[0])
    assert np.isclose(out.storage_co2_p50.iloc[0], point.point_storage_co2)
    assert np.isclose(out.seq_co2_p50.iloc[0], point.point_seq_co2)


def test_group_totals_keep_systematic_uncertainty():
    """계통 오차를 공유하므로 100그루 합계의 상대 범위가 한 그루의 1/10(독립 가정)보다 넓어야 한다."""
    params = carbon.load_params()
    trees = pd.concat([_tree()] * 100, ignore_index=True).assign(area="전체")
    single, _ = carbon.simulate(_tree(), params, n=3000)
    _, acc = carbon.simulate(trees, params, n=3000, group_cols=("area",))
    total = acc["area"]["전체"][0]
    rel_total = (np.percentile(total, 90) - np.percentile(total, 10)) / np.percentile(total, 50)
    s = single.iloc[0]
    rel_single = (s.storage_co2_p90 - s.storage_co2_p10) / s.storage_co2_p50
    assert rel_total > rel_single / 10 * 1.5


def test_each_scenario_narrows_and_both_narrows_most():
    params = carbon.load_params()
    width = lambda r: r[2] - r[0]
    sc = {k: carbon.scenario(_tree(), params, k) for k in ("citizen_measured", "local_allometry", "both")}
    before = width(sc["both"]["before"])
    assert width(sc["citizen_measured"]["after"]) < before
    assert width(sc["local_allometry"]["after"]) < before
    assert width(sc["both"]["after"]) < min(width(sc["citizen_measured"]["after"]), width(sc["local_allometry"]["after"]))
    # 실측 시나리오는 범위를 좁힐 뿐 중앙값을 크게 옮기지 않아야 한다
    assert abs(sc["citizen_measured"]["after"][1] / sc["citizen_measured"]["before"][1] - 1) < 0.05


def test_block_entered_dbh_widens_range_and_citizen_measurement_narrows_it():
    params = carbon.load_params()
    measured, _ = carbon.simulate(_tree().assign(dbh_block=False), params, n=3000, seed=3)
    block, _ = carbon.simulate(_tree().assign(dbh_block=True), params, n=3000, seed=3)
    # 저장량은 흉고에만 의존하므로 흉고 오차 차이가 그대로 드러난다
    width = lambda o: o.storage_co2_p90.iloc[0] - o.storage_co2_p10.iloc[0]
    assert width(block) > width(measured) * 1.3
    sc = carbon.scenario(_tree().assign(dbh_block=True), params, "citizen_measured")
    assert (sc["after"][2] - sc["after"][0]) < (sc["before"][2] - sc["before"][0]) * 0.85


def test_block_repeat_flag():
    raw = pd.DataFrame({
        "sgg_name": [""] * 12, "road_section": ["가로"] * 12, "section_start": [""] * 12, "section_end": [""] * 12,
        "species_raw": ["은행나무"] * 12, "dbh_raw": ["30"] * 10 + ["27", "31"],
        "street_green_type": ["기타"] * 12, "roadside_green_type": ["기타"] * 12, "climate_zone": ["기타"] * 12,
        "site_type": ["기타"] * 12, "x_raw": [f"{127.10 + i * 0.0001:.4f}" for i in range(12)],
        "y_raw": ["35.84"] * 12, "crs_raw": ["EPSG:4326"] * 12, "tree_no": [str(i) for i in range(12)],
    })
    df = etl.clean(raw)
    assert df["dbh_block"].tolist() == [True] * 10 + [False, False]
    assert set(df["grade"]) == {"A"}  # 참고 기록(시군구명 공란·일괄 입력)은 등급에 반영하지 않는다


def test_size_factor_follows_itree_rule():
    decline = carbon.load_params()["growth"]["size_decline"]
    f = carbon.size_factor([50, 60.96, 76.2, 85.725, 95.25, 120], 76.2, decline)
    assert f[0] == 1.0 and f[1] == 1.0  # 최대 흉고의 80%까지는 정상 생장
    assert abs(f[4] - 0.0222) < 1e-9 and f[5] == 0.0222  # 125% 이상은 2.22%
    assert abs(f[3] - (1 - 0.9778 * (1.125 - 0.8) / 0.45)) < 1e-9  # 사이는 선형
    assert f[2] < f[1]


def test_large_trees_sequester_less_with_size_decline():
    params = carbon.load_params()
    big = _tree(species="벚나무", dbh=90.0, growth="fast", height="medium")  # 최대 흉고 76.2cm의 118%
    with_d = carbon.point_estimate(big, params).point_seq_co2.iloc[0]
    without = carbon.point_estimate(big, params, size_decline=False).point_seq_co2.iloc[0]
    assert with_d < without * 0.25
    small = _tree(species="벚나무", dbh=20.0, growth="fast", height="medium")
    assert np.isclose(carbon.point_estimate(small, params).point_seq_co2.iloc[0],
                      carbon.point_estimate(small, params, size_decline=False).point_seq_co2.iloc[0])


def test_species_normalization():
    table = etl.load_species_table()
    names, issues = etl.normalize_species(pd.Series([" 은행나무 ", "왕벚나무", "모과나무", "미상", "플라타너스"]), table)
    assert names == ["은행나무", "벚나무", "기타", "기타", "양버즘나무"]
    assert issues == ["species_alias", None, "species_unmapped", "species_missing", None]


def test_dbh_parsing_flags():
    values, issues = etl.parse_dbh(pd.Series(["25", "", "0", "999", "측정불가"]))
    assert values[0] == 25.0 and all(np.isnan(v) for v in values[1:])
    assert issues == [None, "dbh_missing", "dbh_nonpositive", "dbh_outlier", "dbh_non_numeric"]


def test_coordinates_tm_conversion_and_swap_detection():
    lon, lat = 127.1294, 35.8466
    x, y = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True).transform(lon, lat)
    df = pd.DataFrame({"x_raw": [f"{x:.2f}", f"{lat}", ""], "y_raw": [f"{y:.2f}", f"{lon}", ""],
                       "crs_raw": ["5186", "EPSG:4326", "EPSG:4326"]})
    lons, lats, issues = etl.transform_coords(df)
    assert abs(lons[0] - lon) < 1e-6 and abs(lats[0] - lat) < 1e-6
    assert issues[0] == ["crs_converted"]
    assert issues[1] == ["xy_swapped"] and np.isnan(lons[1])
    assert issues[2] == ["coord_missing"]
