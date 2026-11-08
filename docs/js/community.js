// 커뮤니티(선택, supabase/community.sql): 내 프로필의 현황 숫자·기간별 순위·이웃 보호자 소식, 지도의 '다른 보호자가 돌보는 나무'.
// 온라인 참여 전이거나 서버에 community.sql이 없으면(함수 404) 아무것도 그리지 않는다 → home.js가 예전 '동네 순위(30일)'를 보여 준다.
// 보이는 것: 동·활동 종류·시각·나무 이름(관리번호·수종)·집계 숫자. 닉네임은 '내 닉네임 보이기'를 켠 사람만(기본 꺼짐 → 익명 보호자).
// 사진·메모·위치는 서버에 없다. 지도 레이어·소스 id는 'community-' 접두어.
import * as cloud from "./cloud.js";
import { treesInBounds } from "./friends.js";

export const MAP_MIN_ZOOM = 14;      // 이 확대부터 화면 안 나무를 묻는다
export const REFRESH_MS = 60000;     // 프로필을 보고 있을 때만, 1분마다
export const PERIODS = [["day", "오늘"], ["week", "이번 주"], ["month", "이번 달"], ["year", "올해"]];
export const TARGETS = [["dong", "동네"], ["guardian", "보호자"], ["tree", "나무"]];
const COLOR = "#7B5CD6";
const VIEW_KEY = "wg-community-view";
const CACHE_MS = 120000;
const FEED_SHOW = 8, FEED_MAX = 30, RANK_SHOW = 10;
const DAY = 86400000, KST = 9 * 3600000;

// ---------- 순수 함수(node 검사용) ----------
/** 한국 날짜 'YYYY-MM-DD' */
export const kstDay = (ms = Date.now()) => new Date(ms + KST).toISOString().slice(0, 10);
/** 'n분 전' */
export function ago(iso, now = Date.now()) {
  const m = Math.floor((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}
/** 마지막 활동 날짜(한국 날짜) → '오늘'·'어제'·'n일 전' */
export function dayAgo(day, now = Date.now()) {
  if (!day) return null;
  const n = Math.round((Date.parse(kstDay(now)) - Date.parse(String(day).slice(0, 10))) / DAY);
  return n <= 0 ? "오늘" : n === 1 ? "어제" : `${n}일 전`;
}
/** 지도 카드 한 줄 */
export function cardLine(row, now = Date.now()) {
  if (!row) return null;
  const last = dayAgo(row.last_day, now);
  return `보호자 ${row.guardians}명${row.is_mine ? "(나 포함)" : ""} · ${last ? `최근 활동 ${last}` : "아직 활동 기록 없음"}${row.recent ? ` · 30일 ${row.recent}회` : ""}`;
}
/** 순위 표의 이름 칸 */
export function rankName(r, target) {
  if (target === "guardian") return r.is_me ? `나${r.name ? ` · ${r.name}` : ""}` : r.name || "익명 보호자";
  if (target === "tree") return r.name || r.species || "이름 없는 나무";
  return r.dong || r.name || "";
}
/** 이웃 소식의 '누가' */
export const feedWho = r => (r.is_me ? "나" : r.nickname || "이웃 보호자");

// ---------- 공통 ----------
let H = null;   // home.js 도구 { state, ACT, el, nf, massText }
const el = (...a) => H.el(...a);
function ensureCss() {
  if (document.querySelector("link[data-community-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = new URL("../community.css", import.meta.url).href; link.dataset.communityCss = "";
  document.head.append(link);
}
function loadView() {
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY)); if (PERIODS.some(p => p[0] === v?.period) && TARGETS.some(t => t[0] === v?.target)) return v; } catch { /* 기본값 */ }
  return { period: "week", target: "dong" };
}
const view = loadView();
const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* 이번만 */ } };
const iconOf = id => [...(H.ACT.care || []), ...(H.ACT.practice || [])].find(a => a.id === id)?.icon || "🌳";

// ---------- 내 프로필: 현황·순위·이웃 소식 ----------
let timer = null, lastLoad = 0, current = null, warned = false;

