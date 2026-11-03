"""전주 지명 사전(docs/data/gazetteer.json)을 만든다. 홈 앱의 검색·자동완성이 이것만으로 동작한다.

  python -m pipeline.osm_fetch     # OpenStreetMap 자료 받기(처음 한 번, data/raw/osm/)
  python -m pipeline.gazetteer     # docs/data/gazetteer.json 쓰기 + 검수 요약

종류(kind)와 위치를 정하는 방법:
- gu    구 2개: 구청 위치(없으면 행정동 경계를 합친 면의 안쪽 대표점)
- dong  행정동 35개: 행정동 경계(vuski/admdongkor) 안의 행정복지센터(주민센터) 위치.
        없으면 무게중심, 무게중심이 경계 밖이면 polylabel(경계에서 가장 먼 안쪽 점). dongName = 경계 이름
- jibun 법정동: OpenStreetMap place=quarter 등 동네 점(법정동 이름). 소속 구·행정동은 그 점이 든 행정동 경계로 정한다
- road  도로: 기존 places.json의 도로 중심(그 도로 가로수 좌표 평균)
- poi   장소: 대학·학교·병원·역·터미널·관광지·공원·관공서·쇼핑·시장 등 이름 있는 OSM 객체
- apt   아파트: 이름 있는 OSM 아파트 단지(landuse=residential, building=apartments). '101동' 같은 동 번호는 묶는다

원본 구간 글자에서 뽑은 법정동을 그 나무들의 평균 좌표로 두던 예전 방식은 구간이 여러 동을 지나 틀렸다
(호성동1가가 인후동 안골로 잡힘). 지명 데이터: © OpenStreetMap 기여자(ODbL), 행정동 경계: 통계청·행안부(vuski/admdongkor).
"""

import argparse
import json
import math
import re
from collections import defaultdict

from shapely.geometry import Point, shape
from shapely.ops import polylabel, unary_union
from shapely.prepared import prep

from . import osm_fetch
from .schema import CONFIG_DIR, ROOT

DOCS_DATA = ROOT / "docs" / "data"
HJD_FILE = CONFIG_DIR / "boundaries" / "jeonju_hangjeongdong.geojson"
CITY_FILE = CONFIG_DIR / "boundaries" / "jeonju_osm.geojson"
OUT_FILE = DOCS_DATA / "gazetteer.json"

# 법정동 이름: 호성동1가, 진북동, 중앙동3가, 서완산동2가 (행정동 '효자1동'은 숫자 뒤 '동'이라 제외)
JIBUN_RE = re.compile(r"^[가-힣]+동(\d+가)?$")
HJD_RE = re.compile(r"^[가-힣]+\d+동$")

# 사람들이 실제로 부르는 이름(별칭). 키는 OSM 이름(정규화 전)
ALIASES = {
    "전북대학교 전주캠퍼스": ["전북대학교", "전북대", "전대", "JBNU"],
    "전북대학교": ["전북대", "전대", "JBNU"],
    "전북대학교병원": ["전북대병원", "전대병원"],
    "전주한옥마을": ["한옥마을"],
    "전주객사": ["객사", "풍패지관"],
    "풍패지관": ["객사", "전주객사"],
    "전주고속버스터미널": ["고속터미널", "고속버스터미널"],
    "전주시외버스공용터미널": ["시외버스터미널", "시외터미널", "전주시외버스터미널"],
    "전주역": ["KTX전주역", "전주기차역"],
    "남부시장": ["전주남부시장"],
    "전주남부시장": ["남부시장"],
    "전주시청": ["시청"],
    "전북특별자치도청": ["도청", "전북도청", "전라북도청"],
    "전주교육대학교": ["전주교대"],
    "전주비전대학교": ["비전대"],
    "예수병원": ["전주예수병원"],
    "전주예수병원": ["예수병원"],
    "전주월드컵경기장": ["월드컵경기장"],
    "전주종합경기장": ["종합경기장"],
    "전주동물원": ["동물원"],
    "전동성당": ["전주전동성당"],
    "풍남문": ["전주풍남문"],
}

# 꼭 있어야 하는 이름(OSM에 없거나 이름이 다를 때만 보탠다). 좌표는 OSM에서 같은 대상을 찾은 뒤 손으로 확인한 값
MANUAL = [
    # 전주한옥마을: 태조로·은행로 일대(경기전 동쪽). OSM에 하나의 이름 있는 객체가 없을 때 쓴다
    {"kind": "poi", "cat": "관광지", "name": "전주한옥마을", "lon": 127.1530, "lat": 35.8160, "rank": 3, "alias": ["한옥마을"]},
    # 전주남부시장: 풍남문 남서쪽 전주천변. OSM에는 동네 이름(locality)으로만 있다
    {"kind": "poi", "cat": "시장", "name": "전주남부시장", "lon": 127.1476, "lat": 35.8135, "rank": 2, "alias": ["남부시장"]},
]


