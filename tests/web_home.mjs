// 홈 화면 모듈(캐릭터·일일 흡수·동네 찾기 색인)이 모든 수종·계절에서 깨지지 않는지 확인한다.
//   node tests/web_home.mjs
import { readFileSync } from "node:fs";
import { treeSVG, archetype, MOODS, moodFor } from "../docs/js/characters.js";
import { dailyWeight, uptakeBetween, cumulativeThisYear, yearProfile, seasonWindow } from "../docs/js/daily.js";
import { searchPlaces, nearestTrees, distanceM } from "../docs/js/geo.js";
import { careSuggestions } from "../docs/js/weather.js";

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

if (failed) { console.error(`${failed}개 실패`); process.exit(1); }
console.log("홈 모듈 모두 통과");
