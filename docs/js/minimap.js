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
  // 나무 점은 수종 상징색(properties.color), 없으면 강조색
  map.addLayer({ id: "trees", type: "circle", source: "trees", paint: { "circle-radius": 6, "circle-color": ["coalesce", ["get", "color"], accent], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "tree-labels", type: "symbol", source: "trees", minzoom: 17.5,
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-allow-overlap": false },
    paint: { "text-color": token("--ink"), "text-halo-color": surface, "text-halo-width": 1.2 } });
  map.addLayer({ id: "selected-ring", type: "circle", source: "selected", paint: { "circle-radius": 15, "circle-color": "#fff", "circle-stroke-color": ["coalesce", ["get", "color"], "#2a78d6"], "circle-stroke-width": 3 } });
  map.addLayer({ id: "selected", type: "circle", source: "selected", paint: { "circle-radius": 7, "circle-color": ["coalesce", ["get", "color"], "#2a78d6"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "selected-label", type: "symbol", source: "selected",
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, -1.9], "text-anchor": "bottom", "text-allow-overlap": true },
    paint: { "text-color": "#fff", "text-halo-color": token("--ink"), "text-halo-width": 2 } });
  if (onSelect) {
    map.on("click", "trees", e => { const f = e.features?.[0]; if (f) onSelect(f.properties.i); });
    map.on("mouseenter", "trees", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "trees", () => { map.getCanvas().style.cursor = ""; });
  }
  requestAnimationFrame(() => map.resize());
  return {
    map,
    setTrees(list) { map.getSource("trees").setData({ type: "FeatureCollection", features: list.map(t => point(t.lon, t.lat, { i: t.i, label: t.label || "", color: t.color || null })) }); },
    setSelected(t, fly = false) {
      map.getSource("selected").setData(t ? { type: "FeatureCollection", features: [point(t.lon, t.lat, { label: t.label || "", color: t.color || null })] } : EMPTY);
      if (t && fly) map.easeTo({ center: [t.lon, t.lat], zoom: Math.max(map.getZoom(), 18), duration: 500, padding: fly === "sheet" ? { bottom: Math.round(map.getContainer().clientHeight * 0.45) } : 0 });
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
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding, maxZoom: 18, duration: 0 });
    },
    resize() { map.resize(); },
    remove() { map.remove(); },
  };
}
