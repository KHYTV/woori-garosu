// 시민 직접 나무 등록: 지도 화면의 '나무 등록' → 위치(GPS·핀 조정·지도 누르기) → 사진 → 수종(목록·AI·모르겠어요) → 둘레(선택) → 저장.
// 등록 나무는 지도에 '시민 등록 · 미검증' 모양(속 빈 고리)으로 따로 보이고, 누르면 카드와 친구 맺기가 열린다.
// 저장은 기기(usertrees.js)에, 온라인 참여 중이고 서버에 user_trees가 있으면 동의 후 위치·수종·지름만 공유한다(사진은 올리지 않음).
import { treeSVG, hashSeed, signatureColor } from "./characters.js";
import { distanceM, nearestTrees, reverseGeocode } from "./geo.js";
import { circumferenceToDbh } from "./carbon.js";
import { db, compressImage } from "./db.js";
import { userTrees, userRecord, newUserTreeId, insidePolygon, guessDong, isUserTreeId, SOURCE_KO } from "./usertrees.js";
import * as cloud from "./cloud.js";

let C = null;                 // home.js가 넘겨주는 화면 도구와 상태
const local = new Map();      // 이 기기에 저장된 등록 나무(내가 등록 + 친구 맺으며 받아 둔 공유 나무)
const remote = new Map();     // 서버에서 받은 다른 사람의 공유 나무
let boundary = null, mm = null, reg = null, regMarker = null, cloudReady = null, plantnetKey = null;
const $ = sel => document.querySelector(sel);

const ICON = {
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  nav: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8z"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>`,
};

// ---------- 준비 ----------
export async function init(ctx) {
  C = ctx;
  for (const u of await userTrees.all()) local.set(u.id, u);
  try { const r = await fetch("data/boundary.geojson"); if (r.ok) boundary = await r.json(); } catch { /* 사각 범위로 */ }
  // (선택) Pl@ntNet 키가 설정돼 있으면 AI 수종 인식에 먼저 쓴다. 기본은 없음
  fetch("data/backend.json").then(r => (r.ok ? r.json() : null)).then(b => { plantnetKey = b?.plantnet_key || null; }).catch(() => {});
}
export const isUserTree = isUserTreeId;
export const active = () => Boolean(reg);
// 화면용 기록(원본 treeRecord와 같은 꼴). 없으면 null
export function record(id) {
  const u = local.get(id) || remote.get(id);
  if (!u) return null;
  // 친구 맺은 뒤 '둘레 재기'로 잰 값이 있으면 가장 최근 값으로 흉고를 다시 잡는다
  const measured = C.state.posts?.find(p => p.treeId === id && p.circ);
  return userRecord(measured ? { ...u, circ: measured.circ, dbh: null } : u, C);
}
const inside = (lon, lat) => insidePolygon(lon, lat, boundary);
const colorOf = r => signatureColor(r.species, r.info);
const avatarSvg = (r, size, mood = "happy") => C.svg(treeSVG({ species: r.species, info: r.info, dbh: r.dbh || 15, form: C.FORM, season: C.season, style: "character", mood, seed: hashSeed(r.id), size, label: r.species }));
const speciesLabel = r => (r.speciesSource === "unknown" ? "수종 모름" : r.species);

// ---------- 온라인(선택) ----------
// 서버에 user_trees 표·함수가 없으면 조용히 기기 저장만 한다
function cloudAvailable() {
  if (!cloud.configured()) return Promise.resolve(false);
  if (!cloudReady) cloudReady = cloud.userTreesApi.available().catch(() => false);
  return cloudReady;
}
async function fetchShared() {
  if (!mm || !(await cloudAvailable())) return;
  const b = mm.map.getBounds();
  const pad = 0.01;
  try {
    const rows = await cloud.userTreesApi.inBbox(b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad);
    let added = 0;
    for (const x of rows || []) {
      if (local.has(x.id)) continue;
      if (!remote.has(x.id)) added++;
      remote.set(x.id, { id: x.id, lon: x.lon, lat: x.lat, species: x.species, speciesSource: x.species_source, dbh: x.dbh ? Number(x.dbh) : null, dong: x.dong,
        verified: x.verified, created: x.created_on, origin: "shared", shared: true });
    }
    paint();
    // 목록을 보고 있을 때만 새로 받은 공유 나무를 목록에 반영한다(카드·등록 중에는 그대로)
    const sheet = $("#mapSheet");
    if (added && !reg && C.state.near.center && C.state.near.picked == null && sheet && !sheet.querySelector(".detail-head")) C.backToList();
  } catch (err) { console.warn("공유 나무를 불러오지 못했어요", err); }
}

