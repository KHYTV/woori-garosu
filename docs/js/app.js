import { circumferenceToDbh, simulateTree } from "./carbon.js";
import { createMap3D, defaultColorMode } from "./map3d.js";
import { estimateForm } from "./treeform.js";

const BASEMAPS = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const JEONJU_CENTER = [127.13, 35.83];
const GRADE_TEXT = { A: "문제 없음", B: "경미", C: "탄소 계산 제외", X: "위치 사용 불가" };
const GRADE_COLOR = { A: "var(--good)", B: "var(--warning)", C: "var(--serious)", X: "var(--critical)" };
const SEASONS = ["새잎", "꽃", "무성한 잎", "열매", "단풍", "낙엽", "겨울눈"];
const CROWN = ["정상", "일부 전정", "강전정 의심", "두절(줄기만 남음)"];
const SIGNS = ["마른 가지", "병해충", "줄기 상처", "뿌리 들림", "지지대 파손", "쓰레기"];

const $ = sel => document.querySelector(sel);
const nf = (v, d = 0) => Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const kg = v => (Math.abs(v) < 10 ? nf(v, 1) : nf(v, 0));
const pct = (v, d = 0) => nf(v * 100, d) + "%";
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
// 받침에 따라 조사 고르기: josa("벚나무", "이에요", "예요")
function josa(word, withFinal, withoutFinal) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code < 11172 && code % 28 !== 0;
  return word + (hasFinal ? withFinal : withoutFinal);
}

// 기기 저장소: 이 데모의 보호자·관찰 기록은 브라우저에만 남는다
const store = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
};
const guardians = () => new Set(store.read("wg-guardian", []));
const observations = id => store.read(`wg-obs-${id}`, []);

let T, S, P, FORM, map, map3d, cuts = [], seqVals = [];
let cond = store.read("wg-cond", "range-limit");

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function main() {
  const status = $("#status");
  try {
    [T, S, P, FORM] = await Promise.all([loadJSON("data/trees.json"), loadJSON("data/summary.json"),
      loadJSON("data/params.json"), loadJSON("data/tree_form.json")]);
  } catch (e) {
    status.textContent = "데이터를 불러오지 못했습니다. 새로고침해 주세요.";
    throw e;
  }
  setupTabs();
  setupControls();
  renderSummary();
  await setupMap();
  status.textContent = "";
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
}

// 화면 전환
function setupTabs() {
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => showView(b.dataset.view));
  }
}
function showView(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-pressed", String(b.dataset.view === name));
  for (const v of ["map", "summary", "about"]) $(`#view-${v}`).hidden = v !== name;
  if (name === "summary") renderSummary();
  if (name === "map" && map) map.resize();
}

// 지도
async function pickStyle() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  for (const url of dark ? [BASEMAPS.dark, BASEMAPS.light] : [BASEMAPS.light]) {
    try {
      const r = await fetch(url);
      if (r.ok) return url;
    } catch { /* 다음 후보 */ }
  }
  // 배경지도를 못 불러와도 나무는 보이게 한다
  return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": token("--bg") } }] };
}

function treeFeatures(speciesIdx = null) {
  const feats = [];
  for (let i = 0; i < T.id.length; i++) {
    if (speciesIdx !== null && T.sp[i] !== speciesIdx) continue;
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [T.lon[i], T.lat[i]] },
      properties: { i, s: T.seq[1][i] ?? -1, d: T.dbh[i] ?? 10 } });
  }
  return { type: "FeatureCollection", features: feats };
}

function seqColorExpr() {
  const c = [1, 2, 3, 4, 5].map(k => token(`--seq-${k}`));
  return ["step", ["get", "s"], c[0], cuts[0], c[1], cuts[1], c[2], cuts[2], c[3], cuts[3], c[4]];
}

