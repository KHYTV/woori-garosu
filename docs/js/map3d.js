// 3D 지도: 배경지도 건물을 세우고, 화면 안 가로수를 수종별 모양의 입체로 그린다.
// deck.gl은 3D를 처음 켤 때만 불러온다. 나무 높이·수관폭은 흉고로 추정한 값(data/tree_form.json)이다.

import { estimateForm } from "./treeform.js";

const DECK_URL = "https://unpkg.com/deck.gl@9.4.0/dist.min.js";
const MIN_ZOOM_3D = 15;
const MAX_TREES = 6000;

// 단위 메시: 수관은 바닥 z=0, 꼭대기 z=1, 폭 1(반지름 0.5). 줄기는 같은 크기의 원기둥
function meshFrom(positions, normals) {
  return {
    header: { vertexCount: positions.length / 3 }, mode: 4,
    attributes: { POSITION: { value: new Float32Array(positions), size: 3 }, NORMAL: { value: new Float32Array(normals), size: 3 } },
  };
}
function ellipsoidMesh(seg = 16, rings = 10) {
  const P = [], N = [];
  const pt = (t, f) => [Math.sin(t) * Math.cos(f), Math.sin(t) * Math.sin(f), Math.cos(t)];
  for (let r = 0; r < rings; r++) {
    const t0 = Math.PI * r / rings, t1 = Math.PI * (r + 1) / rings;
    for (let s = 0; s < seg; s++) {
      const f0 = 2 * Math.PI * s / seg, f1 = 2 * Math.PI * (s + 1) / seg;
      for (const [t, f] of [[t0, f0], [t1, f0], [t1, f1], [t0, f0], [t1, f1], [t0, f1]]) {
        const n = pt(t, f);
        P.push(0.5 * n[0], 0.5 * n[1], 0.5 + 0.5 * n[2]);
        N.push(...n);
      }
    }
  }
  return meshFrom(P, N);
}
function coneMesh(seg = 16) {
  const P = [], N = [];
  const slope = 0.5; // 반지름/높이
  const norm = Math.hypot(1, slope);
  for (let s = 0; s < seg; s++) {
    const f0 = 2 * Math.PI * s / seg, f1 = 2 * Math.PI * (s + 1) / seg, fm = (f0 + f1) / 2;
    const n = f => [Math.cos(f) / norm, Math.sin(f) / norm, slope / norm];
    P.push(0.5 * Math.cos(f0), 0.5 * Math.sin(f0), 0, 0.5 * Math.cos(f1), 0.5 * Math.sin(f1), 0, 0, 0, 1);
    N.push(...n(f0), ...n(f1), ...n(fm));
    P.push(0, 0, 0, 0.5 * Math.cos(f1), 0.5 * Math.sin(f1), 0, 0.5 * Math.cos(f0), 0.5 * Math.sin(f0), 0);
    N.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
  }
  return meshFrom(P, N);
}
function cylinderMesh(seg = 10) {
  const P = [], N = [];
  for (let s = 0; s < seg; s++) {
    const f0 = 2 * Math.PI * s / seg, f1 = 2 * Math.PI * (s + 1) / seg;
    const a = [0.5 * Math.cos(f0), 0.5 * Math.sin(f0)], b = [0.5 * Math.cos(f1), 0.5 * Math.sin(f1)];
    const na = [Math.cos(f0), Math.sin(f0), 0], nb = [Math.cos(f1), Math.sin(f1), 0];
    P.push(a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], 1, a[0], a[1], 0, b[0], b[1], 1, a[0], a[1], 1);
    N.push(...na, ...nb, ...nb, ...na, ...nb, ...na);
  }
  return meshFrom(P, N);
}

const hexToRgb = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

let deckLoading = null;
function loadDeck() {
  if (window.deck) return Promise.resolve(window.deck);
  deckLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = DECK_URL;
    s.onload = () => (window.deck ? resolve(window.deck) : reject(new Error("deck.gl 없음")));
    s.onerror = () => reject(new Error("deck.gl을 불러오지 못했습니다"));
    document.head.append(s);
  });
  return deckLoading;
}

export function defaultColorMode(month = new Date().getMonth() + 1) {
  if (month >= 10 && month <= 11) return "autumn";
  if (month === 12 || month <= 3) return "winter";
  return "leaf";
}