// ---------- 지도 ----------
export function attachMap(m) {
  mm = m;
  const map = m.map;
  if (!map.getSource("user-trees")) {
    map.addSource("user-trees", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("user-reg-acc", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "user-reg-acc-fill", type: "fill", source: "user-reg-acc", paint: { "fill-color": "#1B64DA", "fill-opacity": 0.12 } });
    map.addLayer({ id: "user-reg-acc-line", type: "line", source: "user-reg-acc", paint: { "line-color": "#1B64DA", "line-width": 1.5, "line-opacity": 0.6 } });
    // 시민 등록 · 미검증: 속이 흰 고리 + 작은 심(원본 가로수는 꽉 찬 점)
    map.addLayer({ id: "user-trees-ring", type: "circle", source: "user-trees",
      paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 3.5, "circle-opacity": ["case", ["get", "shared"], 0.85, 1] } });
    map.addLayer({ id: "user-trees-core", type: "circle", source: "user-trees", paint: { "circle-radius": 2.6, "circle-color": ["get", "color"] } });
    map.addLayer({ id: "user-trees-label", type: "symbol", source: "user-trees", minzoom: 16,
      layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-allow-overlap": false },
      paint: { "text-color": C.token("--ink"), "text-halo-color": C.token("--surface"), "text-halo-width": 1.4 } });
    map.on("click", "user-trees-ring", e => { if (reg) return; const f = e.features?.[0]; if (f) openCard(f.properties.id); });
    map.on("mouseenter", "user-trees-ring", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "user-trees-ring", () => { map.getCanvas().style.cursor = ""; });
    map.on("click", e => { if (reg && reg.step === 1) setPos(e.lngLat.lng, e.lngLat.lat, "tap"); });
    map.on("moveend", () => { clearTimeout(attachMap.t); attachMap.t = setTimeout(fetchShared, 600); });
  }
  paint();
  fetchShared();
  document.body.dataset.userMap = "ready";
}
function paint() {
  if (!mm) return;
  const feats = [];
  const ids = new Set();
  for (const src of [local, remote]) {
    for (const u of src.values()) {
      if (ids.has(u.id)) continue;
      ids.add(u.id);
      const r = userRecord(u, C), mine = C.myTree(u.id);
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] },
        properties: { id: r.id, color: colorOf(r), shared: r.origin === "shared", label: mine ? mine.name : `${speciesLabel(r)} · 시민 등록` } });
    }
  }
  mm.map.getSource("user-trees")?.setData({ type: "FeatureCollection", features: feats });
  const chip = $("#userLegend");
  if (chip) chip.hidden = !feats.length;
}
export const refresh = paint;

// 지도 화면 위쪽에 '나무 등록' 버튼과 등록 중 상단 막대를 붙인다
export function mountMapUI(box) {
  const top = box.querySelector(".map-top");
  if (!top || top.querySelector(".user-reg-bar")) return;
  top.append(
    el("div", { class: "user-reg-bar" },
      el("span", { class: "user-legend", id: "userLegend", hidden: true }, el("i"), "시민 등록 · 미검증"),
      el("button", { type: "button", class: "user-reg-btn", onclick: startRegister }, C.svg(ICON.plus), "나무 등록")),
    el("div", { class: "user-reg-top" },
      el("button", { type: "button", class: "sq-btn ink", "aria-label": "등록 그만두기", onclick: cancelRegister }, C.svg(ICON.close)),
      el("span", { class: "map-pill", id: "userRegPill" }, "나무 등록")));
}

// 근처 목록에 반경 안의 등록 나무를 앞에 붙이고, 끝에 '직접 등록' 안내를 단다
export function decorateList(sheet) {
  paint(); // 친구 이름이 바뀌었을 수 있어 지도 글자도 새로
  const { center, radius } = C.state.near;
  if (!sheet || !center) return;
  const near = [];
  for (const src of [local, remote]) for (const u of src.values()) {
    if (near.some(n => n.u.id === u.id)) continue;
    const d = distanceM(center.lon, center.lat, u.lon, u.lat);
    if (d <= radius) near.push({ u, d });
  }
  near.sort((a, b) => a.d - b.d);
  if (near.length) {
    const rows = near.map(({ u, d }) => {
      const r = userRecord(u, C), mine = C.myTree(r.id);
      return el("button", { type: "button", class: "row-tree user", "data-user": r.id, "aria-pressed": "false", onclick: () => openCard(r.id) },
        el("span", { class: "av", style: `background:${C.tint(r.species)}` }, avatarSvg(r, 66)),
        el("span", { class: "txt" }, el("b", {}, mine ? `${mine.name} · ${speciesLabel(r)}` : speciesLabel(r)),
          el("span", {}, `시민 등록 · 미검증${r.dbh ? ` · 지름 ${C.nf(r.dbh)}cm` : ""}${mine ? " · 내 나무" : ""}`)),
        el("span", { class: "dist" }, `${Math.round(d)}m`));
    });
    let list = sheet.querySelector(".tree-rows");
    if (!list) {
      list = el("div", { class: "tree-rows" });
      sheet.querySelector(".head")?.after(list);
      sheet.classList.remove("empty");
      const h = sheet.querySelector(".head h2");
      if (h) h.textContent = `시민 등록 나무 ${near.length}그루`;
    }
    list.prepend(...rows);
  }
  sheet.append(el("div", { class: "user-reg-cta" }, el("span", {}, "찾는 나무가 목록에 없나요?"),
    el("button", { type: "button", class: "btn small", onclick: startRegister }, "직접 등록하기")));
}

