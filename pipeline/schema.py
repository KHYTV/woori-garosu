"""산림청 「도시숲가로수관리 가로수 현황」 원본 스키마와 공통 설정."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "out"

# 원본 CSV 헤더(국문) → 내부 컬럼명
SOURCE_COLUMNS = {
    "시군구명": "sgg_name",
    "도로구간명": "road_section",
    "구간시점명": "section_start",
    "구간종점명": "section_end",
    "수종명": "species_raw",
    "수목흉고직경": "dbh_raw",
    "가로내녹지유형명": "street_green_type",
    "도로변녹지유형명": "roadside_green_type",
    "기후대구분명": "climate_zone",
    "입지명": "site_type",
    "지역X좌표": "x_raw",
    "지역Y좌표": "y_raw",
    "좌표계코드": "crs_raw",
    "시군구별가로수번호": "tree_no",
}

# 공공데이터포털 항목 영문명 → 내부 컬럼명 (헤더가 영문으로 제공될 경우 대비)
SOURCE_COLUMNS_EN = {
    "SGNG_CD": "sgg_name",
    "ROAD_SECTN_NM": "road_section",
    "SECTN_PNTM_NM": "section_start",
    "SECTN_TRMNA_NM": "section_end",
    "KOFTR_CD": "species_raw",
    "WDPT_BHGDM": "dbh_raw",
    "STSRR_GRNS_TPE_CD": "street_green_type",
    "ROSID_GRNS_TPE_CD": "roadside_green_type",
    "CLZN_TPCD": "climate_zone",
    "LOCTN_CD": "site_type",
    "ARA_XCRD": "x_raw",
    "ARA_YCRD": "y_raw",
    "CRSST_CD": "crs_raw",
    "SIGUN_DSTNT_STTRE_NO": "tree_no",
}

# 좌표계코드 표기 → EPSG. 실제 파일을 받은 뒤 등장하는 표기를 확인해 보완한다.
CRS_ALIASES = {
    "4326": "EPSG:4326", "EPSG:4326": "EPSG:4326", "WGS84": "EPSG:4326",
    "5186": "EPSG:5186", "EPSG:5186": "EPSG:5186",  # GRS80 중부원점 TM
    "5179": "EPSG:5179", "EPSG:5179": "EPSG:5179",  # UTM-K
    "5174": "EPSG:5174", "EPSG:5174": "EPSG:5174",  # Bessel 중부원점(구 좌표계)
}

# 전주시 대략 범위(경도·위도). 범위 밖 좌표는 위치 오류로 본다.
JEONJU_BBOX = {"lon_min": 126.95, "lon_max": 127.25, "lat_min": 35.70, "lat_max": 35.95}

DBH_MAX_PLAUSIBLE_CM = 200.0
# 같은 도로구간·수종에서 같은 흉고값이 이만큼 반복되면 개별 실측이 아닌 일괄 입력으로 본다
DBH_BLOCK_MIN_REPEAT = 10
LARGE_TREE_DBH_CM = 60.0
GRID_SIZE_M = 100
