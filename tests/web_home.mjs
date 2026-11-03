// 홈 화면 모듈(캐릭터·일일 흡수·동네 찾기 색인)이 모든 수종·계절에서 깨지지 않는지 확인한다.
//   node tests/web_home.mjs
import { readFileSync } from "node:fs";
import { treeSVG, archetype, MOODS, moodFor } from "../docs/js/characters.js";
import { dailyWeight, uptakeBetween, cumulativeThisYear, yearProfile, seasonWindow } from "../docs/js/daily.js";
import { searchPlaces, nearestTrees, distanceM } from "../docs/js/geo.js";
import { careSuggestions } from "../docs/js/weather.js";
import { newUserTreeId, isUserTreeId, insidePolygon, guessDong, userRecord } from "../docs/js/usertrees.js";

const root = new URL("../", import.meta.url);
const S = JSON.parse(readFileSync(new URL("docs/data/summary.json", root), "utf8"));
const P = JSON.parse(readFileSync(new URL("docs/data/params.json", root), "utf8"));
const FORM = JSON.parse(readFileSync(new URL("docs/data/tree_form.json", root), "utf8"));
const PLACES = JSON.parse(readFileSync(new URL("docs/data/places.json", root), "utf8"));
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
check(PLACES.some(p => p.kind === "dong") && PLACES.some(p => p.kind === "road"), `장소 색인 ${PLACES.length}개(동·도로)`);
const hit = searchPlaces(PLACES, "효자동")[0];
check(hit && hit.name.startsWith("효자동"), `'효자동' 검색 → ${hit?.name}`);
const two = searchPlaces(PLACES, "효자 백제")[0];
check(two && /효자|백제/.test(two.name), `'효자 백제' 검색 → ${two?.name}`);
check(searchPlaces(PLACES, "").length === 0, "빈 검색어는 결과 없음");
check(Math.abs(distanceM(127.1, 35.8, 127.1, 35.809) - 1000) < 15, "거리 계산: 위도 0.009° ≈ 1km");
const T = { id: ["a", "b", "c"], lon: [127.10, 127.101, 127.2], lat: [35.80, 35.80, 35.80] };
const near = nearestTrees(T, 127.1, 35.8, { radius: 300 });
check(near.length === 2 && near[0].i === 0, `반경 안 나무 ${near.length}그루, 가장 가까운 것 ${near[0]?.i}`);

// 날씨 제안
const hot = careSuggestions({ weather: { flags: { heat: true }, today: { tmax: 35 }, past7Rain: 0 }, season: "summer", measured: false });
check(hot[0].activity === "water", `폭염이면 물주기 먼저: ${hot[0].activity}`);
check(hot.some(s => s.activity === "measure"), "미측정이면 둘레 재기 제안");
check(ACT.care.length >= 5 && ACT.practice.every(a => a.kg === null || a.kg >= 0), "활동 목록과 환산 계수");

// 시민 직접 등록 나무(usertrees.js)
const TREES = JSON.parse(readFileSync(new URL("docs/data/trees.json", root), "utf8"));
const BOUND = JSON.parse(readFileSync(new URL("docs/data/boundary.geojson", root), "utf8"));
const uid = newUserTreeId();
check(/^u-[0-9a-z]{4,14}-[0-9a-z]{4}$/.test(uid) && /^[0-9A-Za-z_-]{1,32}$/.test(uid) && isUserTreeId(uid) && !isUserTreeId("83428"),
  `등록 번호 ${uid}: user_trees.sql·sns_schema.sql tree_id 형식에 맞음`);
check(insidePolygon(127.1294, 35.8468, BOUND), "전북대 캠퍼스(35.8468, 127.1294)는 전주 경계 안");
check(!insidePolygon(126.978, 37.5665, BOUND) && !insidePolygon(127.0, 35.95, BOUND), "서울·전주 밖 좌표는 막음");
check(guessDong(TREES, 127.1294, 35.8468) !== null, `캠퍼스 안 등록 나무의 동 어림: ${guessDong(TREES, 127.1294, 35.8468)}`);
const ctx = { S, P, FORM };
const withDbh = userRecord({ id: uid, lon: 127.1294, lat: 35.8468, species: "느티나무", speciesSource: "ai", circ: 94.2 }, ctx);
check(Math.abs(withDbh.dbh - 30) < 0.1 && withDbh.seq.every(v => v > 0) && withDbh.seq[0] <= withDbh.seq[1] && withDbh.seq[1] <= withDbh.seq[2] && withDbh.annualKg > 0 && withDbh.heightM > 0,
  `둘레 94.2cm → 흉고 ${withDbh.dbh}cm, 한 해 CO₂ ${withDbh.seq.map(v => v.toFixed(1)).join("~")}kg (추정)`);
const noDbh = userRecord({ id: uid, lon: 127.1294, lat: 35.8468, species: null }, ctx);
check(noDbh.species === "기타" && noDbh.speciesSource === "unknown" && noDbh.seq[1] === null && noDbh.annualKg === 0 && noDbh.dbh === null, "수종·둘레 모르면 '기타'·탄소 없음");
const ORIG_KEYS = ["i", "id", "species", "info", "road", "dong", "section", "dongEdge", "grade", "dbh", "block", "seq", "annualKg", "lon", "lat", "heightM"];
check(ORIG_KEYS.every(k => k in noDbh), "등록 나무 기록이 원본 treeRecord의 모든 필드를 가짐");
const svgOut = treeSVG({ species: noDbh.species, info: noDbh.info, dbh: noDbh.dbh || 15, form: FORM, season: "summer", style: "character", mood: "happy", size: 120 });
check(svgOut.startsWith("<svg") && !/NaN|undefined/.test(svgOut), "등록 나무 캐릭터 그림");

// AI 잎 인식 문장 임베딩(pipeline/leafid.mjs가 만든 docs/data/leafid.json)
const LEAF = JSON.parse(readFileSync(new URL("docs/data/leafid.json", root), "utf8"));
const dim = LEAF.classes[0].emb.length;
const unit = LEAF.classes.every(c => Math.abs(Math.hypot(...c.emb) - 1) < 1e-2 && c.emb.length === dim);
const jeonju = Object.keys(S.species_info).filter(sp => sp !== "기타");
check(LEAF.classes.length === jeonju.length && jeonju.every(sp => LEAF.classes.some(c => c.species === sp)) && unit,
  `leafid.json: 전주 수종 ${LEAF.classes.length}종 × ${dim}차원, 단위 벡터 (${LEAF.model}, ${LEAF.dtype})`);
check(Math.abs(LEAF.classes.reduce((a, c) => a + c.prior, 0) - 1) < 1e-3, "수종 사전확률 합 = 1");

if (failed) { console.error(`${failed}개 실패`); process.exit(1); }
console.log("홈 모듈 모두 통과");
