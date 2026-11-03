// 동네 전체 보기: 행정동(법정동) 경계를 큰 지도에 그리고 경계 안 모든 가로수를 점으로 보여 준다.
// 경계는 docs/data/dongs.geojson(pipeline/export_dongs.py). 지도 레이어·소스 id는 모두 area- 접두어.
// home.js의 choosePlace(place)가 openArea → showArea 순서로 부른다.
import { treeSVG, hashSeed, signatureColor } from "./characters.js";
import { distanceM } from "./geo.js";

const FIRST = 30, MORE = 50;            // 목록: 처음 30그루, '더 보기'마다 50그루
let areasPromise = null, lastView = null, active = null;

// ---------- 데이터(브라우저·node 공용) ----------
export function loadAreas(url = "data/dongs.geojson") {
  if (!areasPromise) areasPromise = fetch(url).then(r => { if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); })
    .catch(e => { areasPromise = null; throw e; });
  return areasPromise;
}

const squash = s => String(s || "").replace(/\s+/g, "");
// 장소 → 경계 폴리곤. 검색 결과의 dongName(경계 이름)을 먼저, 없으면 name으로 찾는다. 좌표는 쓰지 않는다.
// 같은 종류(dong/jibun)를 앞세우고, 법정동 경계가 없으면 이름이 같은 행정동 경계를 쓴다(예: 법정동 '서신동' → 행정동 서신동).
export function findArea(areas, place) {
  if (!areas || !place || !["dong", "jibun"].includes(place.kind)) return null;
  const feats = areas.features || [];
  for (const key of [place.dongName, place.name].map(squash).filter(Boolean)) {
    const same = feats.filter(f => squash(f.properties.name) === key);
    const hit = same.find(f => f.properties.kind === place.kind) || same.find(f => f.properties.kind === "dong") || same[0];
    if (hit) return hit;
  }
  return null;
}

const polysOf = g => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
export function bboxOf(geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polysOf(geometry)) for (const [x, y] of poly[0]) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
}
function inRing(x, y, ring) {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a], [xb, yb] = ring[b];
    if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
export function pointInArea(x, y, geometry) {
  return polysOf(geometry).some(([outer, ...holes]) => inRing(x, y, outer) && !holes.some(h => inRing(x, y, h)));
}
// 경계의 대표점: 가장 큰 고리의 면적 중심(안에 없으면 경계 상자 가운데)
export function centerOf(geometry) {
  let best = null, bestA = 0;
  for (const [ring] of polysOf(geometry)) {
    let a = 0, cx = 0, cy = 0;
    for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
      const f = ring[j][0] * ring[k][1] - ring[k][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[k][0]) * f; cy += (ring[j][1] + ring[k][1]) * f;
    }
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = { lon: cx / (3 * a), lat: cy / (3 * a) }; }
  }
  if (best && pointInArea(best.lon, best.lat, geometry)) return best;
  const [w, s, e, n] = bboxOf(geometry);
  return { lon: (w + e) / 2, lat: (s + n) / 2 };
}

// 경계 안 나무 번호. 행정동은 trees.json의 동 배정(원본 경계로 계산, 카드의 '동'과 같음)을 그대로 쓰고,
// 법정동이나 배정이 없는 이름은 단순화한 경계로 점-다각형 검사를 한다. byPolygon=true면 늘 점-다각형 검사.
export function areaTrees(T, feature, { byPolygon = false } = {}) {
  const { name, kind } = feature.properties;
  const k = kind === "dong" && T.dongs && T.dong ? T.dongs.indexOf(name) : -1;
  const out = [];
  if (k >= 0 && !byPolygon) {
    for (let i = 0; i < T.dong.length; i++) if (T.dong[i] === k) out.push(i);
    return out;
  }
  const [w, s, e, n] = bboxOf(feature.geometry);
  for (let i = 0; i < T.lon.length; i++) {
    const x = T.lon[i], y = T.lat[i];
    if (x === null || y === null || x < w || x > e || y < s || y > n) continue;
    if (pointInArea(x, y, feature.geometry)) out.push(i);
  }
  return out;
}

