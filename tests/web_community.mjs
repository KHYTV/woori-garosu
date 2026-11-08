// 커뮤니티 화면 도우미(docs/js/community.js)의 순수 함수: 시각 표시, 지도 카드 한 줄, 닉네임 가리기.
//   node tests/web_community.mjs
import { ago, dayAgo, kstDay, cardLine, rankName, feedWho, PERIODS, TARGETS, MAP_MIN_ZOOM, REFRESH_MS } from "../docs/js/community.js";

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed++; };

// 2026-11-08 00:30 KST = 2026-11-07 15:30 UTC: 한국 날짜는 8일
const now = Date.parse("2026-11-07T15:30:00Z");
check(kstDay(now) === "2026-11-08", `한국 날짜 ${kstDay(now)}`);
check(ago(new Date(now - 20e3).toISOString(), now) === "방금" && ago(new Date(now - 5 * 60e3).toISOString(), now) === "5분 전"
  && ago(new Date(now - 3 * 3600e3).toISOString(), now) === "3시간 전" && ago(new Date(now - 50 * 3600e3).toISOString(), now) === "2일 전", "몇 분 전 표시");
check(dayAgo("2026-11-08", now) === "오늘" && dayAgo("2026-11-07", now) === "어제" && dayAgo("2026-11-01", now) === "7일 전" && dayAgo(null, now) === null, "마지막 활동 날짜(한국 날짜 기준)");
check(cardLine({ guardians: 2, others: 1, last_day: "2026-11-08", recent: 3, is_mine: true }, now) === "보호자 2명(나 포함) · 최근 활동 오늘 · 30일 3회", "지도 카드 한 줄(내 나무)");
check(cardLine({ guardians: 1, others: 1, last_day: null, recent: 0, is_mine: false }, now) === "보호자 1명 · 아직 활동 기록 없음", "지도 카드 한 줄(활동 없음)");
check(cardLine(null) === null, "다른 보호자 없으면 줄 없음");
check(rankName({ name: null, is_me: false }, "guardian") === "익명 보호자" && rankName({ name: "가람", is_me: true }, "guardian") === "나 · 가람"
  && rankName({ name: "나래", is_me: false }, "guardian") === "나래", "보호자 순위 이름: 공개 안 한 사람은 익명");
check(rankName({ name: null, species: "은행나무" }, "tree") === "은행나무" && rankName({ dong: "효자동1가", name: "효자동1가" }, "dong") === "효자동1가", "나무·동네 순위 이름");
check(feedWho({ is_me: false, nickname: null }) === "이웃 보호자" && feedWho({ is_me: true, nickname: "가람" }) === "나" && feedWho({ is_me: false, nickname: "나래" }) === "나래", "이웃 소식 이름");
check(PERIODS.map(p => p[0]).join() === "day,week,month,year" && TARGETS.map(t => t[0]).join() === "dong,guardian,tree", "기간·대상 탭이 community.sql과 같음");
check(MAP_MIN_ZOOM === 14 && REFRESH_MS >= 60000, "지도 확대 14부터, 새로 고침 1분 이상");

if (failed) { console.error(`${failed}개 실패`); process.exit(1); }
console.log("커뮤니티 모듈 모두 통과");