async function setupMap() {
  seqVals = T.seq[1].filter(v => v !== null).sort((a, b) => a - b);
  cuts = [0.2, 0.4, 0.6, 0.8].map(p => seqVals[Math.floor(p * seqVals.length)]);
  renderLegend();

  const style = await pickStyle();
  map = new maplibregl.Map({ container: "map", style, center: JEONJU_CENTER, zoom: 11.6, minZoom: 9, maxZoom: 19,
    attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");  // 배경지도 타일을 다 받을 때까지('load') 기다리지 않고, 스타일이 준비되면 바로 나무를 올린다
  await new Promise(res => (map.isStyleLoaded() ? res() : map.once("style.load", res)));
  // 라벨 글꼴은 배경지도 스타일에 있는 것을 써야 한다. 없는 글꼴을 요청하면 그 타일 전체가 그려지지 않는다
  const baseFont = map.getStyle().layers
    .map(l => l.layout && l.layout["text-font"]).find(f => Array.isArray(f) && /Regular/.test(f.join(" ")));
  const hasGlyphs = Boolean(map.getStyle().glyphs && baseFont);

  const boundary = await loadJSON("data/boundary.geojson");
  map.addSource("boundary", { type: "geojson", data: boundary });
  map.addLayer({ id: "boundary", type: "line", source: "boundary", paint: { "line-color": token("--accent"), "line-width": 1.5, "line-dasharray": [2, 2] } });

  map.addSource("trees", { type: "geojson", data: treeFeatures(), cluster: true, clusterMaxZoom: 14, clusterRadius: 42 });
  map.addLayer({ id: "clusters", type: "circle", source: "trees", filter: ["has", "point_count"],
    paint: { "circle-color": token("--accent"), "circle-opacity": 0.82, "circle-stroke-color": token("--surface"), "circle-stroke-width": 2,
      "circle-radius": ["step", ["get", "point_count"], 14, 100, 18, 500, 23, 2000, 28] } });
  if (hasGlyphs) {
    map.addLayer({ id: "cluster-count", type: "symbol", source: "trees", filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": baseFont },
      paint: { "text-color": token("--accent-ink") } });
  }
  map.addLayer({ id: "trees", type: "circle", source: "trees", filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": ["case", ["<", ["get", "s"], 0], token("--surface"), seqColorExpr()],
      "circle-stroke-color": ["case", ["<", ["get", "s"], 0], token("--muted"), token("--surface")],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 18, 1.5],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, ["+", 2, ["/", ["get", "d"], 20]], 18, ["+", 4, ["/", ["get", "d"], 5]]],
    } });
  map.addSource("selected", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "selected", type: "circle", source: "selected",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 18, 16], "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": token("--ink"), "circle-stroke-width": 2.5 } });

  map.on("click", "clusters", async e => {
    const f = e.features[0];
    const zoom = await map.getSource("trees").getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on("click", "trees", e => openTree(e.features[0].properties.i));
  for (const layer of ["clusters", "trees"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }

  map3d = createMap3D({
    map, T, speciesInfo: S.species_info, form: FORM, token, cuts,
    onSelect: i => openTree(i),
    onStatus: text => { $("#status").textContent = text; },
  });
  setup3DControls();
}

// 3D 켜기·끄기와 나무 색
function setup3DControls() {
  const btn = $("#toggle3d"), wrap = $("#colorModeWrap"), sel = $("#colorMode");
  sel.value = defaultColorMode();
  btn.addEventListener("click", async () => {
    const turnOn = !map3d.isOn();
    btn.disabled = true;
    try {
      if (turnOn) await map3d.enable(); else map3d.disable();
      btn.setAttribute("aria-pressed", String(turnOn));
      wrap.hidden = !turnOn;
      if (turnOn) map3d.setColorMode(sel.value);
      renderLegend();
    } catch (e) {
      $("#status").textContent = "3D를 켜지 못했습니다. 네트워크 연결을 확인해 주세요.";
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  });
  sel.addEventListener("change", () => { map3d.setColorMode(sel.value); renderLegend(); });
}

const SHAPE_ICONS = {
  cone: "M7 1 L12.5 13 H1.5 Z",
  round: "M7 1 A6 6 0 1 1 6.99 1 Z",
  umbrella: "M1 9 Q7 0 13 9 Z",
};
function renderLegend() {
  const vals = seqVals;
  const ramp = el("div", { class: "ramp" }, el("span", {}, `${kg(vals[0])}`),
    ...[1, 2, 3, 4, 5].map(k => el("i", { style: `background:var(--seq-${k})` })), el("span", {}, `${kg(vals[vals.length - 1])} kg`));
  const on3d = map3d && map3d.isOn();
  const mode = on3d ? map3d.colorMode() : "carbon";
  const parts = [];
  if (!on3d || mode === "carbon") parts.push(el("div", {}, "나무별 연간 CO₂ 흡수 추정(5분위)"), ramp);
  else parts.push(el("div", {}, { leaf: "잎 색(상록수는 진한 초록)", autumn: "수종별 단풍 색(상록수는 진한 초록)", winter: "겨울: 낙엽수는 흐리게" }[mode]));
  if (on3d) {
    const icon = d => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 14 14"); s.setAttribute("aria-hidden", "true"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); return s; };
    parts.push(el("div", { class: "shapes" }, ...Object.entries(FORM.shapes).map(([k, v]) => el("span", {}, icon(SHAPE_ICONS[k]), v.label))),
      el("div", { class: "note" }, "높이·수관폭은 흉고로 추정한 모양입니다(실측 아님)."));
  } else {
    parts.push(el("div", {}, "큰 점일수록 줄기가 굵은 나무 · 묶음 원은 나무 수"));
  }
  $("#legend").replaceChildren(...parts);
}

// 검색·필터·내 위치
function setupControls() {
  $("#roadList").replaceChildren(...T.roads.map(r => el("option", { value: r })));
  const search = $("#search");
  const go = () => {
    const ri = T.roads.indexOf(search.value.trim());
    if (ri < 0 || !map) return;
    const b = new maplibregl.LngLatBounds();
    for (let i = 0; i < T.id.length; i++) if (T.rd[i] === ri) b.extend([T.lon[i], T.lat[i]]);
    if (!b.isEmpty()) map.fitBounds(b, { padding: 80, maxZoom: 17 });
  };
  search.addEventListener("change", go);
  search.addEventListener("keydown", e => { if (e.key === "Enter") go(); });

  const counts = T.species.map((s, i) => [s, i, T.sp.filter(x => x === i).length]).sort((a, b) => b[2] - a[2]);
  $("#speciesFilter").append(...counts.map(([s, i, n]) => el("option", { value: i }, `${s} (${nf(n)})`)));
  $("#speciesFilter").addEventListener("change", e => {
    if (!map) return;
    map.getSource("trees").setData(treeFeatures(e.target.value === "" ? null : Number(e.target.value)));
  });

  $("#locate").addEventListener("click", () => {
    const status = $("#status");
    if (!navigator.geolocation) { status.textContent = "이 브라우저는 위치 기능을 지원하지 않습니다."; return; }
    status.textContent = "현재 위치를 찾는 중입니다.";
    navigator.geolocation.getCurrentPosition(
      pos => { status.textContent = ""; map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 }); },
      () => { status.textContent = "위치를 가져오지 못했습니다. 브라우저의 위치 권한을 확인해 주세요."; setTimeout(() => { status.textContent = ""; }, 4000); },
      { enableHighAccuracy: true, timeout: 10000 });
  });
}

// 나무 카드
function treeRecord(i) {
  const species = T.species[T.sp[i]];
  const info = S.species_info[species];
  return { i, id: T.id[i], species, info, road: T.roads[T.rd[i]], dbh: T.dbh[i], grade: T.grades[T.grade[i]],
    block: Boolean(T.block[i]), seq: T.seq.map(a => a[i]), stor: T.stor.map(a => a[i]), point: T.point_seq[i] };
}
function modelTree(t, dbh) {
  const { jenkins_group, alt_group, growth_class, mature_height_class } = t.info;
  return { jenkins_group, alt_group, growth_class, mature_height_class, dbh: dbh ?? t.dbh, block: t.block };
}

function openFromHash() {
  const m = location.hash.match(/^#tree-(.+)$/);
  if (!m) return;
  const i = T.id.indexOf(decodeURIComponent(m[1]));
  if (i >= 0) { showView("map"); openTree(i, true); }
}

function openTree(i, fly = false) {
  const t = treeRecord(i);
  if (location.hash !== `#tree-${t.id}`) history.replaceState(null, "", `#tree-${encodeURIComponent(t.id)}`);
  if (map) {
    map.getSource("selected").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [T.lon[i], T.lat[i]] } }] });
    if (fly) map.flyTo({ center: [T.lon[i], T.lat[i]], zoom: 17.5 });
  }
  if (map3d) map3d.setSelected(i);
  renderSheet(t);
}