// ---------- 등록 흐름 ----------
const STEPS = ["위치", "사진", "수종", "둘레"];
function startRegister() {
  if (!mm) { C.toast("지도를 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요.", true); return; }
  reg = { step: 1, pos: null, gps: null, gpsState: "finding", gpsError: null, how: null, photo: null, aiPhoto: null,
    species: null, source: "unknown", ai: null, aiState: null, circ: null, share: false };
  C.state.near.map?.setSelected(null);
  document.body.classList.add("user-registering");
  renderStep();
  findGPS();
}
function cancelRegister() {
  if (!reg) return;
  endRegister();
  C.backToList();
}
function endRegister() {
  reg = null;
  regMarker?.remove(); regMarker = null;
  mm?.map.getSource("user-reg-acc")?.setData({ type: "FeatureCollection", features: [] });
  document.body.classList.remove("user-registering");
  $("#mapSheet")?.classList.remove("user-tall");
}
function circle(lon, lat, m) {
  const ring = [];
  for (let k = 0; k <= 48; k++) {
    const a = k / 48 * Math.PI * 2;
    ring.push([lon + m * Math.cos(a) / (111320 * Math.cos(lat * Math.PI / 180)), lat + m * Math.sin(a) / 111320]);
  }
  return { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} }] };
}
function findGPS() {
  if (!reg) return;
  reg.gpsState = "finding"; reg.gpsError = null;
  renderStep();
  if (!navigator.geolocation) { reg.gpsState = "fail"; reg.gpsError = "이 기기에서는 위치를 쓸 수 없어요."; renderStep(); return; }
  navigator.geolocation.getCurrentPosition(p => {
    if (!reg) return;
    reg.gps = { lon: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy };
    reg.gpsState = "ok";
    mm.map.getSource("user-reg-acc")?.setData(circle(reg.gps.lon, reg.gps.lat, Math.max(3, reg.gps.acc)));
    setPos(reg.gps.lon, reg.gps.lat, "gps");
    mm.map.easeTo({ center: [reg.gps.lon, reg.gps.lat], zoom: 19, duration: 400, padding: { bottom: Math.round(mm.map.getContainer().clientHeight * 0.45) } });
  }, err => {
    if (!reg) return;
    reg.gpsState = "fail";
    reg.gpsError = err.code === 1 ? "위치 권한이 꺼져 있어요." : "위치를 받지 못했어요.";
    renderStep();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}
function setPos(lon, lat, how) {
  if (!reg) return;
  reg.pos = { lon, lat };
  reg.how = how;
  if (!regMarker) {
    const pin = el("div", { class: "user-pin", title: "끌어서 나무 자리에 맞춰요" }, el("span"));
    regMarker = new window.maplibregl.Marker({ element: pin, draggable: true, anchor: "bottom" }).setLngLat([lon, lat]).addTo(mm.map);
    regMarker.on("dragend", () => { const p = regMarker.getLngLat(); setPos(p.lng, p.lat, "drag"); });
  } else regMarker.setLngLat([lon, lat]);
  if (reg.step === 1) renderStep();
}

function sheetHead(title) {
  $("#userRegPill").textContent = `나무 등록 · ${reg.step}/${STEPS.length} ${STEPS[reg.step - 1]}`;
  return [el("span", { class: "handle" }), el("div", { class: "head" }, el("h2", {}, title), el("span", { class: "sub" }, `${reg.step}/${STEPS.length}`)),
    el("ol", { class: "user-steps", "aria-label": "등록 단계" }, ...STEPS.map((s, k) => el("li", { class: k + 1 < reg.step ? "done" : k + 1 === reg.step ? "now" : "" }, s)))];
}
const go = step => { reg.step = step; renderStep(); };
function navRow(next, { nextLabel = "다음", nextDisabled = false, back = true } = {}) {
  return el("div", { class: "user-nav" },
    back ? el("button", { type: "button", class: "btn ghost big", onclick: () => go(reg.step - 1) }, "이전") : el("span"),
    el("button", { type: "button", class: "btn big", disabled: nextDisabled, onclick: next }, nextLabel));
}
function renderStep() {
  if (!reg) return;
  const sheet = $("#mapSheet");
  if (!sheet) return;
  sheet.classList.remove("empty");
  sheet.classList.toggle("user-tall", reg.step > 1);
  const parts = [stepLocation, stepPhoto, stepSpecies, stepSize][reg.step - 1]();
  sheet.replaceChildren(...sheetHead(parts.title), ...parts.body);
  sheet.scrollTop = 0;
}

// 1. 위치
function stepLocation() {
  const { pos, gps, gpsState } = reg;
  const ok = pos && inside(pos.lon, pos.lat);
  let status;
  if (gpsState === "finding" && !pos) status = el("p", { class: "user-status" }, el("span", { class: "spinner" }), "내 위치를 찾는 중…");
  else if (gpsState === "fail" && !pos) status = el("p", { class: "user-status warn" }, `${reg.gpsError} 지도를 눌러 나무가 서 있는 자리를 찍어 주세요.`);
  else {
    const moved = gps && pos ? distanceM(gps.lon, gps.lat, pos.lon, pos.lat) : null;
    status = el("div", { class: "user-status" },
      gps ? el("b", {}, `GPS 정확도 ±${Math.round(gps.acc)}m`) : el("b", {}, "지도에서 고른 위치"),
      reg.how !== "gps" && moved !== null ? el("span", {}, ` · 핀을 GPS에서 ${Math.round(moved)}m 옮겼어요`) : null,
      gps && gps.acc > 25 && reg.how === "gps" ? el("div", { class: "sub warn" }, "정확도가 낮아요. 핀을 끌어 실제 나무 자리에 맞춰 주세요.") : null);
  }
  const body = [status,
    el("p", { class: "caption left" }, "파란 핀을 끌거나 지도를 눌러 나무 줄기 자리에 맞춰요. 건물 안이면 밖에 나와서 다시 찾으면 더 정확해요.")];
  if (pos && !ok) body.push(el("div", { class: "note-box warn" }, C.svg(ICON.info), el("span", {}, "전주시 밖이에요. 우리동네가로수는 전주 안의 나무만 등록할 수 있어요.")));
  // 이미 있는 나무와 겹치는지(대장 가로수 4m, 등록 나무 3m 안)
  if (ok) {
    const [pub] = nearestTrees(C.T, pos.lon, pos.lat, { radius: 4, limit: 1 });
    const dup = [...local.values(), ...remote.values()].find(u => distanceM(u.lon, u.lat, pos.lon, pos.lat) <= 3);
    if (pub) {
      const sp = C.T.species[C.T.sp[pub.i]];
      body.push(el("div", { class: "note-box" }, C.svg(ICON.info), el("span", {}, `${Math.round(pub.d)}m 옆에 대장에 있는 ${sp}가 있어요. 같은 나무라면 그 나무와 친구를 맺어 주세요. `,
        el("button", { type: "button", class: "btn ghost small", onclick: () => { endRegister(); C.selectTree(pub.i); } }, "그 나무 보기"))));
    } else if (dup) {
      body.push(el("div", { class: "note-box" }, C.svg(ICON.info), el("span", {}, "바로 옆에 이미 시민이 등록한 나무가 있어요. ",
        el("button", { type: "button", class: "btn ghost small", onclick: () => { endRegister(); openCard(dup.id); } }, "그 나무 보기"))));
    }
  }
  body.push(el("div", { class: "user-nav" },
    el("button", { type: "button", class: "btn ghost big", disabled: reg.gpsState === "finding", onclick: findGPS }, "다시 찾기"),
    el("button", { type: "button", class: "btn big", disabled: !ok, onclick: () => go(2) }, "이 위치로 다음")));
  return { title: "나무 위치를 정해요", body };
}

// 2. 사진
function photoPicker(label, { capture = false, onPick }) {
  const input = el("input", { type: "file", accept: "image/*", capture: capture ? "environment" : false, class: "sr-only" });
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    try { onPick(await compressImage(f)); } catch (e) { C.toast(e.message, true); }
  });
  return el("label", { class: `btn ${capture ? "" : "ghost"} big user-file` }, label, input);
}
function stepPhoto() {
  const body = [
    el("div", { class: "user-photo-row" },
      photoPicker("📷 사진 찍기", { capture: true, onPick: b => { reg.photo = b; renderStep(); } }),
      photoPicker("🖼️ 앨범에서", { onPick: b => { reg.photo = b; renderStep(); } })),
    reg.photo ? el("img", { class: "user-photo", src: URL.createObjectURL(reg.photo), alt: "등록할 나무 사진" }) : el("div", { class: "user-photo empty" }, "아직 사진이 없어요"),
    el("p", { class: "caption left" }, "줄기와 잎이 함께 보이게 찍어요. 사진은 이 기기에만 저장되고 서버에는 올라가지 않아요."),
    navRow(() => go(3), { nextLabel: reg.photo ? "다음" : "사진 없이 다음" }),
  ];
  return { title: "나무 사진을 찍어요", body };
}