def _r(v: float) -> float:
    return round(float(v), 5)


def rep_point(geom):
    """면 안쪽 대표점: 무게중심이 안에 있으면 무게중심, 아니면 polylabel."""
    c = geom.centroid
    if geom.contains(c):
        return c
    part = max(geom.geoms, key=lambda g: g.area) if geom.geom_type == "MultiPolygon" else geom
    return polylabel(part, tolerance=1e-5)


def load_hjd():
    gj = json.loads(HJD_FILE.read_text(encoding="utf-8"))
    out = []
    for f in gj["features"]:
        p = f["properties"]
        g = shape(f["geometry"])
        out.append({"name": p["adm_nm"].split()[-1], "gu": p["sggnm"].replace("전주시", ""), "geom": g, "prep": prep(g)})
    return out


class Locator:
    """좌표 → (구, 행정동)."""

    def __init__(self, hjd):
        self.hjd = hjd
        city = json.loads(CITY_FILE.read_text(encoding="utf-8"))
        geoms = [shape(f["geometry"]) for f in city["features"]] if "features" in city else [shape(city)]
        self.city = prep(unary_union(geoms))

    def inside_city(self, lon, lat) -> bool:
        return self.city.contains(Point(lon, lat))

    def at(self, lon, lat):
        pt = Point(lon, lat)
        for h in self.hjd:
            if h["prep"].contains(pt):
                return h["gu"], h["name"]
        # 경계 밖(전주시 경계와 행정동 경계가 조금 어긋나는 곳): 가장 가까운 행정동
        best = min(self.hjd, key=lambda h: h["geom"].distance(pt))
        if best["geom"].distance(pt) < 0.01:
            return best["gu"], best["name"]
        return None, None


def element_point(e):
    if e["type"] == "node":
        return e["lon"], e["lat"]
    c = e.get("center")
    return (c["lon"], c["lat"]) if c else (None, None)


def norm(s: str) -> str:
    return re.sub(r"[\s·.,()\-]+", "", s).lower()


# ---------- 행정동·구 ----------

def office_points(poi_elements):
    """행정복지센터·주민센터·구청 이름 → 좌표."""
    out = {}
    for e in poi_elements:
        t = e.get("tags", {})
        name = t.get("name", "")
        if not re.search(r"(행정복지센터|주민센터|주민자치센터|동사무소|구청)$", name.replace(" ", "")):
            continue
        lon, lat = element_point(e)
        if lon is not None:
            out.setdefault(name.replace(" ", ""), (lon, lat))
    return out


def build_dongs(hjd, offices):
    out = []
    for h in hjd:
        src = "polygon"
        pt = None
        for suffix in ("행정복지센터", "주민센터", "주민자치센터", "동사무소"):
            for key in (f"{h['name']}{suffix}", f"전주시{h['name']}{suffix}", f"{h['gu']}{h['name']}{suffix}"):
                if key in offices and h["prep"].contains(Point(*offices[key])):
                    pt, src = Point(*offices[key]), "office"
                    break
            if pt:
                break
        if pt is None:
            pt = rep_point(h["geom"])
        out.append({"kind": "dong", "name": h["name"], "dongName": h["name"], "gu": h["gu"], "hjd": h["name"],
                    "lon": _r(pt.x), "lat": _r(pt.y), "_src": src})
    return out


def build_gus(hjd, offices):
    out = []
    for gu in sorted({h["gu"] for h in hjd}):
        geom = unary_union([h["geom"] for h in hjd if h["gu"] == gu])
        o = offices.get(f"{gu}청") or offices.get(f"전주시{gu}청")
        if o and geom.contains(Point(*o)):
            pt, src = Point(*o), "office"
        else:
            pt, src = rep_point(geom), "polygon"
        out.append({"kind": "gu", "name": gu, "gu": gu, "lon": _r(pt.x), "lat": _r(pt.y), "alias": [f"전주시{gu}"], "_src": src})
    return out


# ---------- 법정동 ----------

