// 홈 화면 모듈(캐릭터·일일 흡수·동네 찾기 색인)이 모든 수종·계절에서 깨지지 않는지 확인한다.
//   node tests/web_home.mjs
import { readFileSync } from "node:fs";
import { treeSVG, archetype, MOODS, moodFor } from "../docs/js/characters.js";
import { dailyWeight, uptakeBetween, cumulativeThisYear, yearProfile, seasonWindow } from "../docs/js/daily.js";
import { searchPlaces, searchPlacesScored, nearestTrees, nearestAny, distanceM, normText, parseAddress, matchRanges, resolveQuery } from "../docs/js/geo.js";
import { audit, inGeom, hjdGeom } from "./gazetteer_audit.mjs";
import { careSuggestions } from "../docs/js/weather.js";
import { treesInBounds, friendPoints, friendRows, distText } from "../docs/js/friends.js";
import { findArea, areaTrees, speciesCounts, centerOf, pointInArea, openArea } from "../docs/js/area.js";

const root = new URL("../", import.meta.url);
const S = JSON.parse(readFileSync(new URL("docs/data/summary.json", root), "utf8"));
const P = JSON.parse(readFileSync(new URL("docs/data/params.json", root), "utf8"));
const FORM = JSON.parse(readFileSync(new URL("docs/data/tree_form.json", root), "utf8"));
const PLACES = JSON.parse(readFileSync(new URL("docs/data/gazetteer.json", root), "utf8"));
const ACT = JSON.parse(readFileSync(new URL("docs/data/activities.json", root), "utf8"));

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed++; };

// 캐릭터: 수종 × 계절 × 스타일 × 기분 모두 유효한 SVG
let count = 0, bad = [];
for (const species of Object.keys(S.species_info)) {
  const info = S.species_info[species];
  for (const season of ["spring", "summer", "autumn", "winter"]) {
    for (const style of ["character", "real"]) {
      for (const mood of style === "character" ? MOODS : ["happy"]) {
        for (const dbh of [6, 20, 60]) {
          const out = treeSVG({ species, info, dbh, form: FORM, season, style, mood, size: 120 });
          count++;
          if (!out.startsWith("<svg") || !out.endsWith("</svg>") || /NaN|undefined|null/.test(out)) bad.push(`${species}/${season}/${style}/${mood}/${dbh}`);
        }
      }
    }
  }
}
check(bad.length === 0, `캐릭터 SVG ${count}개 생성, 깨진 것 ${bad.length}개 ${bad.slice(0, 3).join(", ")}`);
check(Object.keys(S.species_info).every(s => archetype(s, S.species_info[s])), "모든 수종에 원형(archetype)이 있다");
check(moodFor({ season: "summer", weather: { heat: true } }) === "hot" && moodFor({ season: "winter" }) === "sleepy", "기분 규칙");

// 일일 흡수: 한 해 가중치 합 = 1, 겨울 0, 한여름 최대
const year = 2026;
const prof = yearProfile(1, year, P);
const sum = prof.reduce((a, b) => a + b, 0);
check(Math.abs(sum - 1) < 1e-9, `연간 가중치 합 ${sum.toFixed(6)}`);
check(dailyWeight(new Date(year, 0, 15), P) === 0 && dailyWeight(new Date(year, 11, 20), P) === 0, "1월·12월 흡수 0");
const peak = prof.indexOf(Math.max(...prof)) + 1;
check(Math.abs(peak - 201) <= 1, `최대 흡수일 DOY ${peak} (7월 20일 전후)`);
const w = seasonWindow(P);
check(w.length === Math.round(P.growth.frost_free_days.center), `생육기간 ${w.length}일 = 무상기간 중심값`);
check(Math.abs(cumulativeThisYear(100, new Date(year, 11, 31), P) - 100) < 1e-6, "연말 누적 = 연간");
check(Math.abs(uptakeBetween(100, new Date(year, 0, 1), new Date(year + 1, 11, 31), P) - 200) < 1e-6, "두 해에 걸친 합 = 2 × 연간");