// 3. 수종
function stepSpecies() {
  const list = C.S.species.map(s => s.species).filter(s => s !== "기타");
  const choose = (species, source) => { reg.species = species; reg.source = species ? source : "unknown"; renderStep(); };
  const chip = (species, label, source, extra = null) => {
    const pressed = species ? reg.species === species : !reg.species;
    const info = C.S.species_info[species || "기타"];
    return el("button", { type: "button", class: "user-sp", "aria-pressed": String(pressed), onclick: () => choose(species, source) },
      el("span", { class: "av", style: `background:${C.tint(species || "기타")}` }, C.svg(treeSVG({ species: species || "기타", info, dbh: 20, form: C.FORM, season: C.season, style: "character", mood: species ? "happy" : "sleepy", seed: hashSeed(species || "?"), size: 60, label: label }))),
      el("b", {}, label), extra);
  };
  const ai = aiBox(list, choose);
  const body = [
    ai,
    el("div", { class: "user-sp-grid", role: "group", "aria-label": "수종 고르기" },
      chip(null, "모르겠어요", "unknown", el("span", { class: "sub" }, "나중에 바꿔도 돼요")),
      ...list.map(sp => chip(sp, sp, reg.ai?.top.some(t => t.species === sp) && reg.source === "ai" && reg.species === sp ? "ai" : "user"))),
    el("p", { class: "caption left" }, `지금 고른 것: ${reg.species ? `${reg.species}${reg.source === "ai" ? " (AI 추정)" : ""}` : "모르겠어요"}`),
    navRow(() => go(4)),
  ];
  return { title: "어떤 나무인가요?", body };
}
function aiBox(list, choose) {
  const box = el("section", { class: "user-ai" });
  const run = async blob => {
    reg.aiState = { busy: true, text: "AI를 준비하는 중…", pct: 0 };
    renderStep();
    try {
      const { identifyLeaf, identifyPlantNet, MODEL_MB } = await import("./leafid.js");
      let res;
      const key = plantnetKey;
      if (key) { try { res = await identifyPlantNet(blob, { key, S: C.S }); } catch (e) { console.warn("Pl@ntNet 실패, 기기 AI로", e); } }
      if (!res?.top?.length) {
        res = await identifyLeaf(blob, { candidates: list, onProgress: p => {
          if (!reg?.aiState) return;
          reg.aiState.text = p.text; reg.aiState.pct = p.pct ?? 0;
          const bar = document.querySelector(".user-ai progress"), t = document.querySelector(".user-ai .ai-text");
          if (bar) bar.value = reg.aiState.pct; if (t) t.textContent = p.text;
        } });
      }
      if (!reg) return;
      reg.ai = { model: res.model, top: res.top.map(t => ({ species: t.species, p: Math.round(t.p * 1000) / 1000 })), notTree: res.notTree, ms: res.ms, loadMs: res.loadMs };
      reg.aiState = null;
      window.__wgLeafTiming = { loadMs: res.loadMs, inferMs: res.ms, model: res.model, MB: MODEL_MB[res.model] };
    } catch (err) {
      console.error(err);
      if (reg) reg.aiState = { error: `AI를 쓰지 못했어요 (${err.message}). 목록에서 고르거나 '모르겠어요'로 등록해 주세요.` };
    }
    renderStep();
  };
  const leafPick = photoPicker(reg.aiPhoto ? "잎 사진 다시 고르기" : "잎 사진 따로 고르기", { onPick: b => { reg.aiPhoto = b; run(b); } });
  leafPick.classList.remove("big"); leafPick.classList.add("small");
  const st = reg.aiState;
  if (st?.busy) {
    box.append(el("div", { class: "k" }, "AI로 알아보는 중"), el("progress", { max: "100", value: String(st.pct || 0) }), el("p", { class: "ai-text small" }, st.text));
    return box;
  }
  box.append(el("div", { class: "row between" }, el("div", { class: "k" }, "잎 사진으로 AI에게 물어보기"),
    el("button", { type: "button", class: "btn small", onclick: () => { const b = reg.aiPhoto || reg.photo; if (b) run(b); else leafPick.querySelector("input").click(); } }, "🔍 AI로 알아보기")));
  if (st?.error) box.append(el("p", { class: "small warn" }, st.error));
  if (reg.ai) {
    const label = p => (p >= 0.6 ? "가능성 높음" : p >= 0.3 ? "가능성 있음" : "가능성 낮음");
    box.append(...[
      reg.ai.notTree ? el("p", { class: "small warn" }, "나무나 잎이 잘 안 보여요. 잎 한두 장을 가까이 찍어 다시 해 보세요.") : null,
      el("div", { class: "user-ai-top" }, ...reg.ai.top.map((t, k) => el("button", { type: "button", class: "user-ai-pick", "aria-pressed": String(reg.species === t.species && reg.source === "ai"), onclick: () => choose(t.species, "ai") },
        el("span", { class: "rank" }, `${k + 1}`), el("b", {}, t.species), el("span", { class: "pct" }, `${Math.round(t.p * 100)}%`), el("span", { class: "sub" }, label(t.p))))),
      el("p", { class: "small" }, "AI 추정이라 자주 틀려요. 시험 사진에서 1순위가 맞은 건 절반쯤, 3개 안에 든 건 4번 중 3번쯤이에요. 맞다고 생각하는 것을 눌러야 정해지고, 모르면 '모르겠어요'로 두세요.")].filter(Boolean));
  } else {
    box.append(el("p", { class: "small" }, `${reg.photo ? "찍은 사진" : "잎 사진"}으로 전주 가로수 ${list.length}종 중 비슷한 3종을 골라 줘요. 처음 한 번 AI 모델(약 90MB, 와이파이 권장)을 받아요. 사진은 기기 밖으로 나가지 않아요.`));
  }
  box.append(el("div", { class: "row" }, leafPick));
  return box;
}

