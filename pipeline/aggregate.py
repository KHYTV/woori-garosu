"""격자 배정. 서울 트리맵의 '격자 집계' 단계를 정적 파일로 만들기 위해 쓴다."""

import numpy as np
import pandas as pd
from pyproj import Transformer

from .schema import GRID_SIZE_M

_TO_M = Transformer.from_crs("EPSG:4326", "EPSG:5179", always_xy=True)
_TO_DEG = Transformer.from_crs("EPSG:5179", "EPSG:4326", always_xy=True)


def assign_grid(df: pd.DataFrame, size_m: int = GRID_SIZE_M) -> tuple[pd.Series, dict]:
    """UTM-K 기준 size_m 격자 ID와 격자 중심 좌표(경도, 위도)를 돌려준다."""
    x, y = _TO_M.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
    cx, cy = np.floor(x / size_m).astype(int), np.floor(y / size_m).astype(int)
    ids = pd.Series([f"{a}_{b}" for a, b in zip(cx, cy)], index=df.index)
    centers = {}
    for gid, a, b in set(zip(ids, cx, cy)):
        lon, lat = _TO_DEG.transform((a + 0.5) * size_m, (b + 0.5) * size_m)
        centers[gid] = [round(lon, 6), round(lat, 6)]
    return ids, centers