/** 참여 중이고 community.sql이 있으면 target 안에 그리고 true. 아니면 false(아무것도 안 그림). */
export async function renderOnline(target, h) {
  H = h;
  if (!(await cloud.communityApi.available())) return false;
  ensureCss();
  const ui = {
    root: target,
    mine: el("p", { class: "small cm-mine" }),
    stats: el("div", { class: "cm-stats", id: "cmStats" }, el("p", { class: "small" }, "불러오는 중…")),
    updated: el("p", { class: "small cm-updated" }),
    rank: el("div", { class: "cm-rank", id: "cmRank" }),
    feed: el("div", { class: "cm-feed", id: "cmFeed" }),
    feedAll: false,
  };
  const segs = el("div", { class: "cm-tabs" },
    seg("기간", PERIODS, () => view.period, v => { view.period = v; saveView(); loadRank(ui); }),
    seg("대상", TARGETS, () => view.target, v => { view.target = v; saveView(); loadRank(ui); }));
  const nick = el("input", { type: "checkbox", id: "cmShowNick" });
  nick.addEventListener("change", async () => {
    nick.disabled = true;
    try { await cloud.communityApi.setPrefs(nick.checked); H.toast?.(nick.checked ? "순위·소식에 내 닉네임이 보여요" : "이제 '익명 보호자'로 보여요"); await Promise.all([loadRank(ui), loadFeed(ui)]); }
    catch (err) { nick.checked = !nick.checked; H.toast?.(`바꾸지 못했어요 (${err.message})`, true); }
    finally { nick.disabled = false; }
  });
  cloud.communityApi.prefs().then(v => { nick.checked = v === true; }).catch(() => {});
  target.replaceChildren(ui.mine,
    el("h3", {}, "지금 우리 동네들은"), ui.stats, ui.updated,
    el("h3", {}, "순위"), segs, ui.rank,
    el("label", { class: "cm-nick" }, nick, el("span", {}, el("b", {}, "순위·이웃 소식에 내 닉네임 보이기"),
      el("small", {}, "끄면 다른 사람에게 '익명 보호자'로 보여요. 동네·나무 순위에는 그대로 더해져요."))),
    el("h3", {}, "이웃 보호자 소식"),
    el("p", { class: "small" }, "최근 7일, 다른 보호자들이 기록한 돌봄·실천이에요. 사진·메모·위치는 나오지 않아요."),
    ui.feed);
  current = ui;
  await refresh(ui, true);
  clearInterval(timer);
  timer = setInterval(() => {
    if (!target.isConnected) { clearInterval(timer); timer = null; return; }
    if (visible(target)) refresh(ui);
  }, REFRESH_MS);
  return true;
}
const visible = node => document.visibilityState === "visible" && node.isConnected && node.offsetParent !== null;
// 다른 탭에 있다가 돌아오면, 1분이 지났을 때만 바로 새로 고침
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (current && visible(current.root) && Date.now() - lastLoad >= REFRESH_MS) refresh(current);
});

async function refresh(ui, first = false) {
  lastLoad = Date.now();
  await Promise.all([loadMine(ui), loadStats(ui), loadRank(ui, !first), loadFeed(ui)]);
  ui.updated.textContent = `${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준 · 이 화면을 보고 있으면 1분마다 새로 고쳐요`;
}
function failed(box, what, err) {
  if (!warned) { console.warn(`커뮤니티 ${what}을(를) 불러오지 못했어요`, err?.message || err); warned = true; }
  box.replaceChildren(el("p", { class: "small" }, `${what}을(를) 불러오지 못했어요. 잠시 뒤 다시 시도해요.`));
}

function seg(label, items, get, set) {
  const box = el("div", { class: "seg cm-seg", role: "group", "aria-label": label });
  const paint = () => { for (const b of box.children) b.setAttribute("aria-pressed", String(b.dataset.v === get())); };
  for (const [v, text] of items) box.append(el("button", { type: "button", "data-v": v, onclick: () => { set(v); paint(); } }, text));
  paint();
  return box;
}

async function loadMine(ui) {
  try {
    const m = await cloud.api.myScore();
    ui.mine.textContent = m ? `내 활동 ${H.nf(m.activities)}건 · ${H.nf(m.points)}점 · 감축 ${H.massText(Number(m.kg))}(추정)` : "";
  } catch { ui.mine.textContent = ""; }
}