export function createMap3D({ map, T, speciesInfo, form, token, cuts, onSelect, onStatus }) {
  let overlay = null, on = false, colorMode = defaultColorMode(), selected = -1, visible = [];
  const meshes = { round: ellipsoidMesh(), umbrella: ellipsoidMesh(), cone: coneMesh(), trunk: cylinderMesh() };

  // 나무별 추정 모양(한 번만 계산)
  const shapeOf = T.species.map(s => (speciesInfo[s] && speciesInfo[s].crown_shape) || "round");
  const geom = new Array(T.id.length);
  for (let i = 0; i < T.id.length; i++) {
    const dbh = T.dbh[i];
    if (dbh === null) continue;
    const { h, cw, base } = estimateForm(dbh, speciesInfo[T.species[T.sp[i]]], form);
    const trunk = Math.max(dbh / 100, form.trunk.min_diameter_m) * form.trunk.display_factor;
    geom[i] = { h, cw, base, trunk };
  }

  function treeColor(i) {
    if (i === selected) return [...hexToRgb(form.colors.selected), 255];
    const info = speciesInfo[T.species[T.sp[i]]] || {};
    if (colorMode === "carbon") {
      const v = T.seq[1][i];
      const k = v === null ? 0 : cuts.filter(c => v >= c).length + 1;
      return [...hexToRgb(token(`--seq-${k || 1}`)), 235];
    }
    if (info.leaf_habit === "evergreen") return [...hexToRgb(form.colors.evergreen), 240];
    if (colorMode === "autumn") return [...hexToRgb(info.autumn_color || form.colors.leaf), 240];
    if (colorMode === "winter") return [...hexToRgb(form.colors.winter), 90];
    return [...hexToRgb(form.colors.leaf), 240];
  }

  function visibleTrees() {
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.15, padY = (b.getNorth() - b.getSouth()) * 0.15;
    const w = b.getWest() - padX, e = b.getEast() + padX, s = b.getSouth() - padY, n = b.getNorth() + padY;
    const c = map.getCenter();
    const out = [];
    for (let i = 0; i < T.id.length; i++) {
      if (!geom[i]) continue;
      const lon = T.lon[i], lat = T.lat[i];
      if (lon >= w && lon <= e && lat >= s && lat <= n) out.push(i);
    }
    if (out.length > MAX_TREES) {
      // 너무 많으면 화면 중심에서 가까운 나무부터 그린다
      out.sort((a, b2) => (T.lon[a] - c.lng) ** 2 + (T.lat[a] - c.lat) ** 2 - ((T.lon[b2] - c.lng) ** 2 + (T.lat[b2] - c.lat) ** 2));
      out.length = MAX_TREES;
    }
    return out;
  }

  function layers() {
    const D = window.deck;
    if (!on || map.getZoom() < MIN_ZOOM_3D) return [];
    const pos = i => [T.lon[i], T.lat[i], 0];
    const common = {
      getPosition: pos, sizeScale: 1, pickable: true,
      material: { ambient: 0.45, diffuse: 0.6, shininess: 8, specularColor: [40, 40, 40] },
      updateTriggers: { getColor: [colorMode, selected] },
    };
    const byShape = { round: [], umbrella: [], cone: [] };
    for (const i of visible) byShape[shapeOf[T.sp[i]]].push(i);
    const out = [new D.SimpleMeshLayer({
      ...common, id: "tree-trunks", data: visible, mesh: meshes.trunk,
      getScale: i => [geom[i].trunk, geom[i].trunk, geom[i].base + 0.5],
      getColor: () => [...hexToRgb(form.colors.trunk), 255],
      updateTriggers: {},
    })];
    for (const shape of ["round", "umbrella", "cone"]) {
      if (!byShape[shape].length) continue;
      out.push(new D.SimpleMeshLayer({
        ...common, id: `tree-crowns-${shape}`, data: byShape[shape], mesh: meshes[shape],
        getTranslation: i => [0, 0, geom[i].base],
        getScale: i => [geom[i].cw, geom[i].cw, geom[i].h - geom[i].base],
        getColor: treeColor,
      }));
    }
    return out;
  }

  function refresh() {
    if (!overlay) return;
    visible = on && map.getZoom() >= MIN_ZOOM_3D ? visibleTrees() : [];
    overlay.setProps({ layers: layers() });
    const showPoints = !on || map.getZoom() < MIN_ZOOM_3D;
    if (map.getLayer("trees")) map.setLayoutProperty("trees", "visibility", showPoints ? "visible" : "none");
    onStatus(on && map.getZoom() < MIN_ZOOM_3D ? "확대하면 나무가 입체로 보입니다." : "");
  }

  function addBuildings() {
    if (map.getLayer("buildings-3d") || !map.getSource("openmaptiles")) return;
    map.addLayer({
      id: "buildings-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 14,
      paint: {
        "fill-extrusion-color": token("--line"),
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    }, map.getLayer("boundary") ? "boundary" : undefined);
  }

  map.on("moveend", () => { if (on) refresh(); });
  map.on("zoomend", () => { if (on) refresh(); });
  map.on("resize", () => { if (on) refresh(); });

  // 클릭(탭)과 커서는 지도 이벤트에서 직접 집어낸다. 휴대폰 탭도 같은 경로를 탄다
  const pick = point => {
    if (!overlay || !on || !visible.length) return null;
    const hit = overlay.pickObject({ x: point.x, y: point.y, radius: 6 });
    return hit && Number.isInteger(hit.object) ? hit.object : null;
  };
  map.on("click", e => {
    const i = pick(e.point);
    if (i !== null) onSelect(i);
  });
  map.on("mousemove", e => {
    if (!on) return;
    map.getCanvas().style.cursor = pick(e.point) !== null ? "pointer" : "";
  });

  return {
    isOn: () => on,
    colorMode: () => colorMode,
    async enable() {
      onStatus("3D 도구를 불러오는 중입니다.");
      const D = await loadDeck();
      if (!overlay) {
        overlay = new D.MapboxOverlay({
          interleaved: true, layers: [],
          getTooltip: ({ object }) => {
            if (object === null || object === undefined || !geom[object]) return null;
            const g = geom[object];
            return { text: `${T.species[T.sp[object]]} · 흉고 ${T.dbh[object]}cm\n추정 높이 ${g.h.toFixed(0)}m · 수관폭 ${g.cw.toFixed(0)}m` };
          },
        });
        map.addControl(overlay);
      }
      on = true;
      addBuildings();
      map.setLayoutProperty("buildings-3d", "visibility", "visible");
      if (map.getZoom() < MIN_ZOOM_3D) map.easeTo({ zoom: 16.5, pitch: 60, bearing: -20, duration: 1200 });
      else map.easeTo({ pitch: 60, bearing: map.getBearing() || -20, duration: 900 });
      refresh();
    },
    disable() {
      on = false;
      if (map.getLayer("buildings-3d")) map.setLayoutProperty("buildings-3d", "visibility", "none");
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
      refresh();
    },
    setColorMode(mode) { colorMode = mode; refresh(); },
    setSelected(i) { selected = i; if (on) refresh(); },
    estimate: i => geom[i],
  };
}
