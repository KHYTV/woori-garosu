"""산림청 원본과 같은 스키마의 합성 샘플을 만든다.

전북대 주변(덕진동)에 가상의 도로구간 5개를 두고 나무를 배치한다.
좌표·수종·흉고는 모두 무작위로 만든 값이며 실제 나무가 아니다.
품질 감사를 시험하기 위해 결측·이상치·좌표계 혼재·중복을 일부러 넣는다.
"""

import math

import numpy as np
import pandas as pd
from pyproj import Transformer

from .schema import RAW_DIR

SEED = 7
SPACING_M = 15.0
M_PER_DEG_LAT = 111_000.0

# (구간명, 시점(lat, lon), 종점(lat, lon), 양쪽 식재 여부, 수종 구성)
SEGMENTS = [
    ("샘플구간A", (35.8420, 127.1250), (35.8420, 127.1350), False, {"느티나무": 1.0}),
    ("샘플구간B", (35.8420, 127.1350), (35.8510, 127.1350), False, {"은행나무": 0.93, "모과나무": 0.07}),
    ("샘플구간C", (35.8470, 127.1270), (35.8490, 127.1330), True, {"왕벚나무": 1.0}),
    ("샘플구간D", (35.8510, 127.1250), (35.8510, 127.1350), False, {"이팝나무": 1.0}),
    ("샘플구간E", (35.8440, 127.1260), (35.8500, 127.1260), False,
     {"메타세쿼이아": 0.35, "단풍나무": 0.25, "양버즘나무": 0.2, "회화나무": 0.1, "소나무": 0.1}),
]

# 수종별 흉고직경 분포(중앙값 cm, 로그 표준편차)
DBH_DIST = {
    "느티나무": (28, 0.25), "은행나무": (30, 0.22), "왕벚나무": (24, 0.25), "이팝나무": (14, 0.30),
    "단풍나무": (13, 0.30), "메타세쿼이아": (32, 0.20), "양버즘나무": (42, 0.20),
    "회화나무": (22, 0.25), "소나무": (20, 0.25), "모과나무": (18, 0.25),
}


def _points_along(start, end, both_sides):
    lat0, lon0 = start
    lat1, lon1 = end
    m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians((lat0 + lat1) / 2))
    dx = (lon1 - lon0) * m_per_deg_lon
    dy = (lat1 - lat0) * M_PER_DEG_LAT
    length = math.hypot(dx, dy)
    n = int(length // SPACING_M) + 1
    # 도로 중심선에서 6m 떨어진 보도에 식재
    nx, ny = -dy / length * 6.0, dx / length * 6.0
    sides = [1, -1] if both_sides else [1]
    pts = []
    for side in sides:
        for i in range(n):
            t = i / max(n - 1, 1)
            x = dx * t + side * nx
            y = dy * t + side * ny
            pts.append((lat0 + y / M_PER_DEG_LAT, lon0 + x / m_per_deg_lon))
    return pts


def build_sample() -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    rows = []
    for name, start, end, both, mix in SEGMENTS:
        species = list(mix)
        weights = np.array(list(mix.values()))
        for lat, lon in _points_along(start, end, both):
            sp = rng.choice(species, p=weights / weights.sum())
            med, sd = DBH_DIST[sp]
            dbh = max(3, round(float(rng.lognormal(math.log(med), sd))))
            rows.append({
                "시군구명": "전주시 덕진구",
                "도로구간명": name,
                "구간시점명": f"{name} 시점",
                "구간종점명": f"{name} 종점",
                "수종명": sp,
                "수목흉고직경": str(dbh),
                "가로내녹지유형명": rng.choice(["보도", "보도", "중앙분리대"]),
                "도로변녹지유형명": "",
                "기후대구분명": "온대중부",
                "입지명": "도심",
                "지역X좌표": f"{lon:.7f}",
                "지역Y좌표": f"{lat:.7f}",
                "좌표계코드": "EPSG:4326",
            })
    df = pd.DataFrame(rows)
    df["시군구별가로수번호"] = [f"JJ-{i + 1:05d}" for i in range(len(df))]
    return _inject_issues(df, rng)


def _inject_issues(df: pd.DataFrame, rng) -> pd.DataFrame:
    idx = rng.permutation(len(df))
    take = iter(idx)

    def pick(n):
        return [next(take) for _ in range(n)]

    for i in pick(6):  # 좌표 결측
        df.loc[i, ["지역X좌표", "지역Y좌표"]] = ""
    for i in pick(3):  # 흉고 0
        df.loc[i, "수목흉고직경"] = "0"
    for i in pick(3):  # 흉고 이상치
        df.loc[i, "수목흉고직경"] = "999"
    for i in pick(3):  # 흉고 결측
        df.loc[i, "수목흉고직경"] = ""
    for i in pick(1):  # 흉고 문자 입력
        df.loc[i, "수목흉고직경"] = "측정불가"
    for i in pick(2):  # 수종 미상
        df.loc[i, "수종명"] = "미상"
    for i in pick(3):  # 수종명 공백·별칭 표기
        sp = df.loc[i, "수종명"]
        df.loc[i, "수종명"] = {"메타세쿼이아": "메타세콰이어", "양버즘나무": "플라타너스"}.get(sp, f" {sp} ")
    to_tm = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)
    for i in pick(20):  # 좌표계 혼재: 일부 행을 중부원점 TM으로
        if df.loc[i, "지역X좌표"]:
            x, y = to_tm.transform(float(df.loc[i, "지역X좌표"]), float(df.loc[i, "지역Y좌표"]))
            df.loc[i, ["지역X좌표", "지역Y좌표", "좌표계코드"]] = [f"{x:.2f}", f"{y:.2f}", "5186"]
    for i in pick(2):  # X·Y 뒤바뀜
        if df.loc[i, "좌표계코드"] == "EPSG:4326" and df.loc[i, "지역X좌표"]:
            x, y = df.loc[i, "지역X좌표"], df.loc[i, "지역Y좌표"]
            df.loc[i, ["지역X좌표", "지역Y좌표"]] = [y, x]
    for i in pick(1):  # 알 수 없는 좌표계코드
        df.loc[i, "좌표계코드"] = "UNKNOWN"
    dups = df.iloc[pick(2)].copy()  # 중복 행
    dups["시군구별가로수번호"] = [f"JJ-D{i + 1:04d}" for i in range(len(dups))]
    return pd.concat([df, dups], ignore_index=True)


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    df = build_sample()
    path = RAW_DIR / "sample_jeonju_synthetic.csv"
    df.to_csv(path, index=False, encoding="utf-8-sig")
    print(f"합성 샘플 {len(df)}행 → {path}")


if __name__ == "__main__":
    main()
