// 지도 위 친구 나무: 내 나무 표시(하트 + 지은 이름), 화면 안 가로수 불러오기, '내 나무' 목록으로 다시 찾기.
// 내 나무는 state.my 항목의 lon/lat으로 그린다. trees.json에 없는 나무(시민 등록 'u-' 등)도 좌표만 있으면 보인다.
// 지도 레이어·소스 id는 'friends-' 접두어. DOM은 initFriends 뒤에만 건드린다(node 검사에서 순수 함수만 불러 쓸 수 있게).
import { treeSVG, signatureColor, hashSeed } from "./characters.js";
import { distanceM } from "./geo.js";

export const AREA_MIN_ZOOM = 16;   // 이 확대부터 화면 안 가로수를 점으로 불러온다
export const AREA_LIMIT = 1500;    // 한 화면에 그리는 최대 그루(화면 가운데에서 가까운 순)
export const NAME_MIN_ZOOM = 11;   // 이 확대부터 친구 이름표를 보인다

const ok = v => typeof v === "number" && Number.isFinite(v);

/** 경계 상자 [[w, s], [e, n]] 안의 나무 인덱스(가운데에서 가까운 순, limit까지). */
export function treesInBounds(T, [[w, s], [e, n]], { limit = AREA_LIMIT } = {}) {
  const cx = (w + e) / 2, cy = (s + n) / 2, k = Math.cos(cy * Math.PI / 180);
  const out = [];
  for (let i = 0; i < T.id.length; i++) {
    const x = T.lon[i], y = T.lat[i];
    if (x === null || y === null || x < w || x > e || y < s || y > n) continue;
    out.push({ i, d: ((x - cx) * k) ** 2 + (y - cy) ** 2 });
  }
  if (out.length > limit) { out.sort((a, b) => a.d - b.d); out.length = limit; }
  return out.map(o => o.i);
}

/** 좌표가 있는 내 나무만. */
export const friendPoints = my => (my || []).filter(t => t && ok(t.lon) && ok(t.lat));

/** 기준점(ref: {lon, lat})에서의 거리를 붙여 가까운 순으로. ref가 없으면 친구 맺은 순서 그대로. */
export function friendRows(my, ref) {
  const rows = friendPoints(my).map(t => ({ t, d: ref ? distanceM(ref.lon, ref.lat, t.lon, t.lat) : null }));
  return ref ? rows.sort((a, b) => a.d - b.d) : rows;
}

export const distText = d => (d === null ? "" : d < 1000 ? `${Math.round(d)}m` : `${(d / 1000).toFixed(d < 10000 ? 1 : 0)}km`);

// ---------- 화면 ----------
const HEART = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5S3.5 15.2 3.5 9.3A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 8.5 2.1c0 5.9-8.5 11.2-8.5 11.2z"/></svg>`;
let ctx = null;          // { state, T, S, FORM, season, selectTree, runNear, backToList, toast }
let mm = null, markers = [], bar = null, areaCount = 0, readyResolve, ready = new Promise(r => { readyResolve = r; });

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
const idx = id => (ctx.T?.id ? ctx.T.id.indexOf(id) : -1);
const colorOf = t => signatureColor(t.species, t.info || ctx.S?.species_info?.[t.species]);

/** 지도 화면을 처음 만들 때 한 번. home.js가 쓰는 함수·상태를 넘겨받고 위쪽 막대(내 나무 칩·지역 안내)를 붙인다. */
export function initFriends(c) {
  ctx = c;
  if (!document.querySelector('link[data-friends-css]')) {
    document.head.append(el("link", { rel: "stylesheet", href: new URL("../friends.css", import.meta.url).href, "data-friends-css": "" }));
  }
  bar = el("div", { class: "friends-bar", id: "friendsBar" });
  // 다른 곳을 누르거나 검색하면 숨겨 둔 친구 이름표를 다시 보인다(친구를 고르는 클릭은 이 뒤에 다시 숨김)
  const unmark = () => { for (const m of markers) m.getElement().classList.remove("is-selected"); };
  const screen = document.querySelector("#s-map");
  screen?.addEventListener("click", unmark, true);
  screen?.addEventListener("submit", unmark, true);
  document.querySelector("#s-map .map-top")?.append(bar);
  renderBar();
}

