// 우리동네가로수 화면 흐름: 인트로 → 전주 현황 → 동네 찾기 → 나무 SNS(프로필·대화·기록)
import { treeSVG, archetype, seasonForDate, moodFor, hashSeed } from "./characters.js";
import { dailyUptake, dailyWeight, cumulativeThisYear, uptakeBetween, yearProfile, dayOfYear, seasonWindow } from "./daily.js";
import { nearestTrees, searchPlaces, geocode, locate, insideJeonju, distanceM, JEONJU } from "./geo.js";
import { createMiniMap } from "./minimap.js";
import { fetchWeather, weatherLabel, careSuggestions } from "./weather.js";
import { db, compressImage } from "./db.js";
import { greeting, proactive, reply, reaction, josa } from "./talk.js";
import { estimateForm } from "./treeform.js";
import { circumferenceToDbh } from "./carbon.js";
import * as cloud from "./cloud.js";

const $ = sel => document.querySelector(sel);
const nf = (v, d = 0) => Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const kg = v => (Math.abs(v) < 10 ? nf(v, 1) : nf(v, 0));
// 1kg 미만은 g으로 보여 준다 → [값, 단위]
const mass = v => (Math.abs(v) < 1 ? [nf(v * 1000), "g"] : [kg(v), "kg"]);
const massText = v => mass(v).join("");
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const svg = markup => { const s = el("span", { class: "svgwrap" }); s.innerHTML = markup; return s.firstElementChild; };
const DAY = 86400000;
const NICKNAMES = { ginkgo: ["은행이", "노랑이", "부채"], cherry: ["벚꽃이", "분홍이", "봄이"], zelkova: ["느티", "그늘이", "우산"], fringe: ["이팝이", "쌀밥이", "하양이"],
  maple: ["단풍이", "빨강이", "별잎"], plane: ["버즘이", "얼룩이", "넓적이"], conifer: ["메타", "키다리", "뾰족이"], juniper: ["향이", "초록이"], cedar: ["시다", "늘푸른"],
  pine: ["솔이", "소나무", "늘솔"], persimmon: ["감이", "주황이", "홍시"], oak: ["도토리", "참이"], willow: ["버들이", "늘어진"], locust: ["아까시", "꿀꽃"],
  goldenrain: ["모감주", "노랑꽃"], magnolia: ["목련이", "하얀이"], generic: ["나무", "친구", "초록이"] };

let T, S, P, FORM, PLACES, ACT, weather = null;
const season = seasonForDate();
const state = { my: [], posts: [], near: { center: null, label: "", results: [], picked: null, radius: 300 }, profile: null };
let tickTimer = null, pollTimer = null;

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function main() {
  try {
    [S, P, FORM, PLACES, ACT] = await Promise.all([loadJSON("data/summary.json"), loadJSON("data/params.json"), loadJSON("data/tree_form.json"),
      loadJSON("data/places.json"), loadJSON("data/activities.json")]);
  } catch (e) {
    toast("데이터를 불러오지 못했습니다. 새로고침해 주세요.", true);
    throw e;
  }
  renderIntro();
  const treesReady = loadJSON("data/trees.json").then(t => { T = t; });
  fetchWeather(JEONJU.lon, JEONJU.lat).then(w => { weather = w; renderWeatherChips(); }).catch(() => { /* 날씨 없이도 동작 */ });
  for (const b of document.querySelectorAll(".tabbar a")) b.addEventListener("click", () => window.scrollTo(0, 0));
  $("#backBtn").addEventListener("click", goBack);
  await treesReady;
  await importLegacyGuardians();
  await setupCloud();
  await refreshMine();
  window.addEventListener("hashchange", route);
  route();
}