function closeSheet() {
  $("#sheet").hidden = true;
  if (map) map.getSource("selected").setData({ type: "FeatureCollection", features: [] });
  if (map3d) map3d.setSelected(-1);
  history.replaceState(null, "", location.pathname + location.search);
}

function sameRoadSpecies(t) {
  let n = 0;
  for (let k = 0; k < T.id.length; k++) if (T.rd[k] === T.rd[t.i] && T.sp[k] === T.sp[t.i]) n++;
  return n;
}

function storyText(t) {
  const n = sameRoadSpecies(t);
  const parts = [`저는 ${t.road}에 서 있는 ${josa(t.species, "이에요", "예요")}.`];
  if (t.dbh) parts.push(`줄기 지름(흉고)은 ${nf(t.dbh)}cm예요.`);
  if (n > 1) parts.push(`이 길에는 같은 ${t.species} ${nf(n)}그루가 줄지어 서 있어요.`);
  if (t.seq[1] !== null) parts.push(`한 해 동안 공기 중 CO₂를 ${kg(t.seq[0])}~${kg(t.seq[2])}kg쯤 흡수하는 것으로 추정돼요.`);
  if (t.block) parts.push("다만 제 흉고는 아직 아무도 직접 재지 않은 대표값이에요. 줄자로 둘레를 재 주시면 제 이야기가 더 정확해져요.");
  return parts.join(" ");
}