/** 큰 지도가 준비되면 한 번. 화면 안 가로수 레이어와 친구 표시를 붙인다. */
export function attachFriendsMap(minimap) {
  mm = minimap;
  const map = mm.map;
  map.addSource("friends-area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // 검색 결과 점('trees')보다 아래에, 조금 작게
  map.addLayer({ id: "friends-area", type: "circle", source: "friends-area",
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 16, 4, 19, 7], "circle-color": ["get", "color"], "circle-opacity": 0.85,
      "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }, map.getLayer("trees") ? "trees" : undefined);
  map.on("click", "friends-area", e => {
    // 검색 결과 점과 겹치면 그쪽 처리에 맡긴다
    if (map.getLayer("trees") && map.queryRenderedFeatures(e.point, { layers: ["trees"] }).length) return;
    const f = e.features?.[0];
    if (f) ctx.selectTree(Number(f.properties.i));
  });
  map.on("mouseenter", "friends-area", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "friends-area", () => { map.getCanvas().style.cursor = ""; });
  map.on("moveend", refreshArea);
  map.on("zoom", () => map.getContainer().classList.toggle("friends-names", map.getZoom() >= NAME_MIN_ZOOM));
  map.getContainer().classList.toggle("friends-names", map.getZoom() >= NAME_MIN_ZOOM);
  syncFriends();
  refreshArea();
  readyResolve(mm);
}

/** 화면 안 가로수(확대 AREA_MIN_ZOOM 이상). */
function refreshArea() {
  if (!mm || !ctx.T) return;
  const map = mm.map, z = map.getZoom();
  let n = 0;
  if (z >= AREA_MIN_ZOOM - 0.01) {
    const b = map.getBounds();
    const list = treesInBounds(ctx.T, [[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]]);
    n = list.length;
    map.getSource("friends-area")?.setData({ type: "FeatureCollection", features: list.map(i => {
      const sp = ctx.T.species[ctx.T.sp[i]];
      return { type: "Feature", geometry: { type: "Point", coordinates: [ctx.T.lon[i], ctx.T.lat[i]] }, properties: { i, color: signatureColor(sp, ctx.S.species_info[sp]) } };
    }) });
  } else {
    map.getSource("friends-area")?.setData({ type: "FeatureCollection", features: [] });
  }
  areaCount = n;
  renderBar(z, n);
}

function renderBar(z = mm?.map.getZoom() ?? 0, n = 0) {
  if (!bar) return;
  const count = friendPoints(ctx.state.my).length;
  const chip = el("button", { type: "button", class: "friends-chip", id: "friendsChip", "aria-label": `내 나무 ${count}그루 목록`, onclick: openList },
    svg(HEART), `내 나무 ${count}`);
  let area = null;
  if (mm && z < AREA_MIN_ZOOM - 0.01) {
    area = el("button", { type: "button", class: "friends-area-btn", id: "friendsAreaBtn",
      onclick: () => mm.map.easeTo({ zoom: AREA_MIN_ZOOM, duration: 400 }) }, "이 지역 가로수 보기");
  } else if (mm && n) {
    area = el("span", { class: "friends-area-note", id: "friendsAreaNote" }, `화면 안 ${n.toLocaleString("ko-KR")}그루${n >= AREA_LIMIT ? "+" : ""} · 점을 눌러 친구 맺기`);
  }
  bar.replaceChildren(chip, area);
}

/** 내 나무 표시를 state.my에 맞춘다(지도 화면에 들어올 때마다). */
export function syncFriends() {
  renderBar(mm?.map.getZoom(), areaCount);
  if (!mm || !window.maplibregl) return;
  for (const m of markers) m.remove();
  markers = friendPoints(ctx.state.my).map(t => {
    const node = el("button", { type: "button", class: "friends-pin", "data-id": t.id, style: `--c:${colorOf(t)}`, "aria-label": `내 나무 ${t.name}`,
      onclick: e => { e.stopPropagation(); focusFriend(t.id); } },
      el("span", { class: "friends-heart" }, svg(HEART)), el("span", { class: "friends-name" }, t.name || t.species || "내 나무"));
    return new window.maplibregl.Marker({ element: node, anchor: "center" }).setLngLat([t.lon, t.lat]).addTo(mm.map);
  });
}

/** 친구 나무로 가서 그 나무를 가운데 두고 카드를 연다. 못 찾으면 false. */
export function focusFriend(id) {
  const t = ctx.state.my.find(x => x.id === id);
  const i = idx(id);
  const lon = t?.lon ?? (i >= 0 ? ctx.T.lon[i] : null), lat = t?.lat ?? (i >= 0 ? ctx.T.lat[i] : null);
  if (!ok(lon) || !ok(lat)) return false;
  const near = ctx.state.near;
  near.center = { lon, lat };
  near.label = `${t?.name || (i >= 0 ? ctx.T.species[ctx.T.sp[i]] : "나무")} 주변`;
  const open = () => {
    ctx.runNear();
    if (i >= 0) ctx.selectTree(i);
    else if (t) showLooseCard(t);
    // 고른 친구는 지도 위 강조 글자에 이름이 나오므로 옆 이름표를 숨긴다
    for (const m of markers) m.getElement().classList.toggle("is-selected", m.getElement().dataset.id === id);
  };
  if (mm) open();
  else { ctx.runNear(); ready.then(open); }
  return true;
}

// trees.json에 없는 내 나무(시민 등록 등): 지도 강조와 간단한 카드만
function showLooseCard(t) {
  mm?.setSelected({ lon: t.lon, lat: t.lat, label: t.name || "", color: colorOf(t) }, "sheet");
  const sheet = document.querySelector("#mapSheet");
  if (!sheet) return;
  sheet.classList.remove("empty");
  sheet.replaceChildren(el("span", { class: "handle" }),
    el("div", { class: "head" }, el("h2", {}, t.name || "내 나무"), el("span", { class: "sub" }, t.species || "")),
    el("p", { class: "caption" }, "직접 등록한 나무예요."),
    el("div", { class: "action-row" }, el("a", { class: "btn big", href: `#tree/${encodeURIComponent(t.id)}` }, "내 나무 보기"),
      el("button", { type: "button", class: "btn big ghost", onclick: () => ctx.backToList() }, "목록으로")));
}

/** '내 나무' 칩: 친구 나무 목록(내 위치 또는 지도 가운데에서의 거리)을 아래 시트에 보여 준다. */
function openList() {
  const sheet = document.querySelector("#mapSheet");
  if (!sheet) return;
  const near = ctx.state.near;
  const gps = near.center && /^내 위치/.test(near.label || "") ? near.center : null;
  const c = mm?.map.getCenter();
  const ref = gps || (c ? { lon: c.lng, lat: c.lat } : null);
  const rows = friendRows(ctx.state.my, ref);
  const close = el("button", { type: "button", class: "btn ghost small", onclick: () => (near.center ? ctx.backToList() : sheet.replaceChildren(el("span", { class: "handle" }),
    el("div", { class: "head" }, el("h2", {}, "어디의 가로수를 볼까요?")), el("p", { class: "caption" }, "검색창에 동·도로·주소를 넣거나 ⌖ 를 눌러 내 위치 주변을 보세요."))) }, "닫기");
  sheet.classList.toggle("empty", !rows.length);
  if (!rows.length) {
    sheet.replaceChildren(el("span", { class: "handle" }), el("div", { class: "head" }, el("h2", {}, "아직 친구 나무가 없어요"), close),
      el("p", { class: "caption" }, "지도를 확대해 가로수 점을 누르면 어디서든 친구를 맺을 수 있어요."));
    return;
  }
  const fitAll = rows.length > 1 && mm ? el("button", { type: "button", class: "btn ghost small", onclick: () => {
    // 카드를 열 때 easeTo가 남긴 아래 여백이 겹치면 fitBounds가 맞추지 못해 먼저 비운다
    mm.map.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });
    mm.fit(rows.map(r => r.t), { top: 150, bottom: Math.round((mm.map.getContainer().clientHeight || 600) * 0.5), left: 40, right: 120 });
  } }, "모두 보기") : null;
  sheet.replaceChildren(el("span", { class: "handle" }),
    el("div", { class: "head" }, el("h2", {}, `내 나무 ${rows.length}그루`), el("span", { class: "friends-head-btns" }, fitAll, close)),
    el("p", { class: "caption" }, ref ? `${gps ? "내 위치" : "지도 가운데"}에서 가까운 순 · 누르면 그 나무로 가요` : "누르면 그 나무로 가요"),
    el("div", { class: "tree-rows", id: "friendsList" }, ...rows.map(({ t, d }) => el("button", { type: "button", class: "row-tree", "data-friend": t.id, onclick: () => focusFriend(t.id) },
      el("span", { class: "av", style: `background:color-mix(in srgb, ${colorOf(t)} 16%, var(--surface))` },
        t.species ? svg(treeSVG({ species: t.species, info: t.info || ctx.S.species_info[t.species], dbh: t.dbh || 15, form: ctx.FORM, season: ctx.season, style: "character", seed: hashSeed(t.id), size: 66, label: t.name })) : null),
      el("span", { class: "txt" }, el("b", {}, el("span", { class: "friends-mini-heart" }, svg(HEART)), `${t.name} · ${t.species || "나무"}`),
        el("span", {}, [t.road, t.dong].filter(Boolean).join(" · ") || "")),
      el("span", { class: "dist" }, distText(d))))));
  sheet.scrollTop = 0;
}