// ---------- 온라인(Supabase) ----------
async function setupCloud() {
  let cfg = null;
  try { cfg = await loadJSON("data/backend.json"); } catch { /* 설정 파일 없음 */ }
  // 개발 중에는 localhost에서만 ?backend=&backendkey=로 가짜 서버를 끼울 수 있다
  const params = new URLSearchParams(location.search);
  const dev = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (dev && params.get("backend")) cfg = { url: params.get("backend"), key: params.get("backendkey") || "dev" };
  cloud.configure(cfg);
  state.profile = await db.getMeta("cloud-profile");
  if (cloudOn()) pushPending().catch(err => console.warn("서버 동기화 실패", err));
}
const cloudOn = () => cloud.configured() && cloud.signedIn() && Boolean(state.profile);
async function joinOnline(nickname, dong) {
  await cloud.signIn();
  const me = await cloud.api.setProfile({ nickname, dong });
  state.profile = { nickname: me?.nickname || nickname, dong: me?.dong || dong || null };
  await db.setMeta("cloud-profile", state.profile);
  await pushPending();
}
async function leaveOnline() {
  cloud.signOut();
  state.profile = null;
  await db.setMeta("cloud-profile", null);
}
// 기기에만 있는 내 나무·활동을 서버로 올린다(두 번 보내도 한 번만 남는다)
async function pushPending() {
  if (!cloudOn()) return;
  await refreshMine();
  for (const t of state.my) await cloud.api.follow({ id: t.id, name: t.name, species: t.species, dong: t.dong, since: t.since });
  // 어느 서버에 보냈는지 기억해 두어, 서버가 바뀌면 다시 보낸다
  for (const p of state.posts) {
    if (p.syncedTo === cloud.baseUrl()) continue;
    const t = myTree(p.treeId);
    if (!t) continue;
    await cloud.api.addActivity({ treeId: p.treeId, activity: p.activity, clientId: String(p.pid), dong: t.dong, t: p.t });
    p.syncedTo = cloud.baseUrl();
    await db.putPost(p);
  }
}
async function syncPost(post, t) {
  if (!cloudOn()) return;
  try {
    await cloud.api.addActivity({ treeId: t.id, activity: post.activity, clientId: String(post.pid), dong: t.dong, t: post.t });
    post.syncedTo = cloud.baseUrl();
    await db.putPost(post);
  } catch (err) { console.warn("활동 서버 저장 실패(나중에 다시 보냄)", err); }
}
function myDongGuess() {
  const counts = new Map();
  for (const t of state.my) if (t.dong) counts.set(t.dong, (counts.get(t.dong) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}
function joinDialog() {
  const names = ["보호자", "나무지기", "숲친구", "동네지기"];
  const nick = el("input", { type: "text", name: "nickname", maxlength: "12", required: true, value: `${names[Math.floor(Math.random() * names.length)]}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, "aria-label": "닉네임" });
  const dong = el("input", { type: "text", name: "dong", maxlength: "40", list: "dongList", value: myDongGuess(), placeholder: "내 동네 (예: 효자동3가)", "aria-label": "동" });
  const list = el("datalist", { id: "dongList" }, ...PLACES.filter(p => p.kind === "dong").map(p => el("option", { value: p.name })));
  dialog("온라인으로 함께하기", el("div", { class: "dialog-body" },
    el("p", {}, "공동보호자와 대화하고 동네 순위에 참여해요. 서버에는 닉네임, 내 나무(관리번호·이름), 활동 종류와 시각, 동 이름만 올라가요. 사진·메모·내 위치는 올라가지 않아요."),
    el("label", { class: "file" }, el("span", {}, "닉네임"), nick),
    el("label", { class: "file" }, el("span", {}, "내 동네 (순위 집계용, 선택)"), dong), list,
    el("p", { class: "hint" }, "기기마다 익명 계정이 만들어져요. 기기를 바꾸면 다른 사람으로 보여요.")), {
    confirm: "참여하기",
    onConfirm: async form => {
      const n = form.nickname.value.trim();
      if (!n) return false;
      try { await joinOnline(n, form.dong.value.trim()); }
      catch (err) { toast(`연결 실패: ${err.message}`, true); return false; }
      toast(`${n}님, 온라인으로 함께해요`);
      renderSNS();
    },
  });
}
function onlineCard() {
  if (!cloud.configured()) {
    return el("section", { class: "card online" }, el("div", { class: "k" }, "온라인 함께하기"),
      el("p", { class: "limit" }, "공동보호자 대화와 동네 순위는 서버 연결 뒤에 열려요. 지금은 모든 기록이 이 기기에만 저장돼요."));
  }
  if (!cloudOn()) {
    return el("section", { class: "card online" }, el("div", { class: "k" }, "온라인 함께하기"),
      el("p", { class: "limit" }, "닉네임만 정하면 같은 나무의 공동보호자와 대화하고, 우리 동네 순위에 활동이 더해져요."),
      el("div", { class: "row" }, el("button", { type: "button", class: "btn small", onclick: joinDialog }, "참여하기")));
  }
  const box = el("section", { class: "card online" }, el("div", { class: "row between" }, el("div", { class: "k" }, `온라인 · ${state.profile.nickname}${state.profile.dong ? " · " + state.profile.dong : ""}`),
    el("button", { type: "button", class: "btn ghost small", onclick: () => dialog("온라인을 끌까요?", el("p", { class: "dialog-body" }, "이 기기의 기록은 남고, 서버에 올린 기록도 지워지지 않아요. 다시 참여하면 새 익명 계정이 돼요."), { confirm: "끄기", onConfirm: async () => { await leaveOnline(); renderSNS(); } }) }, "끄기")),
    el("div", { id: "rankBox" }, el("p", { class: "small" }, "동네 순위를 불러오는 중…")));
  loadRankings(box.querySelector("#rankBox"));
  return box;
}
async function loadRankings(target) {
  try {
    const [rows, mine] = await Promise.all([cloud.api.rankings(10), cloud.api.myScore()]);
    const me = state.profile.dong;
    target.replaceChildren(
      mine ? el("p", { class: "small" }, `내 활동 ${nf(mine.activities)}건 · ${nf(mine.points)}점 · 감축 ${massText(Number(mine.kg))}`) : null,
      el("h3", {}, "동네 순위 (최근 30일)"),
      rows?.length ? el("div", { class: "tablebox" }, el("table", { class: "rank" },
        el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "동"), el("th", { class: "r" }, "보호자"), el("th", { class: "r" }, "활동"), el("th", { class: "r" }, "점수"), el("th", { class: "r" }, "감축"))),
        el("tbody", {}, ...rows.map(r => el("tr", { class: r.dong === me ? "me" : null },
          el("td", { class: "num" }, r.rank), el("td", {}, r.dong), el("td", { class: "r num" }, nf(r.guardians)), el("td", { class: "r num" }, nf(r.activities)),
          el("td", { class: "r num" }, nf(r.points)), el("td", { class: "r num" }, massText(Number(r.kg))))))))
        : el("p", { class: "small" }, "아직 순위에 오른 동네가 없어요. 첫 활동을 기록하면 우리 동네가 올라가요."));
  } catch (err) {
    target.replaceChildren(el("p", { class: "small" }, `순위를 불러오지 못했어요 (${err.message})`));
  }
}

// ---------- 공통 ----------
function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text; t.classList.toggle("bad", bad); t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2800);
}
function show(name) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== `s-${name}`;
  document.body.classList.toggle("intro-mode", name === "intro");
  for (const a of document.querySelectorAll(".tabbar a")) a.setAttribute("aria-current", a.dataset.screen === name ? "page" : "false");
  $("#topbarTitle").textContent = TITLES[name] || "";
  window.scrollTo(0, 0);
}
const setTitle = text => { $("#topbarTitle").textContent = text; };
// 뒤로 가기: 앱 안에서 온 길이 있으면 그 길로, 처음 열었으면 상위 화면으로
const TITLES = { city: "전주 현황", near: "동네 찾기", sns: "내 나무", tree: "나무", chat: "대화", group: "보호자 방", photo: "사진과 캐릭터", ar: "AR 보기" };
const PARENT = { city: "#intro", near: "#city", sns: "#city", tree: "#sns", chat: "#tree", group: "#tree", photo: "#tree", ar: "#photo" };
const navStack = [];
function goBack() {
  const [name, arg] = (location.hash.slice(1) || "intro").split("/");
  if (navStack.length > 1) { navStack.pop(); navStack.pop(); history.back(); return; }
  const parent = PARENT[name] || "#intro";
  go(arg && ["#tree", "#photo"].includes(parent) ? `${parent}/${arg}` : parent);
}
function route() {
  const [name, arg] = (location.hash.slice(1) || "intro").split("/");
  const id = arg ? decodeURIComponent(arg) : null;
  const here = location.hash || "#intro";
  if (navStack[navStack.length - 1] !== here) navStack.push(here);
  if (name === "city") renderCity();
  else if (name === "near") renderNear();
  else if (name === "sns") renderSNS();
  else if (name === "tree" && id) renderTree(id);
  else if (name === "chat" && id) renderChat(id);
  else if (name === "group" && id) renderGroup(id);
  else if (name === "photo" && id) renderPhoto(id);
  else if (name === "ar" && id) renderAR(id);
  else { renderIntro(); show("intro"); return; }
  if (name !== "group") { clearInterval(pollTimer); pollTimer = null; }
  if (name !== "ar") stopCamera();
  show(name);
}
const go = hash => { location.hash = hash; };
function treeRecord(i) {
  const species = T.species[T.sp[i]], info = S.species_info[species];
  const annual = T.seq[1][i] ?? T.point_seq[i] ?? 0;
  return { i, id: T.id[i], species, info, road: T.roads[T.rd[i]], dong: T.dong?.[i] != null ? T.dongs[T.dong[i]] : null,
    section: T.sec?.[i] != null ? T.sections[T.sec[i]] : null, grade: T.grades[T.grade[i]], dbh: T.dbh[i], block: Boolean(T.block[i]),
    seq: T.seq.map(a => a[i]), annualKg: annual, lon: T.lon[i], lat: T.lat[i], heightM: T.dbh[i] ? estimateForm(T.dbh[i], info, FORM).h : null };
}
const timeAgo = iso => {
  const d = (Date.now() - new Date(iso)) / 60000;
  if (d < 1) return "방금"; if (d < 60) return `${Math.floor(d)}분 전`; if (d < 1440) return `${Math.floor(d / 60)}시간 전`;
  if (d < 1440 * 7) return `${Math.floor(d / 1440)}일 전`;
  return iso.slice(0, 10);
};
const dayKey = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
function levelOf(points) {
  let lv = ACT.levels[0];
  for (const l of ACT.levels) if (points >= l.min) lv = l;
  const next = ACT.levels.find(l => l.min > points);
  return { name: lv.name, next: next ? next.min - points : null };
}
const MOOD_KO = { happy: "기분 좋아요", thirsty: "목이 말라요", hot: "더워요", cold: "추워요", sleepy: "겨울잠 중", proud: "뿌듯해요", sad: "오랜만이에요" };
const SEASON_KO = { spring: "봄", summer: "여름", autumn: "가을", winter: "겨울" };
// 잘리지 않은 캐릭터 전신 그림
function figure(rec, { size = 140, mood = "happy", caption = null } = {}) {
  const f = el("figure", { class: "tree-fig sway" }, svg(treeSVG({ species: rec.species, info: rec.info, dbh: rec.dbh || 15, form: FORM, season, style: "character", mood, seed: hashSeed(rec.id), size, label: rec.name || rec.species })));
  if (caption !== null) f.append(el("figcaption", {}, caption));
  return f;
}
function avatar(rec, { size = 56, mood = "happy", style = "character" } = {}) {
  const a = el("span", { class: "avatar", style: `--size:${size}px` });
  a.append(svg(treeSVG({ species: rec.species, info: rec.info, dbh: rec.dbh || 15, form: FORM, season, style, mood, seed: hashSeed(rec.id), size: size * 1.5, label: rec.name || rec.species })));
  return a;
}
function weatherChip() {
  if (!weather) return el("span", { class: "chip weather", "data-weather": "" }, "날씨 불러오는 중");
  const w = weatherLabel(weather.current.code);
  return el("span", { class: "chip weather", "data-weather": "" }, `${w.icon} 전주 ${w.text} ${Math.round(weather.current.temp)}℃`);
}
function renderWeatherChips() { for (const c of document.querySelectorAll("[data-weather]")) c.replaceWith(weatherChip()); }
function treeMood(rec, posts) {
  const lastCare = posts.find(p => p.kind === "care");
  const lastCareDays = lastCare ? (Date.now() - new Date(lastCare.t)) / DAY : null;
  return moodFor({ season, weather: weather?.flags, lastCareDays });
}

// ---------- 내 나무 상태 ----------
async function refreshMine() {
  const rows = await db.allTrees();
  state.my = rows.map(r => { const i = T.id.indexOf(r.id); return i < 0 ? null : { ...treeRecord(i), ...r }; }).filter(Boolean)
    .sort((a, b) => (a.since < b.since ? 1 : -1));
  state.posts = await db.allPosts();
}
const myTree = id => state.my.find(t => t.id === id);
const postsOf = id => state.posts.filter(p => p.treeId === id);
const practiceKg = posts => posts.reduce((a, p) => a + (p.kg || 0), 0);
// 돌봄 뒤 care_effect_days 동안의 일일 흡수량 합
function protectedKg(rec, posts) {
  const days = new Set();
  const span = ACT.protection?.care_effect_days ?? 7;
  const today = new Date();
  for (const p of posts) {
    if (p.kind !== "care") continue;
    const d = new Date(p.t);
    for (let k = 0; k < span; k++) {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
      if (x <= today) days.add(dayKey(x));
    }
  }
  let sum = 0;
  for (const key of days) { const [y, m, d] = key.split("-").map(Number); sum += dailyUptake(rec.annualKg, new Date(y, m - 1, d), P); }
  return sum;
}
async function importLegacyGuardians() {
  if (await db.getMeta("imported-legacy")) return;
  try {
    const ids = JSON.parse(localStorage.getItem("wg-guardian") || "[]");
    for (const id of ids) {
      const i = T.id.indexOf(id);
      if (i < 0 || await db.getTree(id)) continue;
      const rec = treeRecord(i);
      await db.putTree({ id, name: NICKNAMES[archetype(rec.species, rec.info)][0], since: new Date().toISOString(), points: 0 });
    }
  } catch { /* 옛 기록 없음 */ }
  await db.setMeta("imported-legacy", true);
}

// ---------- 1. 인트로 ----------
function renderIntro() {
  const box = $("#s-intro");
  if (box.dataset.ready) return;
  box.dataset.ready = "1";
  const top = S.species.slice(0, 9);
  const maxCount = top[0].count;
  const skyline = el("div", { class: "skyline sway", "aria-hidden": "true" },
    ...top.map((s, k) => {
      const info = S.species_info[s.species];
      const size = Math.round(64 + 96 * Math.sqrt(s.count / maxCount));
      const node = svg(treeSVG({ species: s.species, info, dbh: s.median_dbh, form: FORM, season, style: "character", mood: ["happy", "proud", "happy", "sleepy"][k % 4], seed: hashSeed(s.species), size }));
      node.style.animationDelay = `${(k * 0.7) % 4}s`;
      return el("figure", { class: "skyline-item", style: `--delay:${(k * 0.7) % 4}s` }, node,
        el("figcaption", {}, el("b", {}, s.species), el("span", { class: "num" }, `${nf(s.count)}그루`)));
    }));
  const total = S.quality.on_map, seq = S.totals.seq_t;
  box.replaceChildren(
    el("div", { class: "intro-sky" }),
    el("div", { class: "intro-inner" },
      el("p", { class: "eyebrow" }, "전주시 · 시민참여형 가로수 돌봄"),
      el("h1", { class: "intro-title" }, "우리동네", el("br"), "가로수"),
      el("p", { class: "intro-lede" }, `전주 가로수 ${nf(total)}그루가 한 해 약 ${nf(seq[1])}톤의 CO₂를 들이마셔요. 우리 동네 나무와 친구가 되어 돌보고, 그 변화를 함께 기록해요.`),
      skyline,
      el("div", { class: "ground" }),
      el("div", { class: "intro-actions" },
        el("a", { class: "btn big", href: "#city" }, "시작하기"),
        state.my.length ? el("a", { class: "btn big ghost", href: "#sns" }, `내 나무 ${state.my.length}그루 보기`) : el("a", { class: "btn big ghost", href: "#near" }, "우리동네 나무 찾기")),
      el("p", { class: "intro-foot" }, "탄소 수치는 공공데이터로 추정한 값(검증 전)입니다 · ", el("a", { href: "map.html" }, "지도 보기"), " · ", el("a", { href: "report/jeonju.html" }, "데이터 보고서"))));
}

// ---------- 2. 전주 현황 ----------
function renderCity() {
  const box = $("#s-city");
  clearInterval(tickTimer);
  const annualKg = S.totals.seq_t[1] * 1000, lo = S.totals.seq_t[0], hi = S.totals.seq_t[2];
  const today = new Date();
  const todayKg = dailyUptake(annualKg, today, P);
  const yearKg = cumulativeThisYear(annualKg, today, P);
  const win = seasonWindow(P), doy = dayOfYear(today);
  const inSeason = doy >= win.start && doy <= win.end;
  const fmt = v => (v >= 1000 ? `${nf(v / 1000, 2)} t` : `${nf(v, 0)} kg`);
  const live = el("div", { class: "hero-num num" }, fmt(todayKg));
  const liveSub = el("div", { class: "hero-sub" });
  const tick = () => {
    const now = new Date();
    const frac = Math.min(1, Math.max(0, (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600 - 6) / 13)); // 06–19시 낮 동안 고르게
    liveSub.textContent = inSeason ? `오늘 하루 예상치 · 지금까지 약 ${fmt(todayKg * frac)} (낮 06–19시에 고르게 흡수한다고 가정)` : "겨울에는 잎이 없어 흡수량을 0으로 봅니다";
  };
  tick();
  tickTimer = setInterval(tick, 1000);
  // 한 해 그래프
  const prof = yearProfile(annualKg, today.getFullYear(), P);
  const W = 600, H = 120, max = Math.max(...prof);
  const path = prof.map((v, k) => `${k === 0 ? "M" : "L"}${(k / 364 * W).toFixed(1)} ${(H - 8 - v / max * (H - 24)).toFixed(1)}`).join(" ");
  const x = (doy - 1) / 364 * W;
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const spark = svg(`<svg viewBox="0 0 ${W} ${H + 18}" class="spark" role="img" aria-label="한 해 동안의 일일 흡수량 곡선과 오늘 위치">
    <rect x="${((win.start - 1) / 364 * W).toFixed(1)}" y="8" width="${(win.length / 364 * W).toFixed(1)}" height="${H - 16}" fill="var(--accent-soft)" rx="6"/>
    <path d="${path} L${W} ${H - 8} L0 ${H - 8} Z" fill="var(--accent)" opacity="0.18"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    <line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="4" y2="${H - 8}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>
    <text x="${x.toFixed(1)}" y="${H + 12}" font-size="11" text-anchor="middle" fill="var(--ink)">오늘</text>
    ${months.map(m => `<text x="${((new Date(today.getFullYear(), m - 1, 15) - new Date(today.getFullYear(), 0, 1)) / DAY / 364 * W).toFixed(1)}" y="${H + 12}" font-size="10" text-anchor="middle" fill="var(--muted)">${m === Math.round(doy / 30.4 + 0.5) ? "" : m + "월"}</text>`).join("")}
  </svg>`);
  const speciesRow = el("div", { class: "species-row" }, ...S.species.slice(0, 12).map(s => {
    const info = S.species_info[s.species];
    const dayKg = dailyUptake(s.total_seq_t[1] * 1000, today, P);
    return el("div", { class: "sp-card" }, svg(treeSVG({ species: s.species, info, dbh: s.median_dbh, form: FORM, season, style: "character", seed: hashSeed(s.species), size: 84 })),
      el("b", {}, s.species), el("span", { class: "num" }, `${nf(s.count)}그루`), el("span", { class: "sub num" }, `오늘 ${dayKg >= 1000 ? nf(dayKg / 1000, 2) + "t" : nf(dayKg) + "kg"}`));
  }));
  box.replaceChildren(el("div", { class: "page-inner" },
    el("header", { class: "screen-head" }, el("div", {}, el("p", { class: "eyebrow" }, "2단계 · 전주 가로수 지금"), el("h1", {}, "오늘 전주 가로수가 들이마시는 CO₂")), weatherChip()),
    el("div", { class: "hero" }, live, liveSub),
    el("div", { class: "kpis tight" },
      kpi("가로수", nf(S.quality.on_map), "그루", "산림청 2025-08-26판, 전주 경계 안"),
      kpi("올해 누적 흡수", nf(yearKg / 1000, 0), "t", `1월 1일부터 오늘까지(추정)`),
      kpi("한 해 흡수", nf(S.totals.seq_t[1]), "t/년", `80% 범위 ${nf(lo)}–${nf(hi)} t`),
      kpi("CO₂ 저장량", nf(S.totals.storage_t[1]), "t", "줄기·가지·뿌리에 쌓인 양")),
    el("section", { class: "card" }, el("div", { class: "k" }, "하루 흡수량은 계절을 따라 변해요"), spark,
      el("p", { class: "limit" }, `연간 흡수량을 서리 없는 ${win.length}일(4월 ${win.start - 90}일쯤부터 10월 말)에 나눠 배분한 가정값입니다. 한여름에 가장 많고 겨울에는 0입니다.`)),
    el("h2", {}, "수종별 캐릭터"), el("p", { class: "small" }, "전주 가로수의 수종을 캐릭터로 요약했어요. 크기는 수종의 흉고 중앙값을 따릅니다."),
    speciesRow,
    el("div", { class: "cta" }, el("a", { class: "btn big", href: "#near" }, "우리동네 가로수와 친구 맺기 →")),
    el("p", { class: "notice" }, el("b", {}, "계수 검증 전 · 방법 시연용 "), "탄소 수치는 일부 가정값으로 계산한 추정 범위입니다. ", el("a", { href: "report/jeonju.html" }, "데이터 보고서"))));
}
function kpi(label, value, unit, sub) {
  return el("div", { class: "kpi" }, el("div", { class: "label" }, label), el("div", { class: "value num" }, value, unit ? el("small", {}, unit) : null), el("div", { class: "sub" }, sub));
}

// ---------- 3. 동네 찾기 ----------
function renderNear() {
  const box = $("#s-near");
  if (!box.dataset.ready) {
    box.dataset.ready = "1";
    const input = el("input", { id: "addr", type: "search", list: "placeList", placeholder: "동·도로·주소 (예: 효자동 백제대로, 명륜1길 10)", autocomplete: "off", "aria-label": "동네 주소" });
    const list = el("datalist", { id: "placeList" });
    input.addEventListener("input", () => {
      list.replaceChildren(...searchPlaces(PLACES, input.value).map(p => el("option", { value: p.name }, `${p.kind === "dong" ? "동" : "도로"} · ${nf(p.count)}그루`)));
    });
    const form = el("form", { class: "addr-form", onsubmit: async e => { e.preventDefault(); await findByText(input.value); } },
      el("label", { class: "field grow" }, input), list,
      el("button", { type: "submit", class: "btn" }, "찾기"),
      el("button", { type: "button", class: "btn ghost", onclick: findByGPS }, "내 위치"));
    const radius = el("div", { class: "seg", role: "group", "aria-label": "반경" }, ...[200, 300, 500].map(r => el("button", { type: "button", "aria-pressed": String(r === state.near.radius), onclick: () => { state.near.radius = r; for (const b of radius.children) b.setAttribute("aria-pressed", String(Number(b.dataset.r) === r)); if (state.near.center) runNear(); }, "data-r": r }, `${r}m`)));
    box.replaceChildren(el("div", { class: "page-inner" },
      el("header", { class: "screen-head" }, el("div", {}, el("p", { class: "eyebrow" }, "3단계 · 우리동네 가로수"), el("h1", {}, "내가 사는 곳 근처의 나무")), weatherChip()),
      el("p", { class: "small" }, "동 이름, 도로 이름, 번지까지 넣을 수 있어요. 번지·건물은 OpenStreetMap에서 찾습니다."),
      form, el("div", { class: "row between" }, el("div", { id: "nearLabel", class: "small" }), radius),
      el("div", { id: "nearResults" })));
    const q = new URLSearchParams(location.hash.split("?")[1] || "").get("q");
    if (q) { input.value = q; findByText(q); }
    else if (state.my.length) {
      // 내 나무가 있으면 그 주변부터 보여 준다
      const t = state.my[0];
      state.near.center = { lon: t.lon, lat: t.lat }; state.near.label = `${t.name} 주변`;
      runNear();
    }
  }
}
async function findByText(q) {
  q = (q || "").trim();
  if (!q) return;
  const local = searchPlaces(PLACES, q, 1)[0];
  const words = q.split(/\s+/).filter(Boolean);
  // 동·도로 이름만이면 색인으로, 숫자(번지)나 모르는 말이 섞이면 지오코딩
  const exact = local && words.every(w => local.name.includes(w));
  if (exact) {
    state.near.center = { lon: local.lon, lat: local.lat }; state.near.label = `${local.name}(${local.kind === "dong" ? "동 중심" : "도로 중심"}) 주변`;
    return runNear();
  }
  $("#nearLabel").textContent = "주소를 찾는 중…";
  const hits = await geocode(q);
  const hit = hits.find(h => insideJeonju(h.lon, h.lat));
  if (hit) {
    state.near.center = { lon: hit.lon, lat: hit.lat }; state.near.label = `${hit.name} 주변`;
    return runNear();
  }
  if (local) {
    state.near.center = { lon: local.lon, lat: local.lat }; state.near.label = `${local.name} 주변 (주소는 못 찾아 가까운 ${local.kind === "dong" ? "동" : "도로"}으로)`;
    return runNear();
  }
  $("#nearLabel").textContent = "";
  toast("찾지 못했어요. 동 이름이나 도로 이름으로 다시 넣어 보세요.", true);
}
async function findByGPS() {
  try {
    const pos = await locate();
    if (!insideJeonju(pos.lon, pos.lat)) { toast("지금 위치가 전주 밖이에요. 주소로 찾아 주세요.", true); return; }
    state.near.center = pos; state.near.label = `내 위치 주변(오차 ±${Math.round(pos.acc)}m)`;
    runNear();
  } catch (e) { toast(e.message, true); }
}
function runNear() {
  const { center, radius } = state.near;
  state.near.results = nearestTrees(T, center.lon, center.lat, { radius, limit: 40 });
  state.near.picked = null;
  $("#nearLabel").textContent = `${state.near.label} · 반경 ${radius}m 안 ${nf(state.near.results.length)}그루${state.near.results.length === 40 ? "(가까운 40그루만)" : ""}`;
  renderStreet();
}
function renderStreet() {
  const out = $("#nearResults");
  const res = state.near.results;
  if (!res.length) { out.replaceChildren(el("p", { class: "empty" }, "이 반경 안에는 등록된 가로수가 없어요. 반경을 넓히거나 다른 곳을 찾아 보세요.")); return; }
  const mine = new Set(state.my.map(t => t.id));
  const strip = el("div", { class: "street", role: "list" }, ...res.map(({ i, d }) => {
    const r = treeRecord(i);
    const size = Math.round(120 + Math.min(1, (r.dbh || 10) / 50) * 120);
    const item = el("button", { type: "button", class: "tree-slot", role: "listitem", "aria-pressed": "false", "data-i": i, onclick: () => pickNear(i, item) },
      svg(treeSVG({ species: r.species, info: r.info, dbh: r.dbh || 10, form: FORM, season, style: "real", seed: hashSeed(r.id), size, label: `${r.species}, ${Math.round(d)}m` })),
      el("span", { class: "slot-label" }, el("b", {}, r.species), el("span", { class: "num" }, `${Math.round(d)}m`), mine.has(r.id) ? el("span", { class: "tag" }, "내 나무") : null));
    return item;
  }));
  const mapBox = el("div", { class: "minimap", id: "nearMap", role: "region", "aria-label": "근처 가로수 지도" });
  out.replaceChildren(mapBox,
    el("p", { class: "small" }, "주황 점이 기준 위치, 초록 점이 가로수예요. 지도나 아래 그림에서 나무를 누르면 자세히 보고 친구를 맺을 수 있어요."),
    el("div", { class: "street-wrap" }, el("div", { class: "street-sky" }), strip, el("div", { class: "street-ground" })),
    el("p", { class: "small" }, "가까운 순서로 늘어놓았어요. 모양은 흉고로 추정한 그림입니다."),
    el("div", { id: "nearCard" }));
  // 위치 지도: 기준 위치와 근처 나무를 그대로 찍는다
  state.near.map?.remove();
  state.near.map = null;
  const { center } = state.near;
  createMiniMap(mapBox, { center: [center.lon, center.lat], zoom: 17, token, onSelect: i => pickNear(Number(i)) }).then(mm => {
    if (!document.body.contains(mapBox)) { mm.remove(); return; }
    state.near.map = mm;
    mm.setCenter(center);
    mm.setTrees(res.map(({ i }) => ({ i, lon: T.lon[i], lat: T.lat[i], label: T.species[T.sp[i]] })));
    mm.fit([center, ...res.map(({ i }) => ({ lon: T.lon[i], lat: T.lat[i] }))], 36);
    if (state.near.picked !== null) { const r = treeRecord(state.near.picked); mm.setSelected({ lon: r.lon, lat: r.lat }); }
  }).catch(err => { mapBox.replaceChildren(el("p", { class: "empty" }, `지도를 불러오지 못했어요 (${err.message})`)); });
}
// 실물 확인용 식별 정보
function identRows(r, extra = []) {
  return el("dl", { class: "meta ident" },
    el("dt", {}, "관리번호"), el("dd", { class: "num" }, `${r.id} (산림청 시군구별 번호)`),
    el("dt", {}, "도로"), el("dd", {}, r.road),
    r.section ? el("dt", {}, "구간") : null, r.section ? el("dd", {}, r.section) : null,
    r.dong ? el("dt", {}, "동") : null, r.dong ? el("dd", {}, r.dong) : null,
    el("dt", {}, "좌표"), el("dd", { class: "num" }, `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`),
    el("dt", {}, "흉고직경"), el("dd", {}, r.dbh ? `${nf(r.dbh)}cm${r.block ? " (같은 구간 대표값 의심)" : ""}` : "없음"),
    el("dt", {}, "데이터 품질"), el("dd", {}, `등급 ${r.grade}`),
    ...extra);
}
function mapLinks(r, name) {
  const label = encodeURIComponent(`${name || r.species} 가로수 ${r.id}`);
  return el("div", { class: "map-links" },
    el("a", { href: `https://map.kakao.com/link/map/${label},${r.lat},${r.lon}`, target: "_blank", rel: "noopener" }, "카카오맵에서 보기"),
    el("a", { href: `https://map.kakao.com/link/to/${label},${r.lat},${r.lon}`, target: "_blank", rel: "noopener" }, "카카오맵 길찾기"),
    el("a", { href: `https://www.google.com/maps?q=${r.lat},${r.lon}`, target: "_blank", rel: "noopener" }, "구글 지도"),
    el("a", { href: `map.html#tree-${encodeURIComponent(r.id)}` }, "전체 지도(연구용)"));
}
function pickNear(i, item = null) {
  item = item || document.querySelector(`.tree-slot[data-i="${i}"]`);
  for (const b of document.querySelectorAll(".tree-slot")) b.setAttribute("aria-pressed", "false");
  item?.setAttribute("aria-pressed", "true");
  item?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  const r = treeRecord(i);
  const mine = myTree(r.id);
  state.near.picked = i;
  state.near.map?.setSelected({ lon: r.lon, lat: r.lat }, true);
  const dist = state.near.center ? distanceM(state.near.center.lon, state.near.center.lat, r.lon, r.lat) : null;
  const card = $("#nearCard");
  card.replaceChildren(el("div", { class: "card tree-card" },
    el("div", { class: "tree-card-head" }, figure(mine || r, { size: 120, caption: mine ? mine.name : "캐릭터" }),
      el("div", {}, el("h2", {}, mine ? `${mine.name} (${r.species})` : r.species), el("div", { class: "id" }, `관리번호 ${r.id}${dist !== null ? ` · 기준 위치에서 ${Math.round(dist)}m` : ""}`),
        el("p", { class: "small" }, mine ? "이미 내 나무예요." : "친구가 되면 이 캐릭터가 내 나무가 돼요."))),
    identRows(r, [
      el("dt", {}, "모양(추정)"), el("dd", {}, r.dbh ? `높이 약 ${nf(r.heightM)}m` : "-"),
      el("dt", {}, "한 해 CO₂ 흡수"), el("dd", { class: "num" }, r.seq[1] !== null ? `${kg(r.seq[0])}~${kg(r.seq[2])} kg (추정)` : "계산 안 됨")]),
    mapLinks(r, mine?.name),
    el("p", { class: "story" }, `저는 ${r.road}에 서 있는 ${josa(r.species, "이에요", "예요")}. ${r.dbh ? `줄기 지름은 ${nf(r.dbh)}cm쯤이에요.` : ""} ${r.block ? "제 흉고는 아직 아무도 직접 재지 않은 대표값이에요." : ""}`),
    el("div", { class: "row" },
      mine ? el("a", { class: "btn", href: `#tree/${encodeURIComponent(r.id)}` }, "내 나무 보기") : el("button", { type: "button", class: "btn", onclick: () => befriend(r) }, "친구 맺기 · 보호자 되기"),
      view3dButton(r))));
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function view3dButton(r) {
  const btn = el("button", { type: "button", class: "btn ghost" }, "3D · AR");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { openTreeViewer } = await import("./tree3d.js");
      const { jenkins_group, alt_group, growth_class, mature_height_class } = r.info;
      openTreeViewer({ tree: { id: r.id, species: r.species, info: r.info, model: { jenkins_group, alt_group, growth_class, mature_height_class, dbh: r.dbh, block: r.block } }, P, form: FORM, token });
    } catch (e) { console.error(e); toast("3D를 열지 못했어요. 네트워크를 확인해 주세요.", true); }
    finally { btn.disabled = false; }
  });
  return btn;
}

// ---------- 친구 맺기 ----------
function dialog(title, body, { confirm = "확인", cancel = "취소", onConfirm }) {
  const d = el("dialog", { class: "sheet-dialog" });
  const form = el("form", { method: "dialog", class: "dialog-form" }, el("h2", {}, title), body,
    el("div", { class: "row end" }, cancel ? el("button", { type: "button", class: "btn ghost", onclick: () => d.close() }, cancel) : null, el("button", { type: "submit", class: "btn" }, confirm)));
  form.addEventListener("submit", async e => { e.preventDefault(); const ok = await onConfirm(form); if (ok !== false) d.close(); });
  d.append(form);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
function befriend(r) {
  const names = NICKNAMES[archetype(r.species, r.info)] || NICKNAMES.generic;
  const input = el("input", { type: "text", name: "name", maxlength: "12", required: true, value: names[Math.floor(Math.random() * names.length)], "aria-label": "나무 이름" });
  const preview = figure(r, { size: 150, mood: "proud", caption: input.value });
  input.addEventListener("input", () => { preview.querySelector("figcaption").textContent = input.value || "…"; });
  dialog("나무 이름 짓기", el("div", { class: "dialog-body" },
    el("div", { class: "preview" }, preview),
    el("p", {}, `${r.road}의 ${josa(r.species, "과", "와")} 친구가 돼요. 이름을 지어 주세요.`),
    el("div", { class: "row" }, input, ...names.map(n => el("button", { type: "button", class: "chip btn-chip", onclick: () => { input.value = n; input.dispatchEvent(new Event("input")); } }, n))),
    el("p", { class: "hint" }, cloudOn() ? "내 나무는 이 기기에 저장되고, 온라인에도 올라가요." : "보호자 기록은 이 기기의 브라우저에 저장돼요.")), {
    confirm: "친구 맺기",
    onConfirm: async form => {
      const name = form.name.value.trim();
      if (!name) return false;
      const rec = { id: r.id, name, since: new Date().toISOString(), points: 0 };
      await db.putTree(rec);
      await refreshMine();
      const t = myTree(r.id);
      if (cloudOn()) cloud.api.follow({ id: t.id, name, species: t.species, dong: t.dong, since: rec.since }).catch(err => console.warn("서버 친구 맺기 실패", err));
      const ctx = chatContext(t);
      await db.addMessage({ treeId: r.id, t: new Date().toISOString(), from: "tree", text: greeting(ctx) });
      const p = proactive(ctx);
      if (p) await db.addMessage({ treeId: r.id, t: new Date(Date.now() + 1000).toISOString(), from: "tree", text: p.text, activity: p.activity });
      toast(`${josa(name, "과", "와")} 친구가 되었어요`);
      go(`#tree/${encodeURIComponent(r.id)}`);
    },
  });
  setTimeout(() => input.select(), 50);
}

// ---------- 4. SNS 홈 ----------
async function renderSNS() {
  await refreshMine();
  const box = $("#s-sns");
  if (!state.my.length) {
    const sample = S.species[0];
    box.replaceChildren(el("div", { class: "page-inner" },
      el("header", { class: "screen-head" }, el("div", {}, el("p", { class: "eyebrow" }, "4단계 · 나무 SNS"), el("h1", {}, "내 나무")), weatherChip()),
      el("div", { class: "empty-state" }, svg(treeSVG({ species: sample.species, info: S.species_info[sample.species], dbh: sample.median_dbh, form: FORM, season, mood: "sad", size: 150 })),
        el("p", {}, "아직 친구가 된 나무가 없어요. 우리 동네 가로수를 찾아 첫 친구를 맺어 보세요."),
        el("a", { class: "btn big", href: "#near" }, "우리동네 나무 찾기"))));
    return;
  }
  const today = new Date();
  const totals = state.my.reduce((acc, t) => {
    const posts = postsOf(t.id);
    acc.year += uptakeBetween(t.annualKg, new Date(t.since), today, P);
    acc.practice += practiceKg(posts);
    acc.protected += protectedKg(t, posts);
    acc.points += t.points || 0;
    return acc;
  }, { year: 0, practice: 0, protected: 0, points: 0 });
  const lv = levelOf(totals.points);
  const stories = el("div", { class: "my-trees" }, ...state.my.map(t => {
    const mood = treeMood(t, postsOf(t.id));
    return el("a", { class: "my-tree", href: `#tree/${encodeURIComponent(t.id)}` }, figure(t, { size: 120, mood }), el("b", {}, t.name), el("span", { class: "sub" }, `${t.species} · ${MOOD_KO[mood]}`));
  }), el("a", { class: "my-tree add", href: "#near" }, el("span", { class: "add-box" }, "+"), el("b", {}, "친구 추가")));
  const feed = el("div", { class: "feed" }, ...(state.posts.length ? state.posts.map(postCard) : [el("p", { class: "empty" }, "아직 기록이 없어요. 나무를 눌러 돌봄이나 생활 실천을 기록해 보세요.")]));
  box.replaceChildren(el("div", { class: "page-inner" },
    el("header", { class: "screen-head" }, el("div", {}, el("p", { class: "eyebrow" }, "4단계 · 나무 SNS"), el("h1", {}, "내 나무")), weatherChip()),
    stories,
    el("div", { class: "kpis tight" },
      kpi("함께한 뒤 나무가 흡수", ...mass(totals.year), "친구 맺은 날부터(추정)"),
      kpi("돌보는 동안 흡수", ...mass(totals.protected), `돌봄 뒤 ${ACT.protection.care_effect_days}일 기준`),
      kpi("내 생활 실천 감축", ...mass(totals.practice), "실천 기록 환산(추정)"),
      kpi("기여 점수", nf(totals.points), "점", lv.next ? `${lv.name} · 다음까지 ${lv.next}점` : lv.name)),
    onlineCard(),
    el("h2", {}, "기록"), feed));
}
function postCard(p) {
  const t = myTree(p.treeId);
  if (!t) return null;
  const card = el("article", { class: "post" },
    el("header", {}, avatar(t, { size: 36 }), el("div", {}, el("a", { href: `#tree/${encodeURIComponent(t.id)}` }, el("b", {}, t.name)), el("span", { class: "sub" }, ` · ${t.species} · ${timeAgo(p.t)}`))),
    p.photo ? el("img", { class: "post-photo", src: URL.createObjectURL(p.photo), alt: p.label || "사진" }) : null,
    el("p", {}, el("span", { class: "act-icon" }, p.icon || ""), " ", el("b", {}, p.label), p.circ ? ` · 둘레 ${nf(p.circ)}cm` : "", p.text ? ` — ${p.text}` : ""),
    el("div", { class: "badges" }, p.points ? el("span", { class: "badge" }, `+${p.points}점`) : null,
      p.kg ? el("span", { class: "badge green" }, `−${massText(p.kg)} CO₂ (추정)`) : null,
      p.kind === "care" ? el("span", { class: "badge soft" }, "돌봄") : p.kind === "practice" ? el("span", { class: "badge soft" }, "생활 실천") : null));
  return card;
}

// ---------- 나무 프로필 ----------
async function renderTree(id) {
  await refreshMine();
  const t = myTree(id);
  const box = $("#s-tree");
  if (!t) {
    const i = T.id.indexOf(id);
    if (i < 0) { box.replaceChildren(el("div", { class: "page-inner" }, el("p", { class: "empty" }, "나무를 찾을 수 없어요."))); return; }
    const r = treeRecord(i);
    box.replaceChildren(el("div", { class: "page-inner" }, el("div", { class: "card tree-card" }, el("div", { class: "tree-card-head" }, avatar(r, { size: 72 }), el("div", {}, el("h2", {}, r.species), el("div", { class: "id" }, r.road))),
      el("div", { class: "row" }, el("button", { type: "button", class: "btn", onclick: () => befriend(r) }, "친구 맺기 · 보호자 되기"), el("a", { class: "btn ghost", href: "#near" }, "동네 찾기")))));
    return;
  }
  const posts = postsOf(id);
  const today = new Date();
  const todayKg = dailyUptake(t.annualKg, today, P), yearKg = uptakeBetween(t.annualKg, new Date(t.since), today, P);
  const prot = protectedKg(t, posts), prac = practiceKg(posts);
  const lv = levelOf(t.points || 0);
  const days = Math.max(1, Math.floor((today - new Date(t.since)) / DAY) + 1);
  const mood = treeMood(t, posts);
  const measured = posts.find(p => p.circ);
  const lastCare = posts.find(p => p.kind === "care");
  const sug = careSuggestions({ weather, season, measured: Boolean(measured), lastCareDays: lastCare ? (Date.now() - new Date(lastCare.t)) / DAY : null, species: t.species });
  const nameBtn = el("button", { type: "button", class: "name-btn", onclick: () => renameTree(t), title: "이름 바꾸기" }, el("h1", {}, t.name), el("span", { class: "edit" }, "✎"));
  setTitle(t.name);
  box.replaceChildren(el("div", { class: "page-inner" },
    el("div", { class: "row end" }, weatherChip()),
    el("div", { class: "profile-head" }, figure(t, { size: 150, mood }),
      el("div", { class: "profile-info" }, nameBtn,
        el("div", { class: "sub" }, `${t.species} · ${t.road}${t.dong ? " · " + t.dong : ""}`),
        el("div", { class: "sub" }, `친구 ${days}일째 · ${lv.name} · ${nf(t.points || 0)}점`),
        el("div", { class: "mood" }, MOOD_KO[mood]))),
    el("div", { class: "actions" },
      el("a", { class: "btn", href: `#chat/${encodeURIComponent(id)}` }, "💬 메시지"),
      el("button", { type: "button", class: "btn ghost", onclick: () => openActivity(t, "care") }, "🌳 돌봄 기록"),
      el("button", { type: "button", class: "btn ghost", onclick: () => openActivity(t, "practice") }, "🌱 생활 실천"),
      el("button", { type: "button", class: "btn ghost", onclick: () => openActivity(t, "care", "observe") }, "📷 사진 올리기"),
      el("a", { class: "btn ghost", href: `#photo/${encodeURIComponent(id)}` }, "🖼️ 사진·캐릭터·AR"),
      view3dButton(t)),
    el("section", { class: "card where" }, el("div", { class: "k" }, "이 나무가 서 있는 곳"),
      el("div", { class: "minimap small", id: "treeMap", role: "region", "aria-label": `${t.name} 위치 지도` }),
      identRows(t), mapLinks(t, t.name),
      el("p", { class: "limit" }, "공공데이터의 좌표와 관리번호예요. 현장에서 같은 나무인지 확인하려면 관리번호 표찰(있는 경우)과 도로·구간을 함께 보세요.")),
    coGuardianBlock(t),
    el("div", { class: "kpis tight" },
      kpi("오늘 흡수", ...mass(todayKg), "이 나무, 오늘 하루(추정)"),
      kpi("함께한 뒤 흡수", ...mass(yearKg), `${new Date(t.since).toLocaleDateString("ko-KR")}부터`),
      kpi("돌보는 동안 흡수", ...mass(prot), `돌봄 뒤 ${ACT.protection.care_effect_days}일 기준`),
      kpi("내 실천 감축", ...mass(prac), "이 나무와 함께 기록한 실천")),
    sug.length ? el("section", { class: "card suggest" }, el("div", { class: "k" }, `${t.name}의 오늘 부탁`),
      ...sug.map(s => el("div", { class: "sug" }, el("p", {}, s.text, el("span", { class: "why" }, ` (${s.why})`)),
        el("button", { type: "button", class: "btn small", onclick: () => openActivity(t, "care", s.activity) }, "지금 기록")))) : null,
    el("section", { class: "card" }, el("div", { class: "k" }, "한 해 CO₂ 흡수(추정)"),
      el("div", { class: "big num" }, t.seq[1] !== null ? `${kg(t.seq[0])}~${kg(t.seq[2])}` : "-", el("small", {}, "kg/년")),
      el("p", { class: "limit" }, `도시 생육 보정은 해외 기준을 썼고 국내 도시수목 상대생장식이 없어 대리식을 적용했습니다.${t.block ? " 이 구간의 흉고는 대표값으로 보여 범위를 넓게 잡았습니다." : ""}${measured ? ` 내가 잰 둘레 ${nf(measured.circ)}cm(흉고 ${nf(circumferenceToDbh(measured.circ), 1)}cm)가 기록되어 있어요.` : ""}`)),
    el("h2", {}, `${t.name}의 기록 ${posts.length}건`),
    el("div", { class: "feed" }, ...(posts.length ? posts.map(postCard) : [el("p", { class: "empty" }, "첫 기록을 남겨 보세요.")])),
    el("div", { class: "row end" }, el("button", { type: "button", class: "btn ghost small danger", onclick: () => unfriend(t) }, "친구 끊기"))));
  const mapBox = $("#treeMap");
  createMiniMap(mapBox, { center: [t.lon, t.lat], zoom: 18, token }).then(mm => {
    if (!document.body.contains(mapBox)) { mm.remove(); return; }
    mm.setTrees([{ i: t.i, lon: t.lon, lat: t.lat, label: t.name }]);
    mm.setSelected({ lon: t.lon, lat: t.lat });
  }).catch(err => { mapBox.replaceChildren(el("p", { class: "empty" }, `지도를 불러오지 못했어요 (${err.message})`)); });
}
function renameTree(t) {
  const input = el("input", { type: "text", name: "name", maxlength: "12", required: true, value: t.name, "aria-label": "나무 이름" });
  dialog("이름 바꾸기", el("div", { class: "dialog-body" }, input), { confirm: "저장", onConfirm: async form => {
    const name = form.name.value.trim();
    if (!name) return false;
    await db.putTree({ id: t.id, name, since: t.since, points: t.points || 0 });
    if (cloudOn()) cloud.api.follow({ id: t.id, name, species: t.species, dong: t.dong, since: t.since }).catch(() => {});
    await renderTree(t.id);
  } });
  setTimeout(() => input.select(), 50);
}
function unfriend(t) {
  dialog("친구를 끊을까요?", el("p", { class: "dialog-body" }, `${josa(t.name, "과", "와")}의 기록(사진·대화 포함)이 이 기기에서 지워져요.`), { confirm: "끊기", onConfirm: async () => {
    await db.deleteTree(t.id);
    await refreshMine();
    if (cloudOn()) cloud.api.unfollow(t.id).catch(err => console.warn("서버 친구 끊기 실패", err));
    toast(`${josa(t.name, "과", "와")} 헤어졌어요`);
    go("#sns");
  } });
}

// ---------- 활동 기록 ----------
function openActivity(t, kind, presetId = null) {
  const items = kind === "care" ? ACT.care : ACT.practice;
  let picked = presetId ? items.find(a => a.id === presetId) : null;
  const list = el("div", { class: "act-list" }, ...items.map(a => el("button", { type: "button", class: "act", "aria-pressed": String(picked?.id === a.id), onclick: () => { picked = a; for (const b of list.children) b.setAttribute("aria-pressed", String(b === btn)); renderForm(); }, "data-id": a.id },
    el("span", { class: "act-icon" }, a.icon), el("span", { class: "act-label" }, a.label), el("span", { class: "act-sub" }, `+${a.points}점${a.kg ? ` · −${massText(a.kg)}/${a.per}` : a.kg === null ? " · 점수만" : ""}`))));
  const btn = null;
  const formBox = el("div", { class: "act-form" });
  const renderForm = () => {
    for (const b of list.children) b.setAttribute("aria-pressed", String(b.dataset.id === picked?.id));
    if (!picked) { formBox.replaceChildren(); return; }
    formBox.replaceChildren(...[
      picked.hint ? el("p", { class: "hint" }, picked.hint) : null,
      picked.basis ? el("p", { class: "hint" }, `환산 근거: ${picked.basis}`) : null,
      picked.needs === "circ" ? el("div", { class: "row" }, el("input", { type: "number", name: "circ", min: "5", max: "700", step: "0.5", inputmode: "decimal", required: true, placeholder: "둘레 cm", "aria-label": "흉고둘레(cm)" }), el("span", {}, "cm (땅에서 1.2m 높이)")) : null,
      el("label", { class: "file" }, el("span", {}, picked.needs === "photo" ? "사진 (필수)" : "사진 (선택)"), el("input", { type: "file", name: "photo", accept: "image/*", capture: "environment", required: picked.needs === "photo" })),
      el("textarea", { name: "text", maxlength: "200", placeholder: "한마디 (선택)" })].filter(Boolean));
  };
  renderForm();
  dialog(kind === "care" ? `${t.name} 돌봄 기록` : "생활 실천 기록", el("div", { class: "dialog-body" }, list, formBox), { confirm: "기록하기", onConfirm: async form => {
    if (!picked) { toast("활동을 골라 주세요.", true); return false; }
    const file = form.photo?.files?.[0];
    let photo = null;
    if (file) { try { photo = await compressImage(file); } catch (e) { toast(e.message, true); return false; } }
    const circ = form.circ ? Number(form.circ.value) || null : null;
    const post = await saveActivity(t, kind, picked, { photo, circ, text: (form.text.value || "").trim() });
    if (!post) return false;
    toast(`기록했어요 · +${picked.points}점${picked.kg ? ` · −${massText(picked.kg)}` : ""}`);
    // 사진을 올리면 실제 나무와 캐릭터를 나란히 보여 준다
    if (photo) go(`#photo/${encodeURIComponent(t.id)}`);
    else if (location.hash.startsWith("#chat/")) renderChat(t.id);
    else renderTree(t.id);
  } });
}
// 활동 한 건 저장: 하루 한도 → 게시물 → 점수 → 서버 전송 → 나무의 반응. 실패하면 null
async function saveActivity(t, kind, picked, { photo = null, circ = null, text = "", ar = false } = {}) {
  const todayCount = postsOf(t.id).filter(p => p.activity === picked.id && dayKey(new Date(p.t)) === dayKey(new Date())).length;
  if (todayCount >= ACT.daily_limit_per_tree) { toast(`오늘은 '${picked.label}'을(를) 이미 ${todayCount}번 기록했어요.`, true); return null; }
  const post = { treeId: t.id, t: new Date().toISOString(), kind, activity: picked.id, label: picked.label, icon: picked.icon, points: picked.points, kg: picked.kg || 0, text, photo, circ, ar };
  await db.addPost(post);
  const points = (t.points || 0) + picked.points;
  await db.putTree({ id: t.id, name: t.name, since: t.since, points });
  await refreshMine();
  const fresh = myTree(t.id), posts = postsOf(t.id);
  syncPost(post, fresh);
  const ctx = { ...chatContext(fresh), protectedKg: protectedKg(fresh, posts), practiceKg: practiceKg(posts), points, gainedPoints: picked.points, gainedKg: picked.kg || 0 };
  await db.addMessage({ treeId: t.id, t: new Date().toISOString(), from: "tree", text: reaction({ ...picked, kind }, ctx) });
  return post;
}

// ---------- 사진 · 캐릭터 · AR ----------
let arStream = null;
function stopCamera() {
  if (!arStream) return;
  for (const tr of arStream.getTracks()) tr.stop();
  arStream = null;
}
const photosOf = id => postsOf(id).filter(p => p.photo);

// 실제 나무 사진과 캐릭터를 나란히
async function renderPhoto(id) {
  await refreshMine();
  const t = myTree(id);
  const box = $("#s-photo");
  if (!t) { go(`#tree/${encodeURIComponent(id)}`); return; }
  setTitle(`${t.name} · 사진과 캐릭터`);
  const photos = photosOf(id);
  const mood = treeMood(t, postsOf(id));
  let current = photos[0] || null;
  const realPane = el("div", { class: "pane real" });
  const renderReal = () => {
    realPane.replaceChildren(current
      ? el("img", { src: URL.createObjectURL(current.photo), alt: `${t.name} 실제 사진` })
      : el("div", { class: "pane-empty" }, el("p", {}, "아직 실제 사진이 없어요."), el("button", { type: "button", class: "btn small", onclick: () => openActivity(t, "care", "observe") }, "📷 찍어 올리기")),
      el("div", { class: "pane-label" }, current ? `실제 나무 · ${new Date(current.t).toLocaleDateString("ko-KR")}${current.ar ? " · AR" : ""}` : "실제 나무"));
  };
  renderReal();
  const charPane = el("div", { class: "pane char sway" }, svg(treeSVG({ species: t.species, info: t.info, dbh: t.dbh || 15, form: FORM, season, style: "character", mood, seed: hashSeed(t.id), size: 220, label: t.name })),
    el("div", { class: "pane-label" }, `${t.name} 캐릭터 · ${SEASON_KO[season]} · ${MOOD_KO[mood]}`));
  const thumbs = el("div", { class: "thumbs" }, ...photos.map(p => el("button", { type: "button", class: "thumb", "aria-pressed": String(p === current), "data-pid": p.pid,
    onclick: () => { current = p; renderReal(); for (const b of thumbs.children) b.setAttribute("aria-pressed", String(Number(b.dataset.pid) === p.pid)); } },
    el("img", { src: URL.createObjectURL(p.photo), alt: "" }), el("span", {}, new Date(p.t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })))));
  box.replaceChildren(el("div", { class: "page-inner" },
    el("p", { class: "small" }, "왼쪽은 보호자가 찍은 실제 나무, 오른쪽은 같은 나무의 캐릭터예요. 캐릭터는 계절과 오늘 기분에 따라 바뀌어요."),
    el("div", { class: "compare" }, realPane, charPane),
    photos.length > 1 ? thumbs : null,
    el("div", { class: "actions" },
      el("a", { class: "btn", href: `#ar/${encodeURIComponent(id)}` }, "✨ AR로 같이 보기"),
      el("button", { type: "button", class: "btn ghost", onclick: () => openActivity(t, "care", "observe") }, "📷 사진 올리기"),
      view3dButton(t)),
    el("p", { class: "hint" }, "'AR로 같이 보기'는 카메라 화면에 캐릭터를 세워 실제 나무와 함께 찍는 화면이에요. '3D · AR'은 실제 크기의 3D 모형을 띄워요.")));
}

// 카메라 화면 위에 캐릭터를 세워 실제 나무와 함께 찍는다
async function renderAR(id) {
  await refreshMine();
  const t = myTree(id);
  const box = $("#s-ar");
  if (!t) { go(`#tree/${encodeURIComponent(id)}`); return; }
  setTitle(`${t.name} AR 보기`);
  stopCamera();
  const mood = treeMood(t, postsOf(id));
  const stage = el("div", { class: "ar-stage" });
  const video = el("video", { autoplay: true, playsinline: true, muted: true, class: "ar-video" });
  const still = el("img", { class: "ar-video", hidden: true, alt: "" });
  const charSvg = svg(treeSVG({ species: t.species, info: t.info, dbh: t.dbh || 15, form: FORM, season, style: "character", mood, seed: hashSeed(t.id), size: 160, label: t.name }));
  const char = el("div", { class: "ar-char" }, charSvg);
  stage.append(video, still, char);
  const pos = { x: 0.5, y: 0.82, scale: 1 }; // 화면 비율 좌표(발끝 기준)
  const place = () => { const w = stage.clientWidth, h = stage.clientHeight; char.style.left = `${pos.x * w}px`; char.style.top = `${pos.y * h}px`; char.style.transform = `translate(-50%, -100%) scale(${pos.scale})`; };
  let drag = null, pinch = null;
  char.addEventListener("pointerdown", e => { drag = { x0: e.clientX, y0: e.clientY, x: pos.x, y: pos.y }; char.setPointerCapture(e.pointerId); });
  char.addEventListener("pointermove", e => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    pos.x = Math.min(1, Math.max(0, drag.x + (e.clientX - drag.x0) / r.width));
    pos.y = Math.min(1.05, Math.max(0.15, drag.y + (e.clientY - drag.y0) / r.height));
    place();
  });
  for (const ev of ["pointerup", "pointercancel"]) char.addEventListener(ev, () => { drag = null; });
  stage.addEventListener("touchstart", e => { if (e.touches.length === 2) pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), s: pos.scale }; }, { passive: true });
  stage.addEventListener("touchmove", e => {
    if (!pinch || e.touches.length !== 2) return;
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    pos.scale = Math.min(2.5, Math.max(0.4, pinch.s * d / pinch.d)); size.value = pos.scale; place();
  }, { passive: true });
  stage.addEventListener("touchend", () => { pinch = null; }, { passive: true });
  const size = el("input", { type: "range", min: "0.4", max: "2.5", step: "0.05", value: "1", "aria-label": "캐릭터 크기" });
  size.addEventListener("input", () => { pos.scale = Number(size.value); place(); });
  const status = el("p", { class: "small ar-status" }, "카메라를 여는 중…");
  const file = el("input", { type: "file", accept: "image/*", hidden: true });
  let source = null; // "camera" | "image"
  file.addEventListener("change", () => {
    const f = file.files[0];
    if (!f) return;
    stopCamera(); video.hidden = true; still.hidden = false; still.src = URL.createObjectURL(f); source = "image";
    status.textContent = "고른 사진 위에 캐릭터를 끌어다 놓고 '찍어서 올리기'를 누르세요.";
  });
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { status.textContent = "이 브라우저는 카메라를 지원하지 않아요. 사진을 골라 캐릭터를 얹어 볼 수 있어요."; return; }
    try {
      arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      video.srcObject = arStream; video.hidden = false; still.hidden = true; source = "camera";
      status.textContent = "실제 나무에 카메라를 맞추고, 캐릭터를 끌어서 나무 옆에 세운 뒤 찍어 주세요.";
    } catch {
      status.textContent = "카메라를 쓸 수 없어요(권한 또는 기기). 대신 사진을 골라 캐릭터를 얹어 볼 수 있어요.";
    }
  }
  const capture = async () => {
    if (!source) { file.click(); return; }
    const srcEl = source === "camera" ? video : still;
    const sw = source === "camera" ? video.videoWidth : still.naturalWidth, sh = source === "camera" ? video.videoHeight : still.naturalHeight;
    if (!sw || !sh) { toast("아직 화면이 준비되지 않았어요.", true); return; }
    const c = document.createElement("canvas");
    const scale = Math.min(1, 1280 / Math.max(sw, sh));
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const ctx = c.getContext("2d");
    ctx.drawImage(srcEl, 0, 0, c.width, c.height);
    // 화면(object-fit: cover)에서 캐릭터가 놓인 자리를 원본 좌표로 옮긴다
    const r = stage.getBoundingClientRect(), cr = charSvg.getBoundingClientRect();
    const k = Math.max(r.width / c.width, r.height / c.height), offX = (r.width - c.width * k) / 2, offY = (r.height - c.height * k) / 2;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([charSvg.outerHTML], { type: "image/svg+xml" }));
    try {
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("캐릭터를 그리지 못했어요.")); img.src = url; });
      ctx.drawImage(img, (cr.left - r.left - offX) / k, (cr.top - r.top - offY) / k, cr.width / k, cr.height / k);
    } finally { URL.revokeObjectURL(url); }
    const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.85));
    const observe = ACT.care.find(a => a.id === "observe");
    const post = await saveActivity(t, "care", observe, { photo: blob, text: "캐릭터와 함께 찍은 AR 사진", ar: true });
    if (post) { toast(`AR 사진을 올렸어요 · +${observe.points}점`); go(`#photo/${encodeURIComponent(id)}`); }
  };
  box.replaceChildren(el("div", { class: "ar-wrap" }, stage,
    el("div", { class: "ar-controls" }, status,
      el("label", { class: "range" }, "크기", size, el("output", {}, "")),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn", onclick: capture }, "📸 찍어서 올리기"),
        el("button", { type: "button", class: "btn ghost", onclick: () => file.click() }, "🖼️ 사진 고르기"),
        view3dButton(t)), file,
      el("p", { class: "hint" }, "카메라 화면 위에 캐릭터를 얹는 방식이에요. 실제 크기의 3D 모형은 '3D · AR'(안드로이드 Chrome, iOS Safari)로 띄워요."))));
  requestAnimationFrame(place);
  new ResizeObserver(place).observe(stage);
  await startCamera();
}