function track(r) {
  const hi = Math.max(r[2] * 1.15, 1);
  const x = v => `${(v / hi * 100).toFixed(2)}%`;
  return el("div", {},
    el("div", { class: "track", "aria-hidden": "true" }, el("div", { class: "rail" }),
      el("div", { class: "band", style: `left:${x(r[0])};width:calc(${x(r[2])} - ${x(r[0])})` }),
      el("div", { class: "mid", style: `left:${x(r[1])}` })),
    el("div", { class: "track-labels num" }, el("span", {}, `하위 10% ${kg(r[0])}`), el("span", {}, `중앙 ${kg(r[1])}`), el("span", {}, `상위 10% ${kg(r[2])}`)));
}

function carbonCard(t) {
  if (t.seq[1] === null) return el("div", { class: "card" }, el("p", { class: "limit" }, "흉고 값이 없어 탄소를 계산하지 않았습니다. 흉고둘레를 재서 기록하면 계산됩니다."));
  if (cond === "single") {
    return el("div", { class: "card" }, el("div", { class: "k" }, "이 나무가 1년에 흡수하는 CO₂"),
      el("div", { class: "big num" }, kg(t.point), el("small", {}, "kg")));
  }
  const card = el("div", { class: "card" }, el("div", { class: "k" }, "이 나무가 1년에 흡수하는 CO₂ (추정)"),
    el("div", { class: "big num" }, `${kg(t.seq[0])}~${kg(t.seq[2])}`, el("small", {}, "kg")), track(t.seq));
  if (cond === "range-limit") {
    const lim = ["도시 생육 보정은 해외 기준을 썼고, 국내 도시수목 상대생장식이 아직 없어 대리식을 적용했습니다."];
    if (t.block) lim.push("이 구간의 흉고는 대표값으로 보여 범위를 넓게 잡았습니다.");
    const dmax = P.growth.max_dbh_cm[t.info.mature_height_class];
    if (t.dbh / dmax > P.growth.size_decline.start) lim.push(`큰 나무라 생장을 줄여 계산했습니다(최대 흉고 ${nf(dmax, 1)}cm의 ${nf(t.dbh / dmax * 100)}%).`);
    card.append(el("p", { class: "limit" }, lim.join(" ")),
      el("details", {}, el("summary", {}, "산정 방법 보기"), el("ol", {},
        el("li", {}, "흉고직경으로 수종군별 상대생장식(Jenkins 등 2003)을 적용해 줄기·가지 무게를 구합니다."),
        el("li", {}, "도시 생육 보정(×0.8 전후), 뿌리 비율, 탄소 비율을 곱해 CO₂로 바꿉니다."),
        el("li", {}, "i-Tree 규칙으로 연간 직경생장을 구하고, 1년 전과의 차이를 흡수량으로 봅니다."),
        el("li", {}, `계수와 측정 오차를 ${nf(P.n_draws)}번 바꿔 계산해 10%–90% 구간을 냅니다.`))));
  }
  return card;
}