// 동네 찾기 색인
const kinds = PLACES.reduce((m, p) => ({ ...m, [p.kind]: (m[p.kind] || 0) + 1 }), {});
check(kinds.dong === 35 && kinds.jibun > 60 && kinds.road > 400 && kinds.poi > 100 && kinds.apt > 20, `지명 사전 ${PLACES.length}개 ${JSON.stringify(kinds)}`);
check(PLACES.every(p => p.kind && p.name && Number.isFinite(p.lon) && Number.isFinite(p.lat)), "모든 장소에 kind·name·lon·lat");
check(PLACES.filter(p => p.kind === "dong" || p.kind === "jibun").every(p => p.dongName === p.name), "행정동·법정동에 경계 이름과 같은 dongName");
const hit = searchPlaces(PLACES, "효자동")[0];
check(hit && /^효자(동\d가|\d동)$/.test(hit.name), `'효자동' 검색 → ${hit?.name} (효자1~5동·효자동1~3가 묶음)`);
const two = searchPlaces(PLACES, "효자 백제")[0];
check(two && /효자|백제/.test(two.name), `'효자 백제' 검색 → ${two?.name}`);
check(searchPlaces(PLACES, "").length === 0, "빈 검색어는 결과 없음");

// 검색어별 기대 위치(1km 안)·행정동. 기준 좌표는 OSM 객체 위치(Photon으로 따로 확인)
const nearTo = (p, lon, lat, m = 1000) => p && distanceM(p.lon, p.lat, lon, lat) <= m;
const CASES = [
  ["전북대학교", p => p.kind === "poi" && p.cat === "대학" && nearTo(p, 127.1337, 35.8467)],
  ["전북대", p => p.kind === "poi" && /전북대학교/.test(p.name) && nearTo(p, 127.1337, 35.8467)],
  ["전대", p => /전북대학교/.test(p.name)],
  ["전북대병원", p => /전북대학교병원/.test(p.name) && nearTo(p, 127.1415, 35.8478)],
  ["한옥마을", p => nearTo(p, 127.1530, 35.8160)],
  ["전주 한옥마을", p => nearTo(p, 127.1530, 35.8160)],
  ["호성동1가", p => p.kind === "jibun" && p.name === "호성동1가" && p.hjd === "호성동" && nearTo(p, 127.1544, 35.8635)],
  ["호성동 1가", p => p.kind === "jibun" && p.name === "호성동1가" && p.hjd === "호성동"],
  ["호성1가", p => p.name === "호성동1가"],
  ["호성동", p => p.kind === "dong" && p.dongName === "호성동" && inGeom(p.lon, p.lat, hjdGeom("호성동"))],
  ["서신동", p => p.kind === "dong" && p.dongName === "서신동" && inGeom(p.lon, p.lat, hjdGeom("서신동"))],
  ["전주시 서신동", p => p.kind === "dong" && p.name === "서신동"],
  ["전북특별자치도 전주시 덕진구 금암동", p => p.kind === "dong" && p.name === "금암동"],
  ["전주역", p => nearTo(p, 127.1624, 35.8501)],
  ["객사", p => nearTo(p, 127.1453, 35.8185)],
  ["고속버스터미널", p => nearTo(p, 127.1293, 35.8345)],
  ["완산구", p => p.kind === "gu" && p.name === "완산구"],
];
for (const [q, ok] of CASES) {
  const top = searchPlaces(PLACES, q, 1)[0];
  check(Boolean(top && ok(top)), `'${q}' → ${top ? `${top.kind} ${top.name} (${top.gu || ""} ${top.hjd || ""}) ${top.lat.toFixed(4)},${top.lon.toFixed(4)}` : "없음"}`);
}
const many = q => searchPlaces(PLACES, q, 10).map(p => p.name);
check(["호성동", "호성동1가", "호성동2가", "호성동3가"].every(n => many("호성동").includes(n)), `'호성동' 후보: ${many("호성동").slice(0, 5).join(", ")}`);
check(["효자동1가", "효자동2가", "효자동3가", "효자1동", "효자5동"].every(n => many("효자동").includes(n)), `'효자동' 후보: ${many("효자동").join(", ")}`);
// 아파트 단지(OSM에 이름 있는 단지). 사람들이 줄여 쓰는 이름으로
for (const [q, lon, lat, hjd] of [["에코시티 더샵 2차", 127.1331, 35.8775, "송천3동"], ["인후궁전", 127.1509, 35.8351, "인후1동"], ["서곡두산아파트", 127.0981, 35.8310, "효자5동"]]) {
  const top = searchPlaces(PLACES, q, 1)[0];
  check(top?.kind === "apt" && top.hjd === hjd && nearTo(top, lon, lat, 300), `아파트 '${q}' → ${top?.name} (${top?.hjd})`);
}
// 한글 정규화: NFD·NFKD로 들어와도 같은 결과
check(searchPlaces(PLACES, "호성동1가".normalize("NFKD"), 1)[0]?.name === "호성동1가" && normText("호성동 1가") === "호성동1가", "NFKD 입력도 NFC로 맞춰 찾는다");
check(JSON.stringify(matchRanges("전북대학교 전주캠퍼스", "전북대")) === "[[0,3]]" && JSON.stringify(matchRanges("호성동1가", "호성동 1가")) === "[[0,5]]", "일치 글자 강조 범위");
check(parseAddress("백제대로 567")?.num === "567" && parseAddress("덕진동1가 664-14")?.base === "덕진동1가" && parseAddress("호성동 1가") === null && parseAddress("전주역") === null, "번지 주소 알아보기");
// Enter: 확실하면 바로, 모호하면 후보 목록. 번지 주소는 외부 결과 중 번지가 맞는 것만 바로 고른다(가짜 지오코더)
const fakeGeo = async () => [{ kind: "addr", name: "백제대로 567", lon: 127.1337, lat: 35.8467, num: "567" }, { kind: "addr", name: "엉뚱한 곳", lon: 127.30, lat: 35.70, num: "567" }];
const r1 = await resolveQuery(PLACES, "호성동1가", { geocoder: fakeGeo });
const r2 = await resolveQuery(PLACES, "효자동", { geocoder: fakeGeo });
const r3 = await resolveQuery(PLACES, "백제대로 567", { geocoder: fakeGeo });
const r4 = await resolveQuery(PLACES, "백제대로 9999", { geocoder: async () => [] });
check(r1.pick?.name === "호성동1가", `Enter '호성동1가' → 바로 ${r1.pick?.name}`);
check(!r2.pick && r2.candidates.length >= 5, `Enter '효자동' → 후보 ${r2.candidates.length}개(바로 이동하지 않음)`);
check(r3.pick?.name === "백제대로 567", `Enter '백제대로 567' → ${r3.pick?.name}`);
check(!r4.pick && r4.candidates.some(c => c.kind === "road" && c.name === "백제대로"), "번지를 못 찾으면 도로 중심을 후보로");
const r5 = await resolveQuery(PLACES, "백제대로 10", { geocoder: async () => [{ kind: "addr", name: "가", lon: 127.10, lat: 35.81, num: "10" }, { kind: "addr", name: "나", lon: 127.14, lat: 35.84, num: "10" }] });
check(!r5.pick && r5.candidates.length >= 2, "같은 번지가 멀리 두 곳이면 고르게 한다");
// 전수 검수: 모든 행정동·법정동 이름 검색 결과가 제자리(행정동 경계 안, 법정동 기준 위치·이름 뿌리 행정동)
const rows = audit();
const badRows = rows.filter(r => !r.ok);
check(badRows.length === 0, `행정동·법정동 ${rows.length}개 전수 검수, 틀림 ${badRows.length}개 ${badRows.slice(0, 5).map(r => r.name).join(", ")}`);
check(Math.abs(distanceM(127.1, 35.8, 127.1, 35.809) - 1000) < 15, "거리 계산: 위도 0.009° ≈ 1km");
const T = { id: ["a", "b", "c"], lon: [127.10, 127.101, 127.2], lat: [35.80, 35.80, 35.80] };
const near = nearestTrees(T, 127.1, 35.8, { radius: 300 });
check(near.length === 2 && near[0].i === 0, `반경 안 나무 ${near.length}그루, 가장 가까운 것 ${near[0]?.i}`);
const far = nearestAny(T, 127.3, 35.8, 2);
check(far.length === 2 && far[0].i === 2, `반경 밖이어도 가장 가까운 나무 ${far.length}그루(${Math.round(far[0]?.d)}m)`);