// 4. 둘레와 저장
function stepSize() {
  const input = el("input", { type: "number", name: "circ", min: "5", max: "700", step: "0.5", inputmode: "decimal", placeholder: "둘레 cm", "aria-label": "줄기 둘레(cm)", value: reg.circ ?? "" });
  const out = el("p", { class: "user-dbh" });
  const show = () => {
    const c = Number(input.value);
    reg.circ = c >= 5 && c <= 700 ? c : null;
    if (!reg.circ) { out.textContent = "둘레를 넣으면 흉고 지름과 한 해 CO₂ 흡수(추정)를 보여 줘요."; return; }
    const r = userRecord({ id: "preview", lon: reg.pos.lon, lat: reg.pos.lat, species: reg.species, circ: reg.circ }, C);
    out.replaceChildren(el("b", {}, `흉고 지름 약 ${C.nf(circumferenceToDbh(reg.circ), 1)}cm`),
      r.seq[1] !== null ? ` · 한 해 CO₂ 약 ${C.kg(r.seq[0])}~${C.kg(r.seq[2])}kg (추정${reg.species ? "" : ", 수종 모름이라 더 불확실"})` : "");
  };
  input.addEventListener("input", show);
  show();
  const share = el("div", { class: "user-share", id: "userShare" });
  cloudAvailable().then(okServer => {
    if (!okServer) return;
    if (!C.cloudOn()) { share.append(el("p", { class: "small" }, "온라인에 참여하면 이 나무를 다른 사람 지도에도 공유할 수 있어요.")); return; }
    const box = el("input", { type: "checkbox", checked: reg.share || false });
    box.addEventListener("change", () => { reg.share = box.checked; });
    share.append(el("label", { class: "user-check" }, box, el("span", {}, el("b", {}, "온라인 지도에 공유하기 (선택)"),
      el("span", { class: "sub" }, "공유하면 나무 위치(약 1m 단위)·수종·지름·등록 날짜가 누구나 보는 지도에 올라가요. 사진·닉네임·등록 시각은 올라가지 않아요. 집 마당 같은 사유지 나무는 공유하지 마세요."))));
  });
  const body = [
    el("div", { class: "row" }, input, el("span", {}, "cm")),
    out,
    el("p", { class: "caption left" }, "땅에서 1.2m(가슴 높이)에서 줄기를 줄자로 한 바퀴 재요. 몰라도 등록할 수 있어요."),
    share,
    el("div", { class: "note-box" }, C.svg(ICON.info), el("span", {}, "등록한 나무는 '시민 등록 · 미검증'으로 보여요. 수치는 모두 추정값이에요.")),
    navRow(save, { nextLabel: "등록하기" }),
  ];
  return { title: "줄기 둘레를 재요 (선택)", body };
}

