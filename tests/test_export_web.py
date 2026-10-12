import pandas as pd

from pipeline import export_web


def test_dong_pattern_picks_dong_from_section_names():
    pat = export_web.DONG_PATTERN
    assert pat.search("호성동1가 743-158 잡").group(1) == "호성동1가"
    assert pat.search("산14-5임") is None
    assert pat.search("진북동 1-2").group(1) == "진북동"
    assert pat.search("중화산1가 160-30") is None  # '동' 없이 '가'만 붙은 예외는 찾지 않는다


def test_places_groups_dong_and_road_with_centroids():
    df = pd.DataFrame({
        "dong": ["효자5동", "효자5동", None, "진북동"],
        "jibun_dong": ["효자동3가", "효자동3가", "효자동3가", "진북동"],
        "road_section": ["백제대로", "백제대로", "백제대로", "기린대로"],
        "lon": [127.1, 127.2, 127.3, 127.0], "lat": [35.8, 35.9, 35.7, 35.85],
    })
    out = export_web.places(df)
    by = {(p["kind"], p["name"]): p for p in out}
    assert by[("dong", "효자5동")]["count"] == 2
    assert abs(by[("dong", "효자5동")]["lon"] - 127.15) < 1e-6
    assert by[("jibun", "효자동3가")]["count"] == 3
    assert by[("road", "백제대로")]["count"] == 3
    assert ("dong", "None") not in by
    assert [p["kind"] for p in out] == sorted(p["kind"] for p in out)  # 종류별로 묶이고, 그 안에서 나무 수 내림차순


def test_dong_comes_from_hangjeongdong_polygons():
    polygons = export_web.load_hangjeongdong()
    assert len(polygons) == 35  # 전주시 행정동
    # 83488(백제대로·기린대로 교차 부근)은 원본 구간 글자로는 '진북동'이지만 좌표로는 금암동이다
    assert export_web.assign_dong([127.129814, 127.104362, 126.0], [35.84, 35.819183, 35.0], polygons) == ["금암동", "효자5동", None]


def test_dong_by_tree_reads_raw_extract_when_present():
    found = export_web.dong_by_tree("jeonju_extract")
    if not found:  # 원자료가 없는 환경(CI)에서는 건너뛴다
        return
    assert len(found) > 30000
    assert all(v.endswith(("동", "가", "리")) for v in found.values())
