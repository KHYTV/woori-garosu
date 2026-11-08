// 작은 위치 지도(MapLibre + OpenFreeMap). 처음 쓸 때만 라이브러리를 불러온다.
// 동네 찾기(기준 위치 + 근처 나무)와 나무 프로필(한 그루 위치)에서 쓴다.
const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";
const STYLES = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const EMPTY = { type: "FeatureCollection", features: [] };
let loading = null;

export function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet"; link.href = MAPLIBRE_CSS;
        document.head.append(link);
      }
      const s = document.createElement("script");
      s.src = MAPLIBRE_JS;
      s.onload = () => resolve(window.maplibregl);
      s.onerror = () => { loading = null; reject(new Error("지도 라이브러리를 불러오지 못했습니다.")); };
      document.head.append(s);
    });
  }
  return loading;
}

// 배경지도를 못 불러와도 나무 점은 보이게 한다
async function pickStyle(bg) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  // 네트워크가 잠깐 끊긴 직후(페이지 새로고침 직후 등)를 대비해 한 번 더 시도한다
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of dark ? [STYLES.dark, STYLES.light] : [STYLES.light]) {
      try { if ((await fetch(url)).ok) return url; } catch { /* 다음 후보 */ }
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": bg } }] };
}
const point = (lon, lat, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });

// ---- 나무 점 모양: 활엽수는 원, 침엽수(properties.cone)는 같은 색 세모 ----
const PR = 2;                       // 아이콘 그림 해상도(화면 1px당 2px)
const CONE = "wg-cone:";            // 'wg-cone:#RRGGBB' 이름을 처음 쓸 때 그린다(흰 테두리)
const CONE_FLAT = "wg-cone0:";      // 멀리서 볼 때(작은 세모)는 테두리 없이
function canvasImage(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  draw(g);
  return { width: w, height: h, data: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer) };
}
function coneImage(color, stroke = true) {
  const S = 18 * PR, sw = 2 * PR, pad = sw + 0.5 * PR;
  return canvasImage(S, S, g => {
    g.beginPath(); g.moveTo(S / 2, pad); g.lineTo(S - pad, S - pad); g.lineTo(pad, S - pad); g.closePath();
    g.lineJoin = "round"; g.lineWidth = sw * 2; g.strokeStyle = stroke ? "#fff" : color; g.stroke();
    g.fillStyle = color; g.fill();
  });
}
// 선택한 나무 이름표 바탕: 어두운 알약 + 흰 테두리(밝은·어두운 배경지도 모두에서 읽힌다)
function pillImage() {
  const W = 24 * PR, H = 20 * PR, r = 8 * PR, b = 1.5 * PR;
  const rr = (g, x, y, w, h, rad) => { g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad); g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath(); };
  return canvasImage(W, H, g => {
    rr(g, 0, 0, W, H, r); g.fillStyle = "rgba(255,255,255,0.95)"; g.fill();
    rr(g, b, b, W - 2 * b, H - 2 * b, r - b); g.fillStyle = "#15201A"; g.fill();
  });
}
export const PILL = "wg-pill";
/** 지도에 나무 아이콘(세모·이름표 바탕)을 쓸 준비. 여러 번 불러도 된다. */
export function ensureTreeIcons(map) {
  if (map.__wgIcons) return;
  map.__wgIcons = true;
  map.on("styleimagemissing", e => {
    if (map.hasImage(e.id)) return;
    if (e.id.startsWith(CONE)) map.addImage(e.id, coneImage(e.id.slice(CONE.length)), { pixelRatio: PR });
    else if (e.id.startsWith(CONE_FLAT)) map.addImage(e.id, coneImage(e.id.slice(CONE_FLAT.length), false), { pixelRatio: PR });
  });
  if (!map.hasImage(PILL)) map.addImage(PILL, pillImage(), { pixelRatio: PR, stretchX: [[8 * PR, 16 * PR]], stretchY: [[8 * PR, 12 * PR]], content: [6 * PR, 3 * PR, 18 * PR, 17 * PR] });
}
// 아주 밝은 색(이팝·목련 흰색)은 흰 테두리 대신 회색 테두리로 밝은 지도에서도 보이게
const strokeFor = color => ["case", [">", ["+", ["at", 0, ["to-rgba", ["to-color", color]]], ["at", 1, ["to-rgba", ["to-color", color]]]], 440], "#7d8a81", "#ffffff"];
/**
 * 나무 점 레이어 두 개(원 id, 세모 id-cone)를 더한다.
 * @param o.color      색 식(문자열이 나오는 식, 예: ["get", "c"])
 * @param o.radius     원 반지름(식 가능) · o.iconSize 세모 크기 배율(1 = 지름 18px, 식 가능)
 * @returns 두 레이어 id
 */
export function addTreeLayers(map, { id, source, color, radius, iconSize, strokeWidth = 2, opacity = 1 }, before) {
  ensureTreeIcons(map);
  map.addLayer({ id, type: "circle", source, filter: ["!", ["to-boolean", ["get", "cone"]]],
    paint: { "circle-radius": radius, "circle-color": color, "circle-opacity": opacity, "circle-stroke-color": strokeFor(color), "circle-stroke-width": strokeWidth } }, before);
  map.addLayer({ id: `${id}-cone`, type: "symbol", source, filter: ["to-boolean", ["get", "cone"]],
    layout: { "icon-image": ["step", ["zoom"], ["concat", CONE_FLAT, color], 15.5, ["concat", CONE, color]], "icon-size": iconSize, "icon-allow-overlap": true, "icon-ignore-placement": true },
    paint: { "icon-opacity": opacity } }, before);
  return [id, `${id}-cone`];
}