async function save() {
  if (!reg?.pos || !inside(reg.pos.lon, reg.pos.lat)) { C.toast("전주 안에서만 등록할 수 있어요.", true); go(1); return; }
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const { pos } = reg;
  const u = {
    id: newUserTreeId(), lon: r6(pos.lon), lat: r6(pos.lat), acc: reg.how === "gps" && reg.gps ? Math.round(reg.gps.acc) : null, how: reg.how,
    species: reg.species, speciesSource: reg.species ? reg.source : "unknown", ai: reg.ai ? { model: reg.ai.model, top: reg.ai.top } : null,
    circ: reg.circ, dbh: reg.circ ? Math.round(circumferenceToDbh(reg.circ) * 10) / 10 : null, photo: reg.photo || null,
    dong: guessDong(C.T, pos.lon, pos.lat), place: null, created: new Date().toISOString(), origin: "mine", verified: false, shared: false,
  };
  const wantShare = reg.share;
  await userTrees.put(u);
  local.set(u.id, u);
  endRegister();
  paint();
  if (wantShare) shareTree(u);
  // 지도 주소는 뒤에서 받아 채운다(실패해도 등록은 그대로)
  reverseGeocode(u.lon, u.lat).then(async a => {
    if (!a) return;
    u.place = { text: a.text, road: a.road, dong: a.dong || a.hjd };
    await userTrees.put(u);
  }).catch(() => {});
  openCard(u.id);
  C.toast("등록했어요. 이름을 지어 친구가 되어 볼까요?");
  setTimeout(() => { if (!C.myTree(u.id)) C.befriend(record(u.id)); }, 400);
}
async function shareTree(u) {
  try {
    await cloud.userTreesApi.share({ id: u.id, species: u.speciesSource === "unknown" ? null : u.species, species_source: u.speciesSource, dbh: u.dbh, lon: u.lon, lat: u.lat, dong: u.dong });
    u.shared = true;
    await userTrees.put(u);
    C.toast("온라인 지도에 공유했어요");
  } catch (err) { console.warn("공유 실패", err); C.toast(`공유하지 못했어요 (${err.message}). 기기에는 저장됐어요.`, true); }
}

