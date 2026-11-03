"""전주 지명 사전(gazetteer)에 쓸 OpenStreetMap 자료를 Overpass API로 받는다(ODbL).

  python -m pipeline.osm_fetch            # 없는 것만 받기
  python -m pipeline.osm_fetch --refresh  # 다시 받기

받은 응답은 data/raw/osm/*.json에 그대로 둔다(저장소에는 올리지 않는다). 공개 Overpass 서버는 자주 붐비므로
여러 서버를 돌아가며 간격을 늘려 다시 묻는다.
"""

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from .schema import RAW_DIR

OSM_DIR = RAW_DIR / "osm"
JEONJU_AREA = 3607619919  # relation 7619919(전주시) + 3600000000
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
UA = "woori-garosu-gazetteer/1.0 (JBNU data communication lab; build-time, cached)"

HEAD = f"[out:json][timeout:240];area({JEONJU_AREA})->.j;"
QUERIES = {
    # 구·행정동·법정동 경계(폴리곤 좌표 포함)
    "admin": HEAD + 'rel(area.j)[boundary=administrative][admin_level~"^(7|8|9|10|11)$"];out geom;',
    # 동네 이름 점(place=*)
    "place": HEAD + "node(area.j)[place][name];out tags;",
    # 이름 있는 장소: 대학·학교·병원·역·터미널·관광지·공원·관공서·쇼핑·아파트 단지
    "poi": HEAD + """(
  nwr(area.j)[name][amenity~"^(university|college|school|hospital|townhall|library|marketplace|bus_station|police|fire_station|post_office|courthouse|community_centre|arts_centre|theatre|cinema|public_building|exhibition_centre|conference_centre)$"];
  nwr(area.j)[name][railway~"^(station|halt)$"];
  nwr(area.j)[name][public_transport=station];
  nwr(area.j)[name][tourism~"^(attraction|museum|gallery|viewpoint|theme_park|zoo|hotel)$"];
  nwr(area.j)[name][historic];
  nwr(area.j)[name][leisure~"^(park|stadium|sports_centre|garden|nature_reserve)$"];
  nwr(area.j)[name][shop~"^(mall|department_store|supermarket)$"];
  nwr(area.j)[name][office=government];
  nwr(area.j)[name][landuse=residential];
  nwr(area.j)[name][building=apartments];
  nwr(area.j)[name][residential];
);out center tags;""",
}


def overpass(query: str, tries: int = 12) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode()
    wait = 10
    last = None
    for attempt in range(tries):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                body = r.read()
            out = json.loads(body)
            if "elements" in out:
                return out
            last = f"{url}: 응답에 elements 없음"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as e:
            last = f"{url}: {e}"
        print(f"  다시 시도 {attempt + 1}/{tries} ({last}) {wait}초 뒤", flush=True)
        time.sleep(wait)
        wait = min(wait * 2, 120)
    raise RuntimeError(f"Overpass 실패: {last}")


# ---------- Overpass가 붐빌 때: Nominatim 분류 검색([key=value])으로 같은 자료를 모은다 ----------
# Nominatim 이용 정책을 지켜 1.1초에 1번, 결과는 캐시. 한 번에 50개씩, 이미 받은 place_id를 빼며 다음 쪽을 받는다.
NOMINATIM = "https://nominatim.openstreetmap.org/search"
BBOX = (126.95, 35.70, 127.35, 35.95)
NOMINATIM_TAGS = {
    "place": ["place=quarter", "place=neighbourhood", "place=suburb", "place=village", "place=hamlet"],
    "poi": [
        "amenity=university", "amenity=college", "amenity=school", "amenity=hospital", "amenity=townhall", "amenity=library",
        "amenity=marketplace", "amenity=bus_station", "amenity=police", "amenity=fire_station", "amenity=post_office",
        "amenity=courthouse", "amenity=community_centre", "amenity=arts_centre", "amenity=theatre", "amenity=cinema",
        "amenity=exhibition_centre", "amenity=conference_centre",
        "railway=station", "railway=halt",
        "tourism=attraction", "tourism=museum", "tourism=gallery", "tourism=viewpoint", "tourism=theme_park", "tourism=zoo",
        "historic=monument", "historic=memorial", "historic=building", "historic=city_gate", "historic=castle",
        "historic=archaeological_site", "historic=heritage", "historic=tomb", "historic=church",
        "leisure=park", "leisure=garden", "leisure=stadium", "leisure=sports_centre", "leisure=nature_reserve",
        "shop=mall", "shop=department_store", "shop=supermarket", "office=government",
        "landuse=residential",
    ],
}