/**
 * @param container  지도를 넣을 요소
 * @param o.center   [lon, lat]
 * @param o.onSelect 나무 점을 눌렀을 때 (properties.i)
 * @param o.token    CSS 변수 읽기 함수
 */
export async function createMiniMap(container, { center, zoom = 17, interactive = true, onSelect = null, token, zoomControl = true }) {
  const maplibregl = await loadMapLibre();
  const style = await pickStyle(token("--bg"));
  const map = new maplibregl.Map({ container, style, center, zoom, interactive, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    attributionControl: { compact: true } });
  if (interactive && zoomControl) map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");
  await new Promise(resolve => map.once("load", resolve));
  const accent = token("--accent"), surface = token("--surface");
  map.addSource("trees", { type: "geojson", data: EMPTY });
  map.addSource("selected", { type: "geojson", data: EMPTY });
  map.addSource("center", { type: "geojson", data: EMPTY });
  map.addSource("radius", { type: "geojson", data: EMPTY });
  // 검색 반경: 옅은 면 + 점선 테두리
  map.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": accent, "fill-opacity": 0.07 } });
  map.addLayer({ id: "radius-line", type: "line", source: "radius", paint: { "line-color": accent, "line-width": 1.5, "line-dasharray": [3, 3], "line-opacity": 0.6 } });
  map.addLayer({ id: "center-ring", type: "circle", source: "center", paint: { "circle-radius": 16, "circle-color": "#1B64DA", "circle-opacity": 0.2 } });
  map.addLayer({ id: "center-dot", type: "circle", source: "center", paint: { "circle-radius": 7, "circle-color": "#1B64DA", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
  // 나무 점은 수종 상징색(properties.color), 없으면 강조색. 침엽수(properties.cone)는 세모
  const treeLayers = addTreeLayers(map, { id: "trees", source: "trees", color: ["coalesce", ["get", "color"], accent], radius: 6, iconSize: 1 });
  map.addLayer({ id: "tree-labels", type: "symbol", source: "trees", minzoom: 17.5,
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-allow-overlap": false },
    paint: { "text-color": token("--ink"), "text-halo-color": surface, "text-halo-width": 2, "text-halo-blur": 0.5 } });
  map.addLayer({ id: "selected-ring", type: "circle", source: "selected", paint: { "circle-radius": 15, "circle-color": "#fff", "circle-stroke-color": ["coalesce", ["get", "color"], "#2a78d6"], "circle-stroke-width": 3 } });
  map.addLayer({ id: "selected", type: "circle", source: "selected", paint: { "circle-radius": 7, "circle-color": ["coalesce", ["get", "color"], "#2a78d6"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  // 선택한 나무 이름표('여기서 n m'·이름): 어두운 알약 바탕 + 흰 글씨라 배경지도·다크 모드와 상관없이 읽힌다
  map.addLayer({ id: "selected-label", type: "symbol", source: "selected",
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-offset": [0, -1.75], "text-anchor": "bottom",
      "text-allow-overlap": true, "text-ignore-placement": true, "icon-image": PILL, "icon-text-fit": "both", "icon-text-fit-padding": [2, 4, 1, 4],
      "icon-allow-overlap": true, "icon-ignore-placement": true },
    paint: { "text-color": "#ffffff" } });
  if (onSelect) {
    for (const id of treeLayers) {
      map.on("click", id, e => { const f = e.features?.[0]; if (f) onSelect(f.properties.i); });
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
  }
  requestAnimationFrame(() => map.resize());
  return {
    map,
    setTrees(list) { map.getSource("trees").setData({ type: "FeatureCollection", features: list.map(t => point(t.lon, t.lat, { i: t.i, label: t.label || "", color: t.color || null, cone: !!t.cone })) }); },
    setSelected(t, fly = false) {
      map.getSource("selected").setData(t ? { type: "FeatureCollection", features: [point(t.lon, t.lat, { label: t.label || "", color: t.color || null })] } : EMPTY);
      // 아래 시트에 가리지 않게 위로 비켜 보인다. padding 대신 offset을 써서 뒤의 fit(검색 반경·동네 경계)에 여백이 남지 않게 한다
      if (t && fly) map.easeTo({ center: [t.lon, t.lat], zoom: Math.max(map.getZoom(), 18), duration: 500, padding: { top: 0, right: 0, bottom: 0, left: 0 },
        offset: fly === "sheet" ? [0, -Math.round(map.getContainer().clientHeight * 0.225)] : [0, 0] });
    },
    setCenter(c, radiusM = null) {
      map.getSource("center").setData(c ? { type: "FeatureCollection", features: [point(c.lon, c.lat)] } : EMPTY);
      if (!c || !radiusM) { map.getSource("radius").setData(EMPTY); return; }
      const n = 64, ring = [];
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        ring.push([c.lon + (radiusM * Math.cos(a)) / (111320 * Math.cos(c.lat * Math.PI / 180)), c.lat + (radiusM * Math.sin(a)) / 111320]);
      }
      map.getSource("radius").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} }] });
    },
    easeTo(opts) { map.easeTo(opts); },
    fit(points, padding = 40) {
      if (!points.length) return;
      const lons = points.map(p => p.lon), lats = points.map(p => p.lat);
      map.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });   // 앞선 easeTo의 padding이 남아 있으면 fit이 안 된다
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding, maxZoom: 18, duration: 0 });
    },
    resize() { map.resize(); },
    remove() { map.remove(); },
  };
}