// 지도 위 친구 나무: 화면 안 가로수, 좌표 없는(또는 원본에 없는) 내 나무도 깨지지 않음
const TB = { id: ["a", "b", "c", "d"], lon: [127.10, 127.101, 127.2, null], lat: [35.80, 35.80, 35.80, null] };
const inView = treesInBounds(TB, [[127.099, 35.799], [127.102, 35.801]]);
check(inView.length === 2 && inView.includes(0) && inView.includes(1), `화면 안 나무 ${inView.length}그루`);
check(treesInBounds(TB, [[127.0, 35.7], [127.3, 35.9]], { limit: 1 }).length === 1, "화면 안 나무 상한");
const my = [{ id: "a", name: "은행이", lon: 127.10, lat: 35.80 }, { id: "u-1", name: "시민", lon: 127.2, lat: 35.80 }, { id: "x", name: "좌표없음" }];
check(friendPoints(my).length === 2, "좌표 있는 내 나무만 표시(원본에 없는 u- 나무 포함)");
const fr = friendRows(my, { lon: 127.2, lat: 35.8 });
check(fr[0].t.id === "u-1" && fr[0].d < 1 && fr[1].d > 8000, `내 나무 목록 거리순: ${fr.map(r => r.t.id).join(",")}`);
check(friendRows(my, null)[0].t.id === "a" && distText(950) === "950m" && distText(9050) === "9.1km", "기준점 없음·거리 표기");
// 동네 전체 보기(area.js): 경계 이름으로 찾기, 경계 안 나무 수 = 동 배정 수
const AREAS = JSON.parse(readFileSync(new URL("docs/data/dongs.geojson", root), "utf8"));
const TREES = JSON.parse(readFileSync(new URL("docs/data/trees.json", root), "utf8"));
const dongFeats = AREAS.features.filter(f => f.properties.kind === "dong");
check(dongFeats.length === 35 && AREAS.features.every(f => f.properties.name && f.properties.gu && /Polygon/.test(f.geometry.type)), `동 경계 ${AREAS.features.length}개(행정동 ${dongFeats.length})`);
check(findArea(AREAS, { kind: "dong", name: "효자5동", lon: 0, lat: 0 })?.properties.name === "효자5동", "행정동 '효자5동' → 경계(좌표는 안 씀)");
check(findArea(AREAS, { kind: "jibun", name: "서신동 (지번)", dongName: "서신동" })?.properties.name === "서신동", "dongName으로 찾기, 법정동 경계가 없으면 같은 이름 행정동");
check(findArea(AREAS, { kind: "road", name: "서신동" }) === null && findArea(AREAS, { kind: "dong", name: "없는동" }) === null, "도로·모르는 이름은 반경 보기로");
const assigned = new Map();
for (const k of TREES.dong) if (k !== null) assigned.set(TREES.dongs[k], (assigned.get(TREES.dongs[k]) || 0) + 1);
let countBad = [], centerOut = [], polyGap = 0, polyTotal = 0;
for (const f of dongFeats) {
  const name = f.properties.name, want = assigned.get(name) || 0;
  const got = areaTrees(TREES, f).length, byPoly = areaTrees(TREES, f, { byPolygon: true }).length;
  if (got !== want) countBad.push(`${name} ${got}/${want}`);
  polyGap += Math.abs(byPoly - want); polyTotal += want;
  const c = centerOf(f.geometry);
  if (!pointInArea(c.lon, c.lat, f.geometry)) centerOut.push(name);
}
check(countBad.length === 0, `동마다 경계 안 나무 수 = trees.json 동 배정 수 ${countBad.slice(0, 3).join(", ")}`);
check(centerOut.length === 0, `동 가운데 점이 경계 안 ${centerOut.join(", ")}`);
check(polyGap / polyTotal < 0.005, `단순화한 경계로 센 수와 차이 ${polyGap}그루(${(polyGap / polyTotal * 100).toFixed(2)}%, 경계 근처 나무)`);
const hz = await openArea({ kind: "dong", name: "효자5동" }, TREES, AREAS);
check(hz && hz.idx.length === assigned.get("효자5동") && hz.dist.get(hz.idx[0]) <= hz.dist.get(hz.idx.at(-1)), `효자5동 ${hz?.idx.length}그루, 가운데에서 가까운 순`);
const top = speciesCounts(TREES, hz.idx);
check(top.reduce((a, [, n]) => a + n, 0) === hz.idx.length && top[0][1] >= top[1][1], `수종 요약 ${top.length}종, 1위 ${top[0][0]} ${top[0][1]}`);

// 날씨 제안
const hot = careSuggestions({ weather: { flags: { heat: true }, today: { tmax: 35 }, past7Rain: 0 }, season: "summer", measured: false });
check(hot[0].activity === "water", `폭염이면 물주기 먼저: ${hot[0].activity}`);
check(hot.some(s => s.activity === "measure"), "미측정이면 둘레 재기 제안");
check(ACT.care.length >= 5 && ACT.practice.every(a => a.kg === null || a.kg >= 0), "활동 목록과 환산 계수");

if (failed) { console.error(`${failed}개 실패`); process.exit(1); }
console.log("홈 모듈 모두 통과");