async function loadStats(ui) {
  try {
    const rows = await cloud.communityApi.stats();
    if (!rows) return;
    const by = Object.fromEntries(rows.map(r => [r.period, r]));
    const col = (title, r) => el("div", { class: "cm-stat" }, el("div", { class: "k" }, title),
      el("div", { class: "cm-num" }, el("b", { "data-stat": "new_trees" }, H.nf(r?.new_trees || 0)), el("small", {}, "그루"), el("span", {}, "새 친구 나무")),
      el("div", { class: "cm-num" }, el("b", { "data-stat": "active_guardians" }, H.nf(r?.active_guardians || 0)), el("small", {}, "명"), el("span", {}, "활동한 보호자")),
      el("div", { class: "cm-sub" }, `활동 ${H.nf(r?.activities || 0)}회${Number(r?.kg) ? ` · 감축 ${H.massText(Number(r.kg))}` : ""}`));
    const any = rows[0];
    ui.stats.replaceChildren(col("오늘", by.day), col("이번 주", by.week),
      any ? el("p", { class: "small cm-total" }, `지금까지 친구가 된 나무 ${H.nf(any.total_trees)}그루 · 참여한 보호자 ${H.nf(any.total_guardians)}명 · 감축은 생활 실천 환산(추정)`) : null);
  } catch (err) { failed(ui.stats, "현황", err); }
}

async function loadRank(ui, keep = false) {
  const { period, target } = view;
  if (!keep) ui.rank.replaceChildren(el("p", { class: "small" }, "순위를 불러오는 중…"));
  let rows;
  try { rows = await cloud.communityApi.rankings(period, target, RANK_SHOW); }
  catch (err) { failed(ui.rank, "순위", err); return; }
  if (view.period !== period || view.target !== target || !rows) return; // 그새 탭을 바꿨다
  const pLabel = PERIODS.find(p => p[0] === period)[1];
  if (!rows.length) {
    ui.rank.replaceChildren(el("p", { class: "small cm-empty" }, `${pLabel}은(는) 아직 순위에 오른 ${target === "dong" ? "동네" : target === "tree" ? "나무" : "보호자"}가 없어요. 첫 활동을 기록해 보세요.`));
    return;
  }
  const nf = H.nf;
  const head = {
    dong: ["동", "보호자", "점수", "감축"],
    guardian: ["보호자", "활동", "점수"],
    tree: ["나무", "보호자", "활동"],
  }[target];
  const cells = r => {
    // 내 나무는 내가 지은 이름으로(다른 보호자는 첫 보호자가 지은 이름을 본다)
    const mine = target === "tree" && r.is_me ? H.state?.my?.find(t => t.id === r.tree_id)?.name : null;
    const name = mine || rankName(r, target);
    if (target === "dong") return [el("td", {}, name), el("td", { class: "r num" }, nf(r.guardians)), el("td", { class: "r num" }, nf(r.points)), el("td", { class: "r num" }, H.massText(Number(r.kg)))];
    if (target === "guardian") return [el("td", {}, el("span", { class: r.name || r.is_me ? null : "cm-anon" }, name), r.dong ? el("small", { class: "cm-subtxt" }, r.dong) : null),
      el("td", { class: "r num" }, nf(r.activities)), el("td", { class: "r num" }, nf(r.points))];
    return [el("td", {}, el("a", { href: `#map?tree=${encodeURIComponent(r.tree_id)}`, class: "cm-tree" }, name), r.is_me ? el("span", { class: "badge soft cm-mybadge" }, "내 나무") : null,
      el("small", { class: "cm-subtxt" }, [r.species, r.dong].filter(Boolean).join(" · "))),
    el("td", { class: "r num" }, nf(r.guardians)), el("td", { class: "r num" }, nf(r.activities))];
  };
  const body = [];
  let prev = 0;
  for (const r of rows) {
    if (r.rank > prev + 1 && prev && r.rank > RANK_SHOW) body.push(el("tr", { class: "cm-gap" }, el("td", { colspan: String(head.length + 1) }, "⋯")));
    body.push(el("tr", { class: r.is_me ? "me" : null, "data-me": r.is_me ? "1" : null }, el("td", { class: "num" }, r.rank), ...cells(r)));
    prev = r.rank;
  }
  const meNote = { dong: "내 동네", guardian: "나", tree: "내 나무" }[target];
  ui.rank.replaceChildren(
    el("div", { class: "tablebox" }, el("table", { class: "rank cm-table", "data-target": target },
      el("thead", {}, el("tr", {}, el("th", {}, "#"), ...head.map((t, k) => el("th", { class: k ? "r" : null }, t)))),
      el("tbody", {}, ...body))),
    el("p", { class: "small" }, `${pLabel}(한국 시간) · ${target === "tree" ? "활동 수" : "점수"} 순 · 색칠한 줄이 ${meNote}${target === "dong" ? " · 감축은 생활 실천 환산(추정)" : ""}`));
}