MAX_EXCLUDE = 250  # 주소 길이 제한(414) 전에 칸을 넷으로 나눠 다시 묻는다


def _nominatim_page(tag, bbox, exclude):
    w, s, e, n = bbox
    params = {"format": "jsonv2", "limit": 50, "countrycodes": "kr", "bounded": 1, "viewbox": f"{w},{n},{e},{s}",
              "q": f"[{tag}]", "namedetails": 1, "accept-language": "ko"}
    if exclude:
        params["exclude_place_ids"] = ",".join(map(str, exclude))
    url = f"{NOMINATIM}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        time.sleep(1.1)  # Nominatim 이용 정책: 1초에 1번 이하
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as err:
            print(f"  {tag} 다시 시도 {attempt + 1} ({err})", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Nominatim 실패: {tag}")


def _nominatim_tag(tag: str, bbox=BBOX, depth: int = 0) -> dict:
    """bbox 안의 [tag] 객체 전부. place_id → 행. 너무 많으면 칸을 넷으로 나눈다."""
    seen = {}
    while True:
        rows = _nominatim_page(tag, bbox, list(seen))
        rows = [x for x in rows if x["place_id"] not in seen]
        for x in rows:
            seen[x["place_id"]] = x
        if len(rows) < 50:
            return seen
        if len(seen) >= MAX_EXCLUDE and depth < 4:
            w, s, e, n = bbox
            mx, my = (w + e) / 2, (s + n) / 2
            for sub in ((w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)):
                seen.update(_nominatim_tag(tag, sub, depth + 1))
            return seen


def _to_elements(tag: str, rows: dict) -> list[dict]:
    key, value = tag.split("=")
    out = []
    for x in rows.values():
        if x.get("category") != key or x.get("type") != value:
            continue
        nd = x.get("namedetails") or {}
        name = nd.get("name:ko") or nd.get("name") or x.get("name")
        if not name:
            continue
        el = {"type": x["osm_type"], "id": x["osm_id"], "tags": {key: value, "name": name}}
        if x["osm_type"] == "node":
            el.update(lat=float(x["lat"]), lon=float(x["lon"]))
        else:
            el["center"] = {"lat": float(x["lat"]), "lon": float(x["lon"])}
        out.append(el)
    return out


def fetch_nominatim(name: str) -> dict:
    cache = OSM_DIR / "nominatim"
    cache.mkdir(parents=True, exist_ok=True)
    elements = []
    for tag in NOMINATIM_TAGS[name]:
        path = cache / f"{tag.replace('=', '_')}.json"
        if path.exists():
            got = json.loads(path.read_text(encoding="utf-8"))
        else:
            got = _to_elements(tag, _nominatim_tag(tag))
            path.write_text(json.dumps(got, ensure_ascii=False), encoding="utf-8")
        print(f"  {tag}: {len(got)}", flush=True)
        elements.extend(got)
    return {"elements": elements, "_source": "nominatim"}


def fetch(refresh: bool = False, source: str = "auto") -> dict:
    OSM_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, q in QUERIES.items():
        path = OSM_DIR / f"{name}.json"
        if path.exists() and not refresh:
            out[name] = path
            continue
        print(f"{name} 받는 중…", flush=True)
        res = None
        if source in ("auto", "overpass"):
            try:
                res = overpass(q, tries=12 if source == "overpass" else 3)
                res["_query"] = q
                res["_source"] = "overpass"
            except RuntimeError as err:
                if source == "overpass" or name not in NOMINATIM_TAGS:
                    raise
                print(f"  Overpass 실패, Nominatim 분류 검색으로 대신 받는다 ({err})", flush=True)
        if res is None:
            res = fetch_nominatim(name)
        res["_fetched"] = time.strftime("%Y-%m-%d")
        path.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
        print(f"  {name}: {len(res['elements'])}개", flush=True)
        out[name] = path
    return out


def load(name: str) -> dict:
    return json.loads((OSM_DIR / f"{name}.json").read_text(encoding="utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--source", choices=["auto", "overpass", "nominatim"], default="auto",
                    help="auto: Overpass를 몇 번 묻고 안 되면 Nominatim 분류 검색")
    ap.add_argument("--only", nargs="*", help="받을 묶음(admin place poi)")
    args = ap.parse_args()
    if args.only:
        for k in list(QUERIES):
            if k not in args.only:
                QUERIES.pop(k)
    fetch(args.refresh, args.source)


if __name__ == "__main__":
    main()