// ---------- 공동보호자 ----------
function coGuardianBlock(t) {
  const box = el("section", { class: "card co" });
  if (!cloudOn()) {
    box.append(el("div", { class: "k" }, "공동보호자"),
      el("p", { class: "limit" }, cloud.configured() ? "온라인에 참여하면 이 나무를 함께 돌보는 보호자를 보고 대화할 수 있어요." : "공동보호자 대화는 서버 연결 뒤에 열려요."),
      cloud.configured() ? el("div", { class: "row" }, el("button", { type: "button", class: "btn small", onclick: joinDialog }, "온라인 참여하기")) : null);
    return box;
  }
  box.append(el("div", { class: "k" }, "공동보호자"), el("p", { class: "small", id: "coList" }, "불러오는 중…"),
    el("div", { class: "row" }, el("a", { class: "btn small", href: `#group/${encodeURIComponent(t.id)}` }, "👥 공동보호자 대화")));
  cloud.api.treeGuardians(t.id).then(rows => {
    const others = (rows || []).filter(r => r.guardian_id !== cloud.userId());
    const p = box.querySelector("#coList");
    p.textContent = others.length ? `${others.length}명이 함께 돌봐요: ${others.map(r => `${r.nickname}(${r.tree_name})`).join(", ")}` : "아직 나 혼자 돌보고 있어요. 이웃을 초대해 보세요.";
  }).catch(err => { box.querySelector("#coList").textContent = `불러오지 못했어요 (${err.message})`; });
  return box;
}
async function renderGroup(id) {
  await refreshMine();
  const t = myTree(id);
  const box = $("#s-group");
  if (!t) { go(`#tree/${encodeURIComponent(id)}`); return; }
  if (!cloudOn()) { box.replaceChildren(el("div", { class: "page-inner" }, el("p", { class: "empty" }, "온라인에 참여해야 공동보호자 대화를 열 수 있어요."), el("div", { class: "row" }, el("a", { class: "btn ghost", href: `#tree/${encodeURIComponent(id)}` }, "← 돌아가기")))); return; }
  const list = el("div", { class: "msgs", role: "log", "aria-live": "polite" });
  const mood = treeMood(t, postsOf(id));
  let lastId = 0, lastDay = "";
  const myId = cloud.userId();
  const appendItem = m => {
    const d = m.t.slice(0, 10);
    if (d !== lastDay) { list.append(el("div", { class: "day" }, new Date(m.t).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" }))); lastDay = d; }
    if (m.kind === "activity") {
      list.append(el("div", { class: "event" }, `${m.nickname}님이 ${m.label} 기록 · +${m.points}점${m.kg ? ` · −${massText(Number(m.kg))}` : ""}`));
      return;
    }
    const mine = m.guardian_id === myId;
    list.append(el("div", { class: `bubble ${mine ? "me" : "tree"}` }, mine ? null : el("span", { class: "who-avatar" }, m.nickname.slice(0, 1)),
      el("div", { class: "bubble-body" }, mine ? null : el("b", { class: "who" }, m.nickname), el("p", {}, m.body),
        el("time", { datetime: m.t }, new Date(m.t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })))));
  };
  const load = async (first = false) => {
    try {
      const msgs = await cloud.api.messages(id, lastId);
      let items = (msgs || []).map(m => ({ ...m, kind: "message" }));
      if (first) {
        const feed = await cloud.api.treeFeed(id, 20);
        items = items.concat((feed || []).map(a => ({ ...a, kind: "activity" }))).sort((a, b) => (a.t < b.t ? -1 : 1));
      }
      if (!items.length && first) list.append(el("p", { class: "empty" }, `${t.name}의 보호자 방이에요. 함께 돌보는 이웃에게 첫 인사를 남겨 보세요.`));
      for (const m of items) { appendItem(m); if (m.kind === "message") lastId = Math.max(lastId, m.id); }
      if (items.length) window.scrollTo(0, document.body.scrollHeight);
    } catch (err) { if (first) list.append(el("p", { class: "empty" }, `불러오지 못했어요 (${err.message})`)); }
  };
  const input = el("input", { type: "text", name: "text", maxlength: "500", placeholder: "공동보호자에게 메시지…", autocomplete: "off", "aria-label": "메시지" });
  const composer = el("form", { class: "composer", onsubmit: async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try { await cloud.api.sendMessage(id, text); input.value = ""; await load(); }
    catch (err) { toast(`보내지 못했어요: ${err.message}`, true); }
    finally { input.disabled = false; input.focus(); }
  } }, input, el("button", { type: "submit", class: "btn" }, "보내기"));
  setTitle(`${t.name} 보호자 방`);
  box.replaceChildren(el("div", { class: "chat" },
    el("header", { class: "chat-head" }, avatar(t, { size: 40, mood }),
      el("div", {}, el("b", {}, `${t.name} 보호자 방`), el("span", { class: "sub" }, ` ${t.species} · ${t.road}`)), el("span", { class: "online" }, `● ${state.profile.nickname}`)),
    el("p", { class: "small", style: "padding:0 16px" }, "같은 나무의 보호자끼리 보는 방이에요. 활동 기록도 여기에 보여요."),
    list, composer));
  await load(true);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) load(); }, 8000);
}