async function loadFeed(ui) {
  let rows;
  try { rows = await cloud.communityApi.feed(FEED_MAX); }
  catch (err) { failed(ui.feed, "이웃 소식", err); return; }
  if (!rows) return;
  if (!rows.length) { ui.feed.replaceChildren(el("p", { class: "small cm-empty" }, "최근 7일 동안 올라온 활동이 없어요.")); return; }
  const show = ui.feedAll ? rows : rows.slice(0, FEED_SHOW);
  ui.feed.replaceChildren(
    el("ul", { class: "cm-feed-list" }, ...show.map(r => el("li", { class: r.is_me ? "me" : null },
      el("span", { class: "cm-icon", "aria-hidden": "true" }, iconOf(r.activity)),
      el("span", { class: "cm-txt" },
        el("span", {}, el("b", { class: r.nickname || r.is_me ? null : "cm-anon" }, feedWho(r)), ` · ${r.label}`),
        el("small", {}, [r.tree_name ? `‘${r.tree_name}’` : null, r.dong, ago(r.t)].filter(Boolean).join(" · ")))))),
    rows.length > FEED_SHOW && !ui.feedAll ? el("button", { type: "button", class: "btn ghost small", onclick: () => { ui.feedAll = true; loadFeed(ui); } }, `더 보기 (${rows.length - FEED_SHOW}건)`) : null);
}

// ---------- 지도: 다른 보호자가 돌보는 나무 ----------
let M = null;                  // { mm, T, state, selectTree, cloudOn }
const cache = new Map();       // tree_id → { row|null, at }
let legend = null, mapSeq = 0;
const EMPTY = { type: "FeatureCollection", features: [] };

/** 큰 지도가 준비되면 한 번(home.js ensureBigMap). 레이어는 친구·가로수 점 아래에 깐다. */
export function attachMap(mm, ctx) {
  M = { mm, ...ctx };
  H = H || ctx;
  ensureCss();
  const map = mm.map;
  if (map.getSource("community-trees")) return;
  map.addSource("community-trees", { type: "geojson", data: EMPTY });
  const before = ["friends-area", "trees"].find(id => map.getLayer(id));
  // 다른 보호자가 돌보는 나무: 보라색 둥근 테두리(확대 16부터 그 안에 가로수 점이 겹친다)
  map.addLayer({ id: "community-halo", type: "circle", source: "community-trees", minzoom: MAP_MIN_ZOOM,
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 6, 16, 10, 19, 15], "circle-color": COLOR, "circle-opacity": 0.16,
      "circle-stroke-color": COLOR, "circle-stroke-width": 2.2, "circle-stroke-opacity": 0.95 } }, before);
  map.addLayer({ id: "community-core", type: "circle", source: "community-trees", minzoom: MAP_MIN_ZOOM, maxzoom: 16,
    paint: { "circle-radius": 2.6, "circle-color": COLOR } }, before);
  map.addLayer({ id: "community-count", type: "symbol", source: "community-trees", minzoom: 16.5,
    layout: { "text-field": ["concat", "보호자 ", ["to-string", ["get", "guardians"]]], "text-font": ["Noto Sans Regular"], "text-size": 10.5,
      "text-offset": [0, -1.5], "text-anchor": "bottom", "text-allow-overlap": false },
    paint: { "text-color": COLOR, "text-halo-color": "#ffffff", "text-halo-width": 1.4 } }, before);
  map.on("click", "community-halo", e => {
    // 가로수·친구·등록 나무 점과 겹치면 그쪽 처리에 맡긴다
    const others = ["trees", "friends-area", "user-trees-ring"].filter(id => map.getLayer(id));
    if (others.length && map.queryRenderedFeatures(e.point, { layers: others }).length) return;
    const f = e.features?.[0];
    if (f) M.selectTree(Number(f.properties.i));
  });
  map.on("mouseenter", "community-halo", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "community-halo", () => { map.getCanvas().style.cursor = ""; });
  map.on("moveend", () => { clearTimeout(attachMap.t); attachMap.t = setTimeout(refreshMap, 600); });
  const top = document.querySelector("#s-map .map-top");
  legend = Object.assign(document.createElement("span"), { className: "community-legend", id: "communityLegend", hidden: true });
  const bar = top?.querySelector(".user-reg-bar");
  if (bar) bar.prepend(legend); else top?.append(legend);
  // 프로필에서 참여하고 지도로 돌아오면 지도를 움직이지 않아도 한 번 새로
  window.addEventListener("hashchange", () => { if (location.hash.startsWith("#map")) setTimeout(refreshMap, 300); });
  refreshMap();
}