// ---------- 카드 ----------
export function openCard(id) {
  const r = record(id);
  if (!r) return;
  const mine = C.myTree(id);
  const near = C.state.near;
  near.picked = null;
  const d = near.center ? distanceM(near.center.lon, near.center.lat, r.lon, r.lat) : null;
  near.map?.setSelected({ lon: r.lon, lat: r.lat, label: d !== null ? `여기서 ${Math.round(d)}m` : (mine?.name || speciesLabel(r)), color: colorOf(r) }, "sheet");
  $("#mapSearch")?.replaceChildren(el("button", { type: "button", class: "sq-btn ink", "aria-label": "목록으로", onclick: () => C.backToList() }, C.svg(ICON.back)),
    el("span", { class: "map-pill" }, "시민 등록 나무"));
  for (const b of document.querySelectorAll(".row-tree")) b.setAttribute("aria-pressed", String(b.dataset.user === id));
  const sheet = $("#mapSheet");
  sheet.classList.remove("empty");
  const seq = r.seq[1] !== null ? `${C.kg(r.seq[0])}~${C.kg(r.seq[2])}` : "-";
  const label = encodeURIComponent(`${mine?.name || speciesLabel(r)} (시민 등록 나무)`);
  const where = [...new Set([r.place.text || r.road, r.dong].filter(Boolean))].join(" · ");
  sheet.replaceChildren(...[el("span", { class: "handle" }),
    el("div", { class: "detail-head" },
      el("span", { class: "av", style: `background:${C.tint(r.species)}` }, avatarSvg(r, 96)),
      el("div", { style: "flex:1 1 auto;min-width:0" }, el("div", { class: "name" }, mine ? mine.name : speciesLabel(r)),
        el("div", { class: "meta2" }, `${mine ? speciesLabel(r) + " · " : ""}${where}`)),
      d !== null ? el("span", { class: "dist" }, `${Math.round(d)}m`) : null),
    el("div", { class: "badges" }, el("span", { class: "badge user" }, r.origin === "shared" ? "시민 공유 · 미검증" : "시민 등록 · 미검증"),
      r.speciesSource === "ai" ? el("span", { class: "badge soft" }, "수종 AI 추정") : null, r.shared && r.origin === "mine" ? el("span", { class: "badge soft" }, "온라인 공유 중") : null),
    r.photo ? el("img", { class: "user-photo card", src: URL.createObjectURL(r.photo), alt: `${speciesLabel(r)} 사진` }) : null,
    el("div", { class: "tiles" }, C.tile("줄기 지름", r.dbh ? C.nf(r.dbh) : "-", "cm"), C.tile("높이(추정)", r.heightM ? `약 ${C.nf(r.heightM)}` : "-", "m"), C.tile("한 해 CO₂(추정)", seq, "kg")),
    el("div", { class: "note-box" }, C.svg(ICON.info), el("span", {}, `시민이 직접 등록한 나무예요. 산림청 대장에 없고 아직 검증되지 않았어요. 수종: ${SOURCE_KO[r.speciesSource]}.${r.dbh ? "" : " 둘레를 재면 탄소 흡수(추정)를 계산해요."}`)),
    el("div", { class: "action-row" },
      mine ? el("a", { class: "btn big", href: `#tree/${encodeURIComponent(id)}` }, "내 나무 보기") : el("button", { type: "button", class: "btn big", onclick: () => C.befriend(r) }, "친구 맺기 · 보호자 되기"),
      el("a", { class: "sq-btn", "aria-label": "카카오맵 길찾기", href: `https://map.kakao.com/link/to/${label},${r.lat},${r.lon}`, target: "_blank", rel: "noopener" }, C.svg(ICON.nav))),
    el("details", {}, el("summary", {}, "등록 정보"), identRows(r),
      r.origin === "mine" ? el("div", { class: "row" }, el("button", { type: "button", class: "btn ghost small danger", onclick: () => removeTree(r) }, "등록 지우기")) : null)].filter(Boolean));
  sheet.scrollTop = 0;
}
// 나무 프로필·카드의 식별 정보(원본 나무의 관리번호 자리)
export function identRows(r, extra = []) {
  const when = r.created ? new Date(r.created).toLocaleDateString("ko-KR") : "-";
  return el("dl", { class: "meta ident" },
    el("dt", {}, "등록 번호"), el("dd", { class: "num" }, `${r.id} (시민 등록, 미검증)`),
    el("dt", {}, "지도 주소"), el("dd", {}, r.place?.text || "주소 정보 없음", el("small", { class: "sub" }, r.place?.text ? " · OpenStreetMap 기준" : "")),
    r.dong ? el("dt", {}, "행정동") : null, r.dong ? el("dd", {}, `${r.dong} (가까운 가로수 기준 어림)`) : null,
    el("dt", {}, "좌표"), el("dd", { class: "num" }, `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}${r.acc ? ` (GPS ±${r.acc}m)` : ""}`),
    el("dt", {}, "수종"), el("dd", {}, `${speciesLabel(r)} · ${SOURCE_KO[r.speciesSource]}`,
      r.ai?.top?.length ? el("div", { class: "sub" }, `AI 후보: ${r.ai.top.map(t => `${t.species} ${Math.round(t.p * 100)}%`).join(", ")}`) : null),
    el("dt", {}, "흉고직경"), el("dd", {}, r.dbh ? `${C.nf(r.dbh, 1)}cm${r.circ ? ` (둘레 ${C.nf(r.circ)}cm로 환산)` : ""}` : "재지 않음"),
    el("dt", {}, "등록"), el("dd", {}, `${when}${r.origin === "shared" ? " · 다른 시민이 공유" : " · 이 기기"}`),
    ...extra);
}
function removeTree(r) {
  C.dialog("등록을 지울까요?", el("p", { class: "dialog-body" }, `이 기기에서 등록 기록${C.myTree(r.id) ? "과 친구 기록(사진·대화)" : ""}이 지워져요.${r.shared ? " 온라인 공유도 내려요." : ""}`), { confirm: "지우기", onConfirm: async () => {
    await userTrees.remove(r.id);
    local.delete(r.id);
    if (C.myTree(r.id)) { await db.deleteTree(r.id); if (C.cloudOn()) cloud.api.unfollow(r.id).catch(() => {}); }
    if (r.shared && C.cloudOn()) cloud.userTreesApi.unshare(r.id).catch(err => console.warn("공유 내리기 실패", err));
    await C.refreshMine();
    paint();
    C.backToList();
    C.toast("등록을 지웠어요");
  } });
}
// 다른 사람이 공유한 나무와 친구를 맺으면 기기에도 사본을 둔다(새로고침 뒤에도 내 나무로 보이게)
export async function keepCopy(id) {
  if (local.has(id) || !remote.has(id)) return;
  const u = { ...remote.get(id) };
  await userTrees.put(u);
  local.set(id, u);
}

function el(tag, attrs = {}, ...kids) { return C.el(tag, attrs, ...kids); }