def build_jibun(place_elements, loc: Locator, extra_names=()):
    """OSM 동네 점 중 법정동 이름. extra_names(원본 자료의 법정동 이름)는 점이 없으면 보고만 한다."""
    hjd_names = {h["name"] for h in loc.hjd}
    by_name = defaultdict(list)
    for e in place_elements:
        t = e.get("tags", {})
        name = (t.get("name:ko") or t.get("name") or "").replace(" ", "")
        if len(name) < 3 or not JIBUN_RE.match(name) or t.get("place") not in ("quarter", "neighbourhood", "suburb", "village", "hamlet", "borough"):
            continue
        lon, lat = element_point(e)
        if lon is None or not loc.inside_city(lon, lat):
            continue
        by_name[name].append((t.get("place"), lon, lat, e["id"]))
    out, missing = [], []
    order = {"quarter": 0, "suburb": 1, "neighbourhood": 2, "village": 3, "hamlet": 4, "borough": 5}
    for name, cands in by_name.items():
        place, lon, lat, osm_id = sorted(cands, key=lambda c: order.get(c[0], 9))[0]
        gu, h = loc.at(lon, lat)
        out.append({"kind": "jibun", "name": name, "dongName": name, "gu": gu, "hjd": h, "lon": _r(lon), "lat": _r(lat),
                    "_src": f"osm:node/{osm_id}:{place}", "_same_hjd": name in hjd_names})
    for name in sorted(set(extra_names) - set(by_name)):
        missing.append(name)
    return sorted(out, key=lambda p: p["name"]), missing


# ---------- 장소·아파트 ----------

def classify(t: dict):
    """OSM 태그 → (kind, 분류, 중요도 0~3). 쓰지 않으면 None."""
    a, name = t.get("amenity"), t.get("name", "")
    if a in ("university", "college"):
        return "poi", "대학", 3
    if t.get("railway") in ("station", "halt") or t.get("public_transport") == "station" or a == "bus_station":
        if re.search(r"(역|터미널|정류장|환승센터)$", name) or a == "bus_station" or t.get("railway"):
            return "poi", "역·터미널", 3
        return None
    if a == "hospital":
        if not re.search(r"(병원|의료원)", name):
            return None  # OSM에 hospital로 적힌 의원·약국은 뺀다
        return "poi", "병원", 2 if re.search(r"대학교병원|의료원|예수병원", name) else 1
    if a == "school":
        return "poi", "학교", 1
    if a == "marketplace":
        return "poi", "시장", 2
    if a in ("townhall", "courthouse", "police", "fire_station", "post_office", "community_centre", "public_building") or t.get("office") == "government":
        return "poi", "관공서", 2 if re.search(r"(시청|도청|구청)$", name) else 1
    if a in ("library", "arts_centre", "theatre", "cinema", "exhibition_centre", "conference_centre"):
        return "poi", "문화", 1
    if t.get("tourism") in ("attraction", "museum", "gallery", "viewpoint", "theme_park", "zoo") or t.get("historic"):
        return "poi", "관광지", 2
    if t.get("tourism") == "hotel":
        return "poi", "숙박", 0
    if t.get("leisure") in ("park", "garden", "nature_reserve"):
        return "poi", "공원", 1 if not re.search(r"(어린이공원|소공원|쉼터)$", name) else 0
    if t.get("leisure") in ("stadium", "sports_centre"):
        return "poi", "체육", 1
    if t.get("shop") in ("mall", "department_store"):
        return "poi", "쇼핑", 2
    if t.get("shop") == "supermarket":
        if not re.search(r"(이마트|홈플러스|롯데마트|하나로마트|코스트코|트레이더스|농협|롯데슈퍼|GS더프레시|메가마트|대형마트)", name, re.I) or "편의점" in name:
            return None  # 동네 슈퍼까지 넣으면 자동완성이 어지럽다
        return "poi", "쇼핑", 1
    if t.get("building") == "apartments" or t.get("landuse") == "residential" or t.get("residential"):
        return "apt", "아파트", 1
    return None


APT_UNIT = re.compile(r"\s*(제?\d+[동호]|[A-Z]동|\d+-\d+동|관리동|상가동?|경로당|관리사무소)$")


def apt_base(name: str):
    """'에코시티 더샵 2차 101동' → '에코시티 더샵 2차'. 동 번호만 있는 이름은 None."""
    base = APT_UNIT.sub("", name).strip()
    if not base or re.fullmatch(r"[\d\s\-동호A-Z]+", base):
        return None
    return base


def campus_alias(name: str):
    m = re.match(r"^(.+?)\s*\S*캠퍼스$", name)
    return [m.group(1)] if m and m.group(1) != name else []


