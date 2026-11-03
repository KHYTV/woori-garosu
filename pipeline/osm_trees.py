"""OpenStreetMap에 개별 점(natural=tree)으로 그려진 전주 나무를 보충 자료로 받는다.

  python -m pipeline.osm_trees                              # Overpass에서 받아 data/raw/jeonju_osm_trees.csv
  python -m pipeline.osm_trees --from-json overpass.json    # 이미 받은 Overpass 응답에서 만든다

OSM 나무는 수종이 거의 없고(2026-11 기준 345그루 중 2그루) 흉고는 하나도 없다. 그래서
- 수종: species:ko·name:ko·name·species·taxon·genus 태그를 species.csv 별칭·학명에 맞춰 보고, 없으면 '기타'(수종 미상)
- 흉고: 없음 → 품질 등급 C(탄소 계산 제외, 지도에는 표시)
- 중복: 산림청 나무와 5m 안이면서 수종이 같거나 OSM 수종이 미상이면 같은 나무로 보고 뺀다(수종을 모르면 보수적으로 뺌)
- 줄로 그린 가로수(natural=tree_row)는 그루 수·위치가 없어 쓰지 않는다.
라이선스: ODbL 1.0, © OpenStreetMap contributors. 이 나무가 들어간 trees.json의 OSM 행은 ODbL을 따른다.
"""

import argparse
import json
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

from . import etl
from .schema import RAW_DIR

OSM_FILE = RAW_DIR / "jeonju_osm_trees.csv"
JEONJU_AREA = 3600000000 + 7619919  # 전주시 relation 7619919의 Overpass area id
OVERPASS = "https://overpass-api.de/api/interpreter"
QUERY = f'[out:json][timeout:180];area({JEONJU_AREA})->.a;node["natural"="tree"](area.a);out body;'
DUP_RADIUS_M = 5.0
UNKNOWN = "기타"
TAG_KEYS_KO = ("species:ko", "name:botanical:ko", "name:ko", "name")
TAG_KEYS_SCI = ("species", "taxon")


def fetch(user_agent="woori-garosu-research/1.0") -> dict:
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({"data": QUERY}).encode(),
                                 headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read().decode("utf-8"))


def species_of(tags: dict, table: pd.DataFrame) -> str:
    """OSM 태그에서 species.csv의 수종 이름을 찾는다. 못 찾으면 '기타'."""
    names, _ = etl.normalize_species(pd.Series([tags.get(k, "") for k in TAG_KEYS_KO]), table)
    for value, name in zip((tags.get(k, "") for k in TAG_KEYS_KO), names):
        if value and name != UNKNOWN:
            return name
    sci = {r.scientific_name.lower(): r.species_ko for r in table.itertuples() if r.scientific_name}
    for k in TAG_KEYS_SCI:
        v = tags.get(k, "").strip().lower()
        if v in sci:
            return sci[v]
    genus = tags.get("genus", "").strip().lower()
    if genus:
        hits = {s for n, s in sci.items() if n.split()[0] == genus}
        if len(hits) == 1:
            return hits.pop()
    return UNKNOWN


def to_table(overpass: dict) -> pd.DataFrame:
    table = etl.load_species_table()
    rows = []
    for e in overpass.get("elements", []):
        tags = e.get("tags") or {}
        if e.get("type") != "node" or tags.get("natural") != "tree":
            continue
        rows.append({"osm_id": e["id"], "lon": round(e["lon"], 7), "lat": round(e["lat"], 7),
                     "species_ko": species_of(tags, table),
                     "tags": ";".join(f"{k}={tags[k]}" for k in sorted(tags) if k != "natural")})
    return pd.DataFrame(rows, columns=["osm_id", "lon", "lat", "species_ko", "tags"]).sort_values("osm_id")


def load(path=OSM_FILE) -> pd.DataFrame:
    """웹 내보내기용 OSM 나무. 파일이 없으면 빈 표."""
    cols = ["tree_id", "species_ko", "lon", "lat", "dbh_cm", "road_section", "grade", "issues", "src"]
    if not path.exists():
        return pd.DataFrame(columns=cols)
    df = pd.read_csv(path, dtype={"osm_id": str}, keep_default_na=False)
    return pd.DataFrame({"tree_id": "osm-" + df["osm_id"], "species_ko": df["species_ko"].replace("", UNKNOWN),
                         "lon": df["lon"].astype(float), "lat": df["lat"].astype(float), "dbh_cm": np.nan,
                         "road_section": None, "grade": "C", "issues": "dbh_missing", "src": "osm"})[cols]


def near_duplicates(extra: pd.DataFrame, base: pd.DataFrame, radius_m=DUP_RADIUS_M) -> np.ndarray:
    """extra의 각 나무가 base의 나무와 radius_m 안에서 겹치는지. 수종이 같거나 extra 수종이 미상이면 겹침으로 본다."""
    if extra.empty or base.empty:
        return np.zeros(len(extra), dtype=bool)
    k = np.cos(np.radians(float(base["lat"].mean()))) * 111320
    bx, by = base["lon"].to_numpy(float) * k, base["lat"].to_numpy(float) * 111320
    bsp = base["species_ko"].to_numpy()
    out = np.zeros(len(extra), dtype=bool)
    for j, (x, y, sp) in enumerate(zip(extra["lon"].to_numpy(float) * k, extra["lat"].to_numpy(float) * 111320,
                                       extra["species_ko"])):
        close = (np.abs(bx - x) <= radius_m) & (np.abs(by - y) <= radius_m)
        if not close.any():
            continue
        idx = np.flatnonzero(close)
        within = np.hypot(bx[idx] - x, by[idx] - y) <= radius_m
        out[j] = bool(within.any() and (sp == UNKNOWN or (bsp[idx][within] == sp).any()))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-json", help="이미 받은 Overpass JSON 응답")
    ap.add_argument("--out", default=str(OSM_FILE))
    args = ap.parse_args()
    data = json.loads(open(args.from_json, encoding="utf-8").read()) if args.from_json else fetch()
    df = to_table(data)
    df.to_csv(args.out, index=False, encoding="utf-8")
    stamp = data.get("osm3s", {}).get("timestamp_osm_base")
    print(json.dumps({"trees": len(df), "osm_base": stamp, "species_known": int((df["species_ko"] != UNKNOWN).sum()),
                      "out": args.out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