// 수종별 그루 수(많은 순) [[수종, n], …]
export function speciesCounts(T, idx) {
  const c = new Map();
  for (const i of idx) { const sp = T.species[T.sp[i]]; c.set(sp, (c.get(sp) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

// 장소에 맞는 동네 보기(경계·나무·중심·거리). 경계가 없으면 null
export async function openArea(place, T, areas = null) {
  const feature = findArea(areas || await loadAreas(), place);
  if (!feature) return null;
  const center = centerOf(feature.geometry);
  const idx = areaTrees(T, feature);
  const dist = new Map(idx.map(i => [i, distanceM(center.lon, center.lat, T.lon[i], T.lat[i])]));
  idx.sort((a, b) => dist.get(a) - dist.get(b));
  const { name, kind, gu } = feature.properties;
  lastView = { feature, name, kind, gu, center, idx, dist, counts: speciesCounts(T, idx), shown: FIRST, ctx: null, mm: null,
    render() { renderSheet(this); }, fit() { fitArea(this); } };
  return lastView;
}
// 지금 기준점이 방금 본 동네의 중심이면 그 동네 보기(반경 칩에서 '동 전체'로 돌아갈 때)
export const areaAt = center => (lastView && center && lastView.center === center ? lastView : null);

// ---------- 화면(브라우저) ----------
const nf = v => Number(v).toLocaleString("ko-KR");
const distText = d => (d >= 1000 ? `${(d / 1000).toFixed(1)}km` : `${Math.round(d)}m`);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false));
  return e;
}
const svg = markup => { const s = document.createElement("span"); s.innerHTML = markup; return s.firstElementChild; };
const CHEV_SVG = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>`;
const CSS = `
.sheet-d:has(.area-switch) { max-height: 50%; }
.area-switch { display: flex; gap: 6px; background: var(--bg); border-radius: 999px; padding: 4px; }
.area-switch button { flex: 1 1 0; border: 0; background: none; border-radius: 999px; height: 34px; font-size: 13.5px; font-weight: 600; color: var(--ink-2); cursor: pointer; }
.area-switch button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 4px rgba(21, 32, 26, 0.12); }
.area-bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--line); }
.area-bar i { display: block; height: 100%; }
.area-species { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 13px; color: var(--ink-2); }
.area-species span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.area-species i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; box-shadow: inset 0 0 0 1px rgba(21, 32, 26, 0.18); }
.area-species b { color: var(--ink); font-weight: 700; }
.area-more { align-self: stretch; height: 44px; border: 1.5px solid var(--line); background: var(--surface); color: var(--ink); border-radius: var(--r-sm, 14px); font-weight: 600; cursor: pointer; }
`;
function injectCSS() {
  if (document.getElementById("area-css")) return;
  document.head.append(el("style", { id: "area-css" }, CSS));
}

const colorOf = (sp, ctx) => signatureColor(sp, ctx.S.species_info[sp]);
function treePoints(view, T, ctx) {
  const colors = new Map(view.counts.map(([sp]) => [sp, colorOf(sp, ctx)]));
  return { type: "FeatureCollection", features: view.idx.map(i => ({ type: "Feature", geometry: { type: "Point", coordinates: [T.lon[i], T.lat[i]] },
    properties: { i, c: colors.get(T.species[T.sp[i]]) } })) };
}
function ensureLayers(mm, token) {
  const map = mm.map;
  if (map.getSource("area-boundary")) return;
  const accent = token("--accent") || "#2f7d4f";
  const before = map.getLayer("radius-fill") ? "radius-fill" : undefined;   // 선택한 나무·기준점보다 아래에
  const EMPTY = { type: "FeatureCollection", features: [] };
  map.addSource("area-boundary", { type: "geojson", data: EMPTY });
  map.addSource("area-trees", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "area-fill", type: "fill", source: "area-boundary", paint: { "fill-color": accent, "fill-opacity": 0.07 } }, before);
  map.addLayer({ id: "area-casing", type: "line", source: "area-boundary", paint: { "line-color": "#fff", "line-width": 5, "line-opacity": 0.8 } }, before);
  map.addLayer({ id: "area-line", type: "line", source: "area-boundary", paint: { "line-color": accent, "line-width": 2.5 } }, before);
  // 수천 그루라 DOM 마커 대신 circle 레이어. 멀리서는 작은 점, 가까이 가면 기존 나무 점과 같은 크기
  map.addLayer({ id: "area-trees", type: "circle", source: "area-trees", paint: {
    "circle-color": ["get", "c"],
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 1.4, 13, 2.2, 15, 3.6, 17, 5.5, 18, 6],
    "circle-stroke-color": "#fff",
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 0, 15, 0.8, 17, 2],
    "circle-opacity": 0.92 } }, before);
  map.on("click", "area-trees", e => { const f = e.features?.[0]; if (f && active?.ctx) active.ctx.onSelect(Number(f.properties.i)); });
  map.on("mouseenter", "area-trees", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "area-trees", () => { map.getCanvas().style.cursor = ""; });
}
function fitArea(view) {
  const mm = view.mm;
  if (!mm) return;
  const [w, s, e, n] = bboxOf(view.feature.geometry);
  // 아래 시트에 가리지 않게 시트 윗변까지만 쓴다
  const box = mm.map.getContainer().getBoundingClientRect(), sheet = document.getElementById("mapSheet")?.getBoundingClientRect();
  const h = box.height || 600, under = sheet ? box.bottom - sheet.top : h * 0.5;
  const bottom = Math.round(Math.min(Math.max(under + 12, 60), h - 260));
  mm.map.fitBounds([[w, s], [e, n]], { padding: { top: 120, bottom, left: 24, right: 24 }, maxZoom: 17, duration: 0 });
}
// 큰 지도에 경계 + 경계 안 모든 나무
export function paintArea(mm, view, T, ctx) {
  if (!mm?.map) return;
  ensureLayers(mm, ctx.token || (() => ""));
  view.mm = mm; view.ctx = ctx; active = view;
  mm.setTrees([]); mm.setCenter(null); mm.setSelected(null);
  mm.map.getSource("area-boundary").setData({ type: "FeatureCollection", features: [view.feature] });
  mm.map.getSource("area-trees").setData(treePoints(view, T, ctx));
  fitArea(view);
}
export function clearArea(mm) {
  active = null;
  const map = mm?.map;
  if (!map?.getSource("area-boundary")) return;
  const EMPTY = { type: "FeatureCollection", features: [] };
  map.getSource("area-boundary").setData(EMPTY);
  map.getSource("area-trees").setData(EMPTY);
}

function legend(view, ctx) {
  document.getElementById("legend")?.replaceChildren(...view.counts.slice(0, 3)
    .map(([sp, n]) => el("span", {}, el("i", { style: `background:${colorOf(sp, ctx)}` }), `${sp} ${nf(n)}`)));
}
function row(i, view, T, ctx) {
  const sp = T.species[T.sp[i]], info = ctx.S.species_info[sp], id = T.id[i], dbh = T.dbh[i];
  const my = ctx.myTree?.(id) || null;
  const tint = `color-mix(in srgb, ${signatureColor(sp, info)} 16%, var(--surface))`;
  return el("button", { type: "button", class: "row-tree", "data-i": i, "aria-pressed": "false", onclick: () => ctx.onSelect(i) },
    el("span", { class: "av", style: `background:${tint}` }, svg(treeSVG({ species: sp, info, dbh: dbh || 15, form: ctx.FORM, season: ctx.season, style: "character", seed: hashSeed(id), size: 66, label: sp }))),
    el("span", { class: "txt" }, el("b", {}, my ? `${my.name} · ${sp}` : sp), el("span", {}, `${T.roads[T.rd[i]]}${dbh ? ` · 지름 ${nf(dbh)}cm` : ""}${my ? " · 내 나무" : ""}`)),
    el("span", { class: "dist" }, distText(view.dist.get(i))), svg(CHEV_SVG));
}
function renderSheet(view, focus = null) {
  const { ctx } = view, T = ctx.T;
  const sheet = document.getElementById("mapSheet");
  if (!sheet) return;
  const total = view.idx.length;
  const kindText = view.kind === "jibun" ? "법정동" : "행정동";
  sheet.classList.toggle("empty", !total);
  const head = [el("span", { class: "handle" }),
    el("div", { class: "head" }, el("h2", {}, `${view.name} 가로수 ${nf(total)}그루`), el("span", { class: "sub" }, view.gu || kindText)),
    el("div", { class: "area-switch", role: "group", "aria-label": "보기 범위" },
      el("button", { type: "button", "aria-pressed": "true", onclick: () => fitArea(view) }, "동네 전체"),
      el("button", { type: "button", "aria-pressed": "false", onclick: () => ctx.onRadius() }, `반경 ${ctx.radius()}m`))];
  if (!total) {
    sheet.replaceChildren(...head, el("p", { class: "caption" }, `${kindText} 경계 안에 등록된 가로수가 없어요.`));
    return;
  }
  const top = view.counts.slice(0, 5), rest = view.counts.slice(5), restN = rest.reduce((a, [, n]) => a + n, 0);
  const pct = n => `${((n / total) * 100).toFixed(2)}%`;
  const list = el("div", { class: "tree-rows" }, ...view.idx.slice(0, view.shown).map(i => row(i, view, T, ctx)));
  const more = el("button", { type: "button", class: "area-more", onclick: () => {
    const from = view.shown;
    view.shown = Math.min(total, view.shown + MORE);
    list.append(...view.idx.slice(from, view.shown).map(i => row(i, view, T, ctx)));
    if (view.shown >= total) more.remove(); else more.textContent = moreText();
  } });
  const moreText = () => `더 보기 (${nf(Math.min(MORE, total - view.shown))}그루 · 남은 ${nf(total - view.shown)}그루)`;
  more.textContent = moreText();
  sheet.replaceChildren(...head,
    el("div", { class: "area-bar", role: "img", "aria-label": `수종 비율: ${view.counts.slice(0, 5).map(([sp, n]) => `${sp} ${nf(n)}그루`).join(", ")}` },
      ...top.map(([sp, n]) => el("i", { style: `width:${pct(n)};background:${colorOf(sp, ctx)}` }))),
    el("div", { class: "area-species" },
      ...top.map(([sp, n]) => el("span", {}, el("i", { style: `background:${colorOf(sp, ctx)}` }), sp, el("b", {}, nf(n)))),
      rest.length ? el("span", {}, `그 밖 ${rest.length}종`, el("b", {}, nf(restN))) : null),
    el("p", { class: "caption" }, `${kindText} 경계 안 · 동 가운데에서 가까운 순`),
    list,
    view.shown < total ? more : null,
    el("p", { class: "caption" }, "지도의 점을 눌러도 돼요"));
  const target = focus !== null ? sheet.querySelector(`.row-tree[data-i="${focus}"]`) : null;
  if (target) target.scrollIntoView({ block: "center" }); else sheet.scrollTop = 0;
}

/**
 * 동네 전체 보기를 연다: 경계·전체 나무 점(지도가 있으면) + 아래 시트(요약·목록) + 범례.
 * @param mm   createMiniMap 결과(아직 없으면 null: 지도가 준비되면 paintArea를 다시 부른다)
 * @param view openArea 결과
 * @param ctx  { T, S, FORM, season, token, myTree(id), onSelect(i), onRadius(), radius() }
 */
export function showArea(mm, view, T, ctx) {
  injectCSS();
  view.ctx = { ...ctx, T };
  view.shown = FIRST;
  active = view;
  legend(view, ctx);
  renderSheet(view);
  if (mm) paintArea(mm, view, T, view.ctx);
  view.render = function (focus = null) { renderSheet(this, focus); };
  return view;
}