// ---------- 대화 ----------
function chatContext(t) {
  const posts = postsOf(t.id);
  const today = new Date();
  const lastCare = posts.find(p => p.kind === "care");
  return { tree: t, weather, season, todayKg: dailyUptake(t.annualKg, today, P), yearKg: cumulativeThisYear(t.annualKg, today, P),
    practiceKg: practiceKg(posts), points: t.points || 0, measured: posts.some(p => p.circ), lastCareDays: lastCare ? (Date.now() - new Date(lastCare.t)) / DAY : null, guardianName: null };
}
async function renderChat(id) {
  await refreshMine();
  const t = myTree(id);
  const box = $("#s-chat");
  if (!t) { go(`#tree/${encodeURIComponent(id)}`); return; }
  let msgs = await db.messagesFor(id);
  // 하루 넘게 조용했고 오늘 날씨 제안이 있으면 나무가 먼저 말을 건다
  const last = msgs[msgs.length - 1];
  if (weather && (!last || Date.now() - new Date(last.t) > DAY)) {
    const p = proactive(chatContext(t));
    if (p && !(last && last.text === p.text)) { await db.addMessage({ treeId: id, t: new Date().toISOString(), from: "tree", text: p.text, activity: p.activity }); msgs = await db.messagesFor(id); }
  }
  const mood = treeMood(t, postsOf(id));
  const list = el("div", { class: "msgs", role: "log", "aria-live": "polite" });
  const bubble = m => {
    const b = el("div", { class: `bubble ${m.from}` }, m.from === "tree" ? avatar(t, { size: 30, mood }) : null,
      el("div", { class: "bubble-body" }, el("p", {}, m.text), m.activity ? el("button", { type: "button", class: "btn small", onclick: () => openActivity(t, "care", m.activity) }, "기록하기") : null,
        el("time", { datetime: m.t }, new Date(m.t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }))));
    return b;
  };
  let lastDay = "";
  for (const m of msgs) {
    const d = m.t.slice(0, 10);
    if (d !== lastDay) { list.append(el("div", { class: "day" }, new Date(m.t).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" }))); lastDay = d; }
    list.append(bubble(m));
  }
  const input = el("input", { type: "text", name: "text", maxlength: "200", placeholder: `${t.name}에게 메시지…`, autocomplete: "off", "aria-label": "메시지" });
  const send = async text => {
    text = text.trim();
    if (!text) return;
    const mine = { treeId: id, t: new Date().toISOString(), from: "me", text };
    await db.addMessage(mine);
    list.append(bubble(mine));
    input.value = "";
    list.scrollTop = list.scrollHeight; window.scrollTo(0, document.body.scrollHeight);
    const typing = el("div", { class: "bubble tree typing" }, avatar(t, { size: 30, mood }), el("div", { class: "bubble-body" }, el("span", { class: "dots" }, "···")));
    list.append(typing);
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    const answer = { treeId: id, t: new Date().toISOString(), from: "tree", text: reply(text, chatContext(t)) };
    const p = /뭐 해|뭐해|할 일|도와|해줄/.test(text) ? proactive(chatContext(t)) : null;
    if (p) answer.activity = p.activity;
    await db.addMessage(answer);
    typing.replaceWith(bubble(answer));
    window.scrollTo(0, document.body.scrollHeight);
  };
  const chips = el("div", { class: "chips" }, ...["오늘 어때?", "탄소 얼마나 흡수했어?", "뭐 도와줄까?", "날씨 어때?"].map(q => el("button", { type: "button", class: "chip btn-chip", onclick: () => send(q) }, q)));
  const composer = el("form", { class: "composer", onsubmit: e => { e.preventDefault(); send(input.value); } }, input, el("button", { type: "submit", class: "btn" }, "보내기"));
  setTitle(`${josa(t.name, "과", "와")} 대화`);
  box.replaceChildren(el("div", { class: "chat" },
    el("header", { class: "chat-head" }, avatar(t, { size: 40, mood }),
      el("div", {}, el("b", {}, t.name), el("span", { class: "sub" }, ` ${t.species} · ${t.road}`)), el("span", { class: "online" }, "● 지금 여기")),
    list, chips, composer));
  requestAnimationFrame(() => { window.scrollTo(0, document.body.scrollHeight); });
}

main();