function setLegend(n) {
  if (!legend) return;
  legend.hidden = !n;
  legend.replaceChildren(Object.assign(document.createElement("i"), { ariaHidden: "true" }), `다른 보호자가 돌보는 나무 ${n.toLocaleString("ko-KR")}`);
}

/** 화면 안(확대 14 이상) 나무 중 다른 보호자가 있는 나무를 지도에 표시. */
export async function refreshMap() {
  if (!M) return;
  const map = M.mm.map, src = map.getSource("community-trees");
  const seq = ++mapSeq;
  const clear = () => { src?.setData(EMPTY); setLegend(0); };
  if (!M.cloudOn() || map.getZoom() < MAP_MIN_ZOOM - 0.01 || !M.T) return clear();
  if (!(await cloud.communityApi.available())) return clear();
  const b = map.getBounds();
  const idx = treesInBounds(M.T, [[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]], { limit: 3000 });
  const now = Date.now();
  const ask = idx.map(i => M.T.id[i]).filter(id => !(cache.get(id)?.at > now - CACHE_MS));
  if (ask.length) {
    let rows;
    try { rows = await cloud.communityApi.treesInView(ask); } catch (err) { if (!warned) { console.warn("다른 보호자 나무를 불러오지 못했어요", err.message); warned = true; } return; }
    if (!rows) return clear();
    const got = new Map(rows.map(r => [r.tree_id, r]));
    for (const id of ask) cache.set(id, { row: got.get(id) || null, at: now });
  }
  if (seq !== mapSeq) return; // 그새 지도를 또 움직였다
  const mine = new Set(M.state.my.map(t => t.id));
  const feats = [];
  for (const i of idx) {
    const id = M.T.id[i], row = cache.get(id)?.row;
    if (!row || mine.has(id)) continue; // 내 나무는 하트 표시가 따로 있다
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [M.T.lon[i], M.T.lat[i]] }, properties: { i, guardians: row.guardians } });
  }
  src?.setData({ type: "FeatureCollection", features: feats });
  setLegend(feats.length);
}

/** 지도 나무 카드에 '보호자 n명 · 최근 활동' 한 줄(다른 보호자가 있을 때만). */
export async function decorateCard(sheet, id) {
  if (!M || !sheet || !M.cloudOn() || cloud.communityApi.known() === false) return;
  const head = sheet.querySelector(".detail-head");
  if (!head) return;
  let hit = cache.get(id);
  if (!(hit?.at > Date.now() - CACHE_MS)) {
    if (!(await cloud.communityApi.available())) return;
    let rows;
    try { rows = await cloud.communityApi.treesInView([id]); } catch { return; }
    if (!rows) return;
    hit = { row: rows.find(r => r.tree_id === id) || null, at: Date.now() };
    cache.set(id, hit);
  }
  const text = cardLine(hit.row);
  if (!text || !head.isConnected) return;
  head.parentNode.querySelector(".community-line")?.remove();
  const line = document.createElement("p");
  line.className = "community-line";
  line.append(Object.assign(document.createElement("i"), { ariaHidden: "true" }), text);
  head.after(line);
}