// 나무 한 그루 3D·AR(three.js는 처음 열 때만 불러온다)
function view3dButton(t) {
  const btn = el("button", { type: "button", class: "btn small" }, "3D로 보기 · AR");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "3D 준비 중";
    try {
      const { openTreeViewer } = await import("./tree3d.js");
      openTreeViewer({ tree: { id: t.id, species: t.species, info: t.info, model: modelTree(t) }, P, form: FORM, token });
    } catch (e) {
      console.error(e);
      $("#status").textContent = "3D 보기를 열지 못했습니다. 네트워크 연결을 확인해 주세요.";
    } finally {
      btn.disabled = false;
      btn.textContent = "3D로 보기 · AR";
    }
  });
  return btn;
}

function shapeRow(t) {
  if (!t.dbh) return [];
  const g = estimateForm(t.dbh, t.info, FORM);
  const label = FORM.shapes[t.info.crown_shape]?.label || "";
  return [el("dt", {}, "모양(추정)"), el("dd", {}, `${label} · 높이 약 ${nf(g.h)}m · 수관폭 약 ${nf(g.cw)}m`)];
}

function renderSheet(t) {
  const sheet = $("#sheet");
  const g = t.grade;
  const seg = el("div", { class: "seg", role: "group", "aria-label": "탄소 표시 방식" },
    ...[["single", "① 단일값"], ["range", "② 범위"], ["range-limit", "③ 범위+한계"]].map(([key, label]) =>
      el("button", { type: "button", "aria-pressed": String(cond === key), onclick: () => { cond = key; store.write("wg-cond", key); renderSheet(t); } }, label)));
  sheet.replaceChildren(
    el("div", { class: "sheet-head" },
      el("div", {}, el("h2", {}, t.species), el("div", { class: "id" }, `관리번호 ${t.id} · ${t.info.scientific_name}`)),
      el("button", { type: "button", class: "close", "aria-label": "닫기", onclick: closeSheet }, "×")),
    el("dl", { class: "meta" },
      el("dt", {}, "도로구간"), el("dd", {}, t.road),
      el("dt", {}, "흉고직경"), el("dd", {}, t.dbh ? `${nf(t.dbh)} cm${t.block ? " (대표값 의심)" : ""}` : "없음"),
      ...shapeRow(t),
      el("dt", {}, "데이터 품질"), el("dd", {}, el("span", { class: "chip" }, el("span", { class: "dot", style: `background:${GRADE_COLOR[g]}` }), `등급 ${g} · ${GRADE_TEXT[g]}`))),
    el("p", { class: "story" }, storyText(t)),
    t.dbh ? el("div", { class: "row" }, view3dButton(t)) : null,
    seg, carbonCard(t),
    guardianBlock(t));
  sheet.hidden = false;
  sheet.scrollTop = 0;
}

// 보호자와 관찰 기록(데모: 기기 저장)
function guardianBlock(t) {
  const gs = guardians();
  const isGuardian = gs.has(t.id);
  const block = el("div", { class: "block" }, el("h3", {}, isGuardian ? "내가 맡은 나무입니다" : "이 나무의 보호자 되기"));
  const toggle = el("button", { type: "button", class: isGuardian ? "btn ghost small" : "btn small", onclick: () => {
    const s = guardians();
    if (s.has(t.id)) s.delete(t.id); else s.add(t.id);
    if (!store.write("wg-guardian", [...s])) alert("이 브라우저에서는 저장할 수 없습니다.");
    renderSheet(t);
  } }, isGuardian ? "보호자 그만두기" : "보호자 되기");
  block.append(el("div", { class: "row" }, toggle), el("p", { class: "hint" }, "데모에서는 보호자 등록과 기록이 이 기기의 브라우저에만 저장되고 어디로도 전송되지 않습니다."));
  if (!isGuardian) return block;

  const recs = observations(t.id);
  const lastCirc = [...recs].reverse().find(r => r.circ);
  if (lastCirc) block.append(measuredCard(t, lastCirc.circ));
  block.append(observationForm(t));
  if (recs.length) {
    block.append(el("h3", {}, `관찰 기록 ${recs.length}건`), el("ul", { class: "records" },
      ...[...recs].reverse().map(r => el("li", {}, el("time", { datetime: r.t }, r.t.slice(0, 10)),
        [r.season, r.crown, ...(r.signs || []), r.circ ? `둘레 ${nf(r.circ)}cm` : null, r.memo].filter(Boolean).join(" · ")))));
  }
  return block;
}