def build_pois(poi_elements, loc: Locator):
    groups = defaultdict(list)  # (kind, 정규화 이름) → [(lon, lat, cat, rank, 원 이름, 면 여부)]
    for e in poi_elements:
        t = e.get("tags", {})
        name = (t.get("name:ko") or t.get("name") or "").strip()
        if not name or len(name) < 2:
            continue
        c = classify(t)
        if not c:
            continue
        kind, cat, rank = c
        if t.get("railway") and not name.endswith("역"):
            name += "역"  # OSM 역 이름은 '전주'처럼 '역' 없이 적혀 있다
        lon, lat = element_point(e)
        if lon is None or not loc.inside_city(lon, lat):
            continue
        if kind == "apt":
            name = apt_base(name)
            if not name:
                continue
            if JIBUN_RE.match(name.replace(" ", "")) or HJD_RE.match(name.replace(" ", "")):
                continue  # 동 이름 그대로인 주거지역은 동 항목과 겹친다
        groups[(kind, norm(name))].append((lon, lat, cat, rank, name, e["type"] != "node"))
    out = []
    for (kind, _), items in groups.items():
        # 같은 이름이 멀리 떨어져 있으면(체인 마트 등) 따로 둔다: 600m 안끼리 묶기
        clusters = []
        for it in items:
            for cl in clusters:
                if any(_dist(it[0], it[1], o[0], o[1]) < 600 for o in cl):
                    cl.append(it)
                    break
            else:
                clusters.append([it])
        for cl in clusters:
            areas = [i for i in cl if i[5]] or cl  # 면(단지·캠퍼스)이 있으면 면의 중심을 쓴다
            lon = sum(i[0] for i in areas) / len(areas)
            lat = sum(i[1] for i in areas) / len(areas)
            best = max(cl, key=lambda i: i[3])
            name = best[4]
            gu, h = loc.at(lon, lat)
            p = {"kind": kind, "name": name, "lon": _r(lon), "lat": _r(lat), "gu": gu, "hjd": h}
            if kind == "poi":
                p["cat"] = best[2]
            if best[3]:
                p["rank"] = best[3]
            alias = ALIASES.get(name, []) + campus_alias(name)
            if alias:
                p["alias"] = sorted(set(alias), key=alias.index)
            out.append(p)
    return out


def _dist(lon1, lat1, lon2, lat2):
    dx = (lon2 - lon1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat2 - lat1) * 110540
    return math.hypot(dx, dy)


def build_roads(loc: Locator):
    places = json.loads((DOCS_DATA / "places.json").read_text(encoding="utf-8"))
    out = []
    for p in places:
        if p["kind"] != "road":
            continue
        gu, h = loc.at(p["lon"], p["lat"])
        r = {"kind": "road", "name": p["name"], "lon": p["lon"], "lat": p["lat"], "count": p["count"]}
        if gu:
            r["gu"] = gu
        out.append(r)
    return out


def data_jibun_names():
    """원본 구간 글자(trees.json의 sections)에 나오는 법정동 이름. 사전에 빠진 것이 없는지 보는 데만 쓴다."""
    from .export_web import DONG_PATTERN
    trees = json.loads((DOCS_DATA / "trees.json").read_text(encoding="utf-8"))
    names = set()
    for sec in trees.get("sections", []):
        names.update(m.group(1) for m in DONG_PATTERN.finditer(sec))
    return sorted(n for n in names if JIBUN_RE.match(n))


def build(write: bool = True) -> dict:
    hjd = load_hjd()
    loc = Locator(hjd)
    places_el = osm_fetch.load("place")["elements"]
    poi_el = osm_fetch.load("poi")["elements"]
    offices = office_points(poi_el)
    gus = build_gus(hjd, offices)
    dongs = build_dongs(hjd, offices)
    roads = build_roads(loc)
    jibun, missing = build_jibun(places_el, loc, extra_names=data_jibun_names())
    pois = build_pois(poi_el, loc)
    have = {norm(p["name"]) for p in pois} | {norm(a) for p in pois for a in p.get("alias", [])}
    for m in MANUAL:
        if norm(m["name"]) not in have:
            gu, h = loc.at(m["lon"], m["lat"])
            pois.append({**m, "gu": gu, "hjd": h, "_src": "manual"})
    entries = gus + dongs + jibun + pois + roads
    kind_order = {"gu": 0, "dong": 1, "jibun": 2, "poi": 3, "apt": 4, "road": 5}
    entries.sort(key=lambda p: (kind_order[p["kind"]], -(p.get("rank") or 0), p["name"]))
    public = [{k: v for k, v in p.items() if not k.startswith("_") and v is not None} for p in entries]
    counts = defaultdict(int)
    for p in public:
        counts[p["kind"]] += 1
    if write:
        OUT_FILE.write_text(json.dumps(public, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {
        "counts": dict(counts), "total": len(public),
        "bytes": len(json.dumps(public, ensure_ascii=False, separators=(",", ":")).encode()),
        "dong_from_office": sum(1 for d in dongs if d["_src"] == "office"),
        "jibun_missing_in_osm": missing,
        "manual_added": [p["name"] for p in pois if p.get("_src") == "manual"],
        "osm_fetched": osm_fetch.load("poi").get("_fetched"),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않고 요약만")
    args = ap.parse_args()
    print(json.dumps(build(write=not args.dry_run), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
