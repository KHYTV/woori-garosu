"""i-Tree Eco v6 가져오기용 CSV.

Eco v6의 가져오기 마법사에서 열을 매핑해 쓴다(열 이름은 마법사에서 지정하므로 고정 양식이 아님).
수고·수관폭·수관 광노출·고사율은 현재 원본에 없어 빈칸으로 두고, 현장 확인 때 채운다.
"""

import pandas as pd

COLUMNS = {
    "tree_id": "TreeID",
    "scientific_name": "Species",
    "species_ko": "CommonName_ko",
    "dbh_cm": "DBH_cm",
    "lat": "Latitude",
    "lon": "Longitude",
    "road_section": "Street",
    "grade": "DataQualityGrade",
}
EMPTY_FIELD_COLUMNS = ["TotalHeight_m", "CrownWidth_m", "CrownLightExposure_0to5", "PercentDieback"]


def to_itree(df: pd.DataFrame) -> pd.DataFrame:
    out = df.loc[df["carbon_eligible"], list(COLUMNS)].rename(columns=COLUMNS)
    for col in EMPTY_FIELD_COLUMNS:
        out[col] = ""
    return out