function observationForm(t) {
  const radioGroup = (name, opts) => el("div", { class: "opts" },
    ...opts.map((o, k) => el("label", {}, el("input", { type: "radio", name, value: o, required: k === 0 ? true : null }), o)));
  const form = el("form", { class: "obs", "aria-label": "관찰 기록" },
    el("fieldset", {}, el("legend", {}, "지금 나무는"), radioGroup("season", SEASONS)),
    el("fieldset", {}, el("legend", {}, "가지와 수관 상태"), radioGroup("crown", CROWN)),
    el("fieldset", {}, el("legend", {}, "눈에 띄는 것(있으면)"),
      el("div", { class: "opts" }, ...SIGNS.map(s => el("label", {}, el("input", { type: "checkbox", name: "signs", value: s }), s)))),
    el("fieldset", {}, el("legend", {}, "흉고둘레(선택) · 땅에서 1.2m 높이를 줄자로 잰 둘레"),
      el("div", { class: "row" }, el("input", { type: "number", name: "circ", min: "5", max: "700", step: "0.5", inputmode: "decimal", "aria-label": "흉고둘레(cm)" }), el("span", {}, "cm"))),
    el("label", {}, el("span", { class: "sr-only" }, "메모"), el("textarea", { name: "memo", maxlength: "300", placeholder: "메모나 나무에게 한마디(선택)" })),
    el("div", { class: "row" }, el("button", { type: "submit", class: "btn small" }, "기록 저장")));
  form.addEventListener("submit", e => {
    e.preventDefault();
    const fd = new FormData(form);
    const circ = Number(fd.get("circ")) || null;
    const rec = { t: new Date().toISOString(), season: fd.get("season"), crown: fd.get("crown"), signs: fd.getAll("signs"), circ, memo: (fd.get("memo") || "").trim() };
    const recs = observations(t.id);
    recs.push(rec);
    if (!store.write(`wg-obs-${t.id}`, recs)) { alert("이 브라우저에서는 저장할 수 없습니다."); return; }
    renderSheet(t);
  });
  return form;
}

function measuredCard(t, circ) {
  const dbhM = circumferenceToDbh(circ);
  // 같은 흉고로 두고 오차만 바꿔야 '직접 잰 효과'를 비교할 수 있다(흉고가 달라지면 흡수량 자체가 달라지므로)
  const unmeasured = simulateTree(modelTree(t, dbhM), P, { n: 3000 });
  const once = simulateTree(modelTree(t, dbhM), P, { n: 3000, dbhCv: 0.01 });
  const twice = simulateTree(modelTree(t, dbhM), P, { n: 3000, dbhCv: 0.01, measuredGrowth: true });
  const w = r => r[2] - r[0];
  const diff = t.dbh ? dbhM / t.dbh - 1 : null;
  const lines = [];
  if (diff !== null && Math.abs(diff) >= 0.2) {
    lines.push(`공공데이터 흉고 ${nf(t.dbh)}cm와 ${pct(Math.abs(diff))} 차이가 납니다. 이런 기록이 모이면 원본 데이터를 바로잡는 근거가 됩니다.`);
  }
  const gain = 1 - w(once.seq) / w(unmeasured.seq);
  if (gain > 0.01) lines.push(`직접 잰 덕분에 범위 폭이 ${pct(gain)} 좁아졌습니다(같은 흉고를 측정 오차가 큰 값으로 계산하면 ${kg(unmeasured.seq[0])}~${kg(unmeasured.seq[2])}kg).`);
  lines.push(`1년 뒤 한 번 더 재면 생장량까지 실측돼 ${kg(twice.seq[0])}~${kg(twice.seq[2])}kg로 더 좁아집니다.`);
  return el("div", { class: "card measured" },
    el("div", { class: "k" }, `내가 잰 흉고 ${nf(dbhM, 1)}cm(둘레 ${nf(circ)}cm)를 반영한 연간 CO₂ 흡수`),
    el("div", { class: "big num" }, `${kg(once.seq[0])}~${kg(once.seq[2])}`, el("small", {}, "kg")), track(once.seq),
    el("p", { class: "limit" }, lines.join(" ")));
}

// 요약 화면
function renderSummary() {
  const box = $("#view-summary");
  if (!S) return;
  const q = S.quality, t = S.totals, X = S.extraction, lt = S.model_notes.large_tree;
  const block = q.issues.find(i => i.code === "dbh_block");
  const mine = [...guardians()].map(id => T.id.indexOf(id)).filter(i => i >= 0);
  box.replaceChildren(el("div", { class: "page-inner" },
    el("h1", {}, "전주 가로수 한눈에 보기"),
    el("p", { class: "notice" }, el("b", {}, "계수 검증 전 · 방법 시연용 "),
      "탄소 수치는 일부 가정값으로 계산한 추정 범위입니다. 보고서나 정책 근거로 인용하지 마세요."),
    el("div", { class: "kpis" },
      kpi("가로수", nf(q.on_map), "그루", X ? `산림청 원본 전주 경계 안 ${nf(X.selected_rows)}행` : ""),
      kpi("CO₂ 저장량", nf(t.storage_t[1]), "t", `80% 범위 ${nf(t.storage_t[0])}–${nf(t.storage_t[2])} t`),
      kpi("연간 CO₂ 흡수량", nf(t.seq_t[1]), "t/년", `80% 범위 ${nf(t.seq_t[0])}–${nf(t.seq_t[2])} t/년`),
      kpi("흉고 대표값 의심", block ? pct(block.share) : "–", "", "같은 구간·수종에서 같은 흉고가 10그루 이상")),
    mine.length ? el("div", {}, el("h2", {}, `내가 맡은 나무 ${mine.length}그루`), el("ul", {},
      ...mine.map(i => el("li", {}, el("a", { href: `#tree-${encodeURIComponent(T.id[i])}` }, `${T.species[T.sp[i]]} · ${T.roads[T.rd[i]]} · ${T.id[i]}`))))) : null,
    el("h2", {}, "수종별"),
    el("div", { class: "tablebox" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "수종"), el("th", { class: "r" }, "그루"), el("th", { class: "r" }, "흉고 중앙값"), el("th", { class: "r" }, "연간 흡수(수종 전체)"), el("th", { class: "r" }, "한 그루 연간 흡수"))),
      el("tbody", {}, ...S.species.slice(0, 12).map(s => el("tr", {},
        el("td", {}, s.species), el("td", { class: "r num" }, nf(s.count)), el("td", { class: "r num" }, `${nf(s.median_dbh)} cm`),
        el("td", { class: "r num" }, `${nf(s.total_seq_t[1], s.total_seq_t[1] < 100 ? 1 : 0)} t`),
        el("td", { class: "r num" }, `${kg(s.rep_seq[0])}–${kg(s.rep_seq[2])} kg`)))))),
    el("h2", {}, "원본 데이터에서 확인한 것"),
    el("ul", {},
      X ? el("li", {}, `원본은 전북 지역 ${nf(X.national_blank_sgg_rows)}행의 시군구명이 비어 있어, 전주 경계 안의 좌표로 전주 나무를 골랐습니다.`) : null,
      q.dbh_digits ? el("li", {}, `흉고 끝자리가 0이나 5인 값이 ${pct(q.dbh_digits.share_0_or_5, 1)}입니다(고르게 분포하면 약 20%).`) : null,
      block ? el("li", {}, `${pct(block.share)}의 나무가 같은 구간·수종에서 똑같은 흉고를 공유합니다. 나무마다 잰 값이 아닐 가능성이 커서, 시민 측정이 가장 먼저 필요한 항목입니다.`) : null,
      lt ? el("li", {}, `흉고 ${nf(lt.threshold_cm)}cm 이상 큰 나무 ${nf(lt.count)}그루가 연간 흡수량의 ${pct(lt.share_seq_p50, 1)}를 차지합니다.`) : null),
    el("p", {}, el("a", { href: "report/jeonju.html" }, "전주 분석 보고서 전체 보기"), " · ", el("a", { href: "report/sample.html" }, "합성 샘플 보고서"))));
}
function kpi(label, value, unit, sub) {
  return el("div", { class: "kpi" }, el("div", { class: "label" }, label), el("div", { class: "value num" }, value, unit ? el("small", {}, unit) : null), el("div", { class: "sub" }, sub));
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!map || !map.getLayer("trees")) return;
  map.setPaintProperty("trees", "circle-color", ["case", ["<", ["get", "s"], 0], token("--surface"), seqColorExpr()]);
  map.setPaintProperty("clusters", "circle-color", token("--accent"));
});

main();
