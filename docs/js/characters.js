// 수종별 나무 캐릭터(SVG). 같은 뼈대로 두 가지 그림을 그린다.
//   style "character": 얼굴이 있는 게임풍 캐릭터(인트로, SNS 아바타)
//   style "real":      얼굴 없이 잎·껍질 질감을 넣은 실물풍 그림(동네 찾기 화면)
// 크기는 흉고로 추정한 높이·수관폭(tree_form.json)을 따르고, 계절과 기분(mood)에 따라 바뀐다.
import { estimateForm } from "./treeform.js";

const VIEW_W = 200, VIEW_H = 240, BASE_Y = 222, CX = 100, PX_PER_M = 170 / 22;

export const ARCHETYPE = {
  은행나무: "ginkgo", 벚나무: "cherry", 느티나무: "zelkova", 팽나무: "zelkova", 회화나무: "zelkova",
  이팝나무: "fringe", 단풍나무: "maple", 중국단풍: "maple", 양버즘나무: "plane",
  메타세쿼이아: "conifer", 삼나무: "conifer", 잎갈나무: "conifer", 향나무: "juniper", 히말라야시다: "cedar",
  소나무: "pine", 감나무: "persimmon", 참나무: "oak", 버드나무: "willow", 아까시나무: "locust",
  모감주나무: "goldenrain", 목련: "magnolia", 기타: "generic",
};
export const MOODS = ["happy", "thirsty", "hot", "cold", "sleepy", "proud", "sad"];

const BARK = { ginkgo: "#8a7e70", cherry: "#4b332a", zelkova: "#7a6552", plane: "#9c9074", conifer: "#8b5a3c",
  juniper: "#7d5f48", cedar: "#6e5544", pine: "#8a5a3a", persimmon: "#5e4a3c", oak: "#6b5443", willow: "#7f6a52",
  locust: "#6f5c4b", goldenrain: "#75604e", magnolia: "#8b8378", maple: "#6b5243", fringe: "#7a6a5c", generic: "#6b4f3a" };
const LEAF = { ginkgo: "#6fae52", cherry: "#4e8c48", zelkova: "#4f8f4b", plane: "#5a9a4e", conifer: "#4f8a5a",
  juniper: "#2f5d3a", cedar: "#39694a", pine: "#2f6b3f", persimmon: "#3f7a44", oak: "#4a8347", willow: "#86b55e",
  locust: "#68a35a", goldenrain: "#5e9c52", magnolia: "#4f8a4f", maple: "#5a9850", fringe: "#5f9e55", generic: "#5a8f4e" };
const SPRING = { ginkgo: "#9ccc65", cherry: "#f3c3d1", fringe: "#f4f2e6", magnolia: "#f7f1ea", willow: "#b7d57a", locust: "#8fc06c" };
const BLOSSOM_DOT = { cherry: "#fde8ef", fringe: "#ffffff", magnolia: "#ffffff", locust: "#f6f3e8", goldenrain: "#f2c230" };
const EVERGREEN = new Set(["juniper", "cedar", "pine"]);

export function archetype(species, info) {
  if (ARCHETYPE[species]) return ARCHETYPE[species];
  if (info?.leaf_habit === "evergreen") return info.crown_shape === "umbrella" ? "pine" : "juniper";
  if (info?.crown_shape === "cone") return "conifer";
  if (info?.crown_shape === "umbrella") return "zelkova";
  return "generic";
}

export function seasonForDate(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = v => Math.round(v * 10) / 10;

// 색을 밝게(f>0)·어둡게(f<0)
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = s => clamp(Math.round(f >= 0 ? s + (255 - s) * f : s * (1 + f)), 0, 255);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(ch);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function layout(type, info, dbh, form, style = "character") {
  const shape = form?.shapes?.[info?.crown_shape] || { crown_base_ratio: 0.35 };
  const g = form && info ? estimateForm(dbh, info, form)
    : { h: 1.3 + (15 - 1.3) * (1 - Math.exp(-0.04 * dbh)), cw: 1.2 + 0.18 * dbh };
  const H = clamp(g.h * PX_PER_M, 72, 188);
  let CW = clamp(g.cw * PX_PER_M * 1.15, 48, 176);
  if (type === "conifer" || type === "juniper") CW = clamp(CW * 0.6, 34, 96);
  if (type === "cedar") CW = clamp(CW * 0.8, 44, 130);
  const trunkW = clamp(5 + dbh * 0.28, 6, 34);
  let baseRatio = type === "pine" ? 0.5 : type === "willow" ? 0.3 : clamp(shape.crown_base_ratio, 0.12, 0.5);
  if (style === "character") {
    // 캐릭터는 얼굴이 들어가는 수관을 크게, 줄기는 짧게 해서 더 사람처럼 보이게 한다
    CW = clamp(CW * 1.45, 86, 184);
    baseRatio = clamp(baseRatio * 0.55, 0.1, 0.3);
  }
  const crownH = H * (1 - baseRatio);
  return { H, CW, trunkW, top: BASE_Y - H, crownH, crownBottom: BASE_Y - H + crownH, cx: CX };
}

function palette(type, info, season) {
  const leaf = LEAF[type];
  const bark = BARK[type];
  const evergreen = EVERGREEN.has(type) || info?.leaf_habit === "evergreen";
  if (evergreen) return { fill: season === "spring" ? shade(leaf, 0.12) : leaf, bark, bare: false, evergreen: true };
  if (season === "winter") return { fill: null, bark, bare: true, evergreen: false };
  if (season === "spring") return { fill: SPRING[type] || shade(leaf, 0.22), bark, bare: type === "magnolia", evergreen: false, blossom: BLOSSOM_DOT[type] };
  if (season === "autumn") return { fill: info?.autumn_color || "#c49a3a", bark, bare: false, evergreen: false };
  return { fill: leaf, bark, bare: false, evergreen: false, blossom: type === "goldenrain" ? BLOSSOM_DOT.goldenrain : null };
}

// ---------- 줄기와 가지 ----------
function trunkPath(cx, topY, bottomY, wTop, wBottom, lean = 0) {
  const flare = wBottom * 0.5;
  return `M${r1(cx - wBottom / 2 - flare)} ${bottomY} Q${r1(cx - wBottom / 2)} ${r1(bottomY - 6)} ${r1(cx - wBottom / 2)} ${r1(bottomY - 10)} L${r1(cx + lean - wTop / 2)} ${topY} L${r1(cx + lean + wTop / 2)} ${topY} L${r1(cx + wBottom / 2)} ${r1(bottomY - 10)} Q${r1(cx + wBottom / 2)} ${r1(bottomY - 6)} ${r1(cx + wBottom / 2 + flare)} ${bottomY} Z`;
}
function branch(x0, y0, x1, y1, w, color, curve = 0) {
  const mx = (x0 + x1) / 2 + curve, my = (y0 + y1) / 2;
  return `<path d="M${r1(x0)} ${r1(y0)} Q${r1(mx)} ${r1(my)} ${r1(x1)} ${r1(y1)}" stroke="${color}" stroke-width="${r1(w)}" fill="none" stroke-linecap="round"/>`;
}
// 겨울 뼈대: 줄기에서 갈라지는 가지와 잔가지
function skeleton(L, rand, color, { spread = 1, up = 1, count = 5, weeping = false } = {}) {
  const out = [];
  const { cx, top, crownH, trunkW, CW } = L;
  const base = L.crownBottom - crownH * 0.1;
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const dir = i % 2 ? 1 : -1;
    const x1 = cx + dir * CW * 0.45 * spread * (0.4 + rand() * 0.6);
    const y1 = top + crownH * (0.15 + (1 - t) * 0.5) * up;
    const y0 = base - crownH * t * 0.35;
    out.push(branch(cx, y0, x1, y1, trunkW * 0.35 * (1 - t * 0.4), color, dir * 10));
    for (let k = 0; k < 2; k++) {
      const x2 = x1 + dir * (6 + rand() * 18), y2 = weeping ? y1 + 20 + rand() * 30 : y1 - 10 - rand() * 22;
      out.push(branch(x1, y1, x2, y2, trunkW * 0.14, color, dir * 4));
    }
  }
  return out.join("");
}
function trunk(type, L, pal, rand) {
  const { cx, trunkW, crownBottom, top, crownH } = L;
  const parts = [];
  const bottom = BASE_Y, topY = type === "pine" ? crownBottom + crownH * 0.3 : crownBottom + crownH * 0.25;
  if (type === "pine") {
    // 굽은 소나무 줄기
    const d = `M${cx - trunkW / 2 - 4} ${bottom} C${cx - trunkW / 2} ${bottom - 40} ${cx + 10} ${bottom - 50} ${cx + 8 - trunkW / 4} ${topY} L${cx + 8 + trunkW / 4} ${topY} C${cx + trunkW / 2 + 14} ${bottom - 50} ${cx + trunkW / 2} ${bottom - 40} ${cx + trunkW / 2 + 4} ${bottom} Z`;
    parts.push(`<path d="${d}" fill="${pal.bark}"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="${shade(pal.bark, -0.3)}" stroke-width="1" stroke-dasharray="3 5" opacity="0.6"/>`);
    return parts.join("");
  }
  const wTop = type === "zelkova" ? trunkW * 0.9 : trunkW * 0.62;
  parts.push(`<path d="${trunkPath(cx, topY, bottom, wTop, trunkW)}" fill="${pal.bark}"/>`);
  // 껍질 질감
  if (type === "plane") {
    for (let i = 0; i < 7; i++) {
      const y = bottom - 12 - i * ((bottom - topY) / 7), w = trunkW * (0.3 + rand() * 0.35);
      parts.push(`<ellipse cx="${r1(cx + (rand() - 0.5) * trunkW * 0.5)}" cy="${r1(y)}" rx="${r1(w / 2)}" ry="${r1(4 + rand() * 5)}" fill="${["#d9d2b8", "#b8b37f", "#9aa08a"][i % 3]}" opacity="0.9"/>`);
    }
  } else if (type === "cherry") {
    for (let i = 0; i < 6; i++) {
      const y = bottom - 14 - i * ((bottom - topY) / 6.5);
      parts.push(`<line x1="${r1(cx - trunkW * 0.3)}" y1="${r1(y)}" x2="${r1(cx + trunkW * 0.3)}" y2="${r1(y + 1)}" stroke="${shade(pal.bark, 0.35)}" stroke-width="1.4" stroke-linecap="round"/>`);
    }
  } else if (type === "ginkgo" || type === "oak" || type === "zelkova" || type === "conifer" || type === "cedar") {
    for (let i = -1; i <= 1; i++) {
      parts.push(`<line x1="${r1(cx + i * trunkW * 0.22)}" y1="${r1(bottom - 8)}" x2="${r1(cx + i * wTop * 0.22)}" y2="${r1(topY + 6)}" stroke="${shade(pal.bark, -0.28)}" stroke-width="1" opacity="0.7"/>`);
    }
  }
  // 수관 속으로 들어가는 큰 가지
  const bc = shade(pal.bark, -0.08);
  if (type === "zelkova" || type === "oak" || type === "locust") {
    for (const [dx, dy] of [[-0.42, 0.25], [0.4, 0.22], [-0.2, 0.1], [0.18, 0.08]]) {
      parts.push(branch(cx, topY + 4, cx + dx * L.CW, top + crownH * dy + crownH * 0.25, trunkW * 0.3, bc, dx * 12));
    }
  } else if (type !== "conifer" && type !== "juniper" && type !== "cedar") {
    parts.push(branch(cx, topY + 2, cx - L.CW * 0.28, crownBottom - crownH * 0.35, trunkW * 0.3, bc, -8),
      branch(cx, topY + 2, cx + L.CW * 0.26, crownBottom - crownH * 0.4, trunkW * 0.28, bc, 8));
  }
  return parts.join("");
}

// ---------- 수관 ----------
function blobs(L, rand, fill, { w = L.CW, h = L.crownH, cyShift = 0, n = 7, real = false, flatTop = false } = {}) {
  const { cx, top } = L;
  const cy = top + h / 2 + cyShift;
  const out = [];
  const dark = shade(fill, -0.22), light = shade(fill, 0.18);
  // 뒤쪽 어두운 덩어리 → 본체 → 밝은 덩어리 순서로 겹친다
  const layers = real ? [[dark, 0.5], [fill, 1], [light, 0.45]] : [[dark, 0.4], [fill, 1]];
  for (const [color, share] of layers) {
    const count = Math.max(2, Math.round(n * share));
    for (let i = 0; i < count; i++) {
      const ang = rand() * Math.PI * 2, rad = rand() * 0.42;
      const bx = cx + Math.cos(ang) * rad * w, by = cy + Math.sin(ang) * rad * h * (flatTop ? 0.6 : 1) + (color === light ? -h * 0.12 : color === dark ? h * 0.1 : 0);
      const rx = w * (0.22 + rand() * 0.16), ry = h * (0.2 + rand() * 0.14);
      out.push(`<ellipse cx="${r1(bx)}" cy="${r1(by)}" rx="${r1(rx)}" ry="${r1(ry)}" fill="${color}"/>`);
    }
    if (color === fill) out.push(`<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(w / 2)}" ry="${r1(h / 2 * (flatTop ? 0.8 : 1))}" fill="${fill}"/>`);
  }
  return out.join("");
}
function cone(L, rand, fill, { layers = 5, droop = false, wScale = 1 } = {}) {
  const { cx, top, crownH, CW } = L;
  const out = [];
  const dark = shade(fill, -0.25);
  for (let i = 0; i < layers; i++) {
    const t = i / layers, y1 = top + crownH * (0.18 + t * 0.82), y0 = top + crownH * t * 0.75;
    const half = CW * wScale * (0.12 + t * 0.4);
    const sag = droop ? 8 + t * 10 : 0;
    const d = `M${r1(cx)} ${r1(y0)} Q${r1(cx - half * 0.6)} ${r1(y1 - 8)} ${r1(cx - half)} ${r1(y1 + sag)} Q${r1(cx)} ${r1(y1 - 6 + sag * 0.5)} ${r1(cx + half)} ${r1(y1 + sag)} Q${r1(cx + half * 0.6)} ${r1(y1 - 8)} ${r1(cx)} ${r1(y0)} Z`;
    out.push(`<path d="${d}" fill="${i % 2 ? fill : dark}"/>`);
  }
  // 꼭대기
  out.push(`<path d="M${r1(cx)} ${r1(top)} L${r1(cx - CW * wScale * 0.1)} ${r1(top + crownH * 0.2)} L${r1(cx + CW * wScale * 0.1)} ${r1(top + crownH * 0.2)} Z" fill="${fill}"/>`);
  return out.join("");
}
function pineCrown(L, rand, fill) {
  const { cx, top, crownH, CW } = L;
  const out = [];
  const tufts = [[cx - CW * 0.28, top + crownH * 0.55, 0.42, 0.3], [cx + CW * 0.3, top + crownH * 0.45, 0.4, 0.28], [cx + 6, top + crownH * 0.2, 0.5, 0.32]];
  for (const [x, y, w, h] of tufts) {
    out.push(`<ellipse cx="${r1(x)}" cy="${r1(y + 6)}" rx="${r1(CW * w)}" ry="${r1(crownH * h * 0.5)}" fill="${shade(fill, -0.22)}"/>`);
    out.push(`<path d="M${r1(x - CW * w)} ${r1(y + 4)} Q${r1(x - CW * w * 0.5)} ${r1(y - crownH * h)} ${r1(x)} ${r1(y - crownH * h * 0.6)} Q${r1(x + CW * w * 0.5)} ${r1(y - crownH * h)} ${r1(x + CW * w)} ${r1(y + 4)} Q${r1(x)} ${r1(y + 10)} ${r1(x - CW * w)} ${r1(y + 4)} Z" fill="${fill}"/>`);
  }
  return out.join("");
}
function willowCrown(L, rand, fill, real) {
  const { cx, top, crownH, CW } = L;
  const out = [blobs(L, rand, fill, { h: crownH * 0.7, n: 6, real })];
  const bottom = top + crownH * 0.55;
  for (let i = 0; i < 14; i++) {
    const x = cx - CW / 2 + (i + 0.5) * (CW / 14) + (rand() - 0.5) * 6;
    const len = crownH * (0.35 + rand() * 0.45);
    out.push(`<path d="M${r1(x)} ${r1(bottom - 10)} q${r1((rand() - 0.5) * 10)} ${r1(len * 0.6)} ${r1((rand() - 0.5) * 6)} ${r1(len)}" stroke="${i % 2 ? fill : shade(fill, -0.18)}" stroke-width="${real ? 3 : 4}" fill="none" stroke-linecap="round"/>`);
  }
  return out.join("");
}
function dots(L, rand, color, n, { rxy = 3, within = 0.42, upper = false } = {}) {
  const { cx, top, crownH, CW } = L;
  const out = [];
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2, rad = Math.sqrt(rand()) * within;
    const x = cx + Math.cos(ang) * rad * CW, y = top + crownH / 2 + Math.sin(ang) * rad * crownH * (upper ? 0.7 : 1);
    out.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(rxy * (0.7 + rand() * 0.6))}" fill="${color}"/>`);
  }
  return out.join("");
}
// 실물풍 잎 질감
function leafTexture(type, L, rand, fill) {
  const { cx, top, crownH, CW } = L;
  const dark = shade(fill, -0.3), light = shade(fill, 0.3);
  const out = [];
  const n = 18;
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2, rad = Math.sqrt(rand()) * 0.4;
    const x = r1(cx + Math.cos(ang) * rad * CW), y = r1(top + crownH / 2 + Math.sin(ang) * rad * crownH);
    const c = i % 3 ? dark : light;
    if (type === "ginkgo") out.push(`<path d="M${x} ${y} l-4 -5 q4 -3 8 0 z" fill="${c}"/>`);
    else if (type === "maple") out.push(`<path d="M${x} ${y} l-3 -3 l1 3 l-4 1 l4 2 l-1 3 l3 -2 l3 2 l-1 -3 l4 -2 l-4 -1 l1 -3 z" fill="${c}"/>`);
    else if (type === "plane" || type === "oak") out.push(`<path d="M${x} ${y} q-5 -3 -3 -7 q3 -3 6 -1 q4 -3 5 2 q3 4 -2 6 q-3 3 -6 0 z" fill="${c}"/>`);
    else if (type === "conifer" || type === "cedar" || type === "pine" || type === "juniper") out.push(`<path d="M${x} ${y} l-5 -2 M${x} ${y} l-4 3 M${x} ${y} l5 -3" stroke="${c}" stroke-width="1" fill="none"/>`);
    else if (type === "willow") out.push(`<path d="M${x} ${y} q-2 -5 0 -9 q2 4 0 9 z" fill="${c}"/>`);
    else out.push(`<path d="M${x} ${y} q-4 -4 -2 -8 q4 0 5 5 q0 3 -3 3 z" fill="${c}"/>`);
  }
  return out.join("");
}

function crown(type, L, pal, rand, season, real) {
  const fill = pal.fill;
  if (pal.bare) {
    const color = shade(pal.bark, -0.05);
    const parts = [skeleton(L, rand, color, { count: type === "zelkova" ? 7 : 5, spread: type === "ginkgo" ? 0.5 : 1, up: type === "ginkgo" ? 1.3 : 1, weeping: type === "willow" })];
    if (type === "conifer") parts.push(cone(L, rand, shade(pal.bark, 0.25), { layers: 6, wScale: 0.7 }));
    if (type === "persimmon") parts.push(dots(L, rand, "#e8752a", 4, { rxy: 4 }));
    if (type === "plane") parts.push(dots(L, rand, "#8d7a5a", 5, { rxy: 3 }));
    if (type === "magnolia" && season === "spring") parts.push(dots(L, rand, "#fbf6f0", 12, { rxy: 6 }), dots(L, rand, "#f1cfd6", 6, { rxy: 4 }));
    else if (type === "magnolia") parts.push(dots(L, rand, "#b9a898", 10, { rxy: 2 }));
    return parts.join("");
  }
  const parts = [];
  switch (type) {
    case "conifer": parts.push(cone(L, rand, fill, { layers: 6 })); break;
    case "juniper": parts.push(cone(L, rand, fill, { layers: 7, wScale: 0.8 })); break;
    case "cedar": parts.push(cone(L, rand, fill, { layers: 5, droop: true })); break;
    case "pine": parts.push(pineCrown(L, rand, fill)); break;
    case "willow": parts.push(willowCrown(L, rand, fill, real)); break;
    case "ginkgo": parts.push(blobs(L, rand, fill, { w: L.CW * 0.78, h: L.crownH * 1.02, n: 6, real })); break;
    case "zelkova": parts.push(blobs(L, rand, fill, { w: L.CW * 1.08, h: L.crownH * 0.78, n: 9, real, flatTop: true })); break;
    case "maple": parts.push(blobs(L, rand, fill, { n: 8, real })); break;
    default: parts.push(blobs(L, rand, fill, { n: 7, real }));
  }
  if (real && !["willow"].includes(type)) parts.push(leafTexture(type, L, rand, fill));
  if (pal.blossom) {
    if (type === "cherry") parts.push(dots(L, rand, pal.blossom, 18, { rxy: 3.5 }));
    else if (type === "fringe") parts.push(dots(L, rand, pal.blossom, 22, { rxy: 4 }));
    else if (type === "locust") parts.push(dots(L, rand, pal.blossom, 10, { rxy: 2.5 }));
    else if (type === "goldenrain") parts.push(dots(L, rand, pal.blossom, 14, { rxy: 3, upper: true }));
  }
  if (season === "autumn" && type === "persimmon") parts.push(dots(L, rand, "#ef7b2b", 9, { rxy: 4.5 }));
  if (season === "autumn" && type === "ginkgo") parts.push(dots(L, rand, shade(fill, 0.35), 8, { rxy: 2.5 }));
  if (season === "summer" && type === "cherry" && real) parts.push(dots(L, rand, "#7a2030", 6, { rxy: 2 }));
  return parts.join("");
}

// ---------- 얼굴 ----------
function face(L, mood, pal, type) {
  const { cx, top, crownH, CW } = L;
  const narrow = type === "conifer" || type === "juniper" || type === "cedar";
  const fy = top + crownH * (narrow ? 0.6 : 0.52);
  const dx = clamp(CW * 0.15, 10, 24);
  const er = clamp(CW * 0.065, 5, 10);
  const ink = "#1f2a22";
  const eye = (x, closed) => closed
    ? `<path d="M${r1(x - er)} ${r1(fy)} q${r1(er)} ${r1(er * 0.9)} ${r1(er * 2)} 0" stroke="${ink}" stroke-width="${r1(clamp(er * 0.3, 2, 3))}" fill="none" stroke-linecap="round"/>`
    : `<circle cx="${r1(x)}" cy="${r1(fy)}" r="${r1(er)}" fill="#fff"/><circle cx="${r1(x + er * 0.25)}" cy="${r1(fy + er * 0.15)}" r="${r1(er * 0.55)}" fill="${ink}"/><circle cx="${r1(x + er * 0.45)}" cy="${r1(fy - er * 0.2)}" r="${r1(er * 0.18)}" fill="#fff"/>`;
  const my = fy + er * 2.2;
  const sw = r1(clamp(er * 0.32, 2, 3.2));
  const mouth = {
    happy: `<path d="M${r1(cx - dx * 0.7)} ${r1(my)} q${r1(dx * 0.7)} ${r1(er * 1.6)} ${r1(dx * 1.4)} 0" stroke="${ink}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`,
    proud: `<path d="M${r1(cx - dx * 0.8)} ${r1(my - 2)} q${r1(dx * 0.8)} ${r1(er * 2.4)} ${r1(dx * 1.6)} 0 z" fill="${ink}"/><path d="M${r1(cx - dx * 0.4)} ${r1(my + er * 0.9)} q${r1(dx * 0.4)} ${r1(er * 0.6)} ${r1(dx * 0.8)} 0" fill="#e47b8a"/>`,
    thirsty: `<ellipse cx="${r1(cx)}" cy="${r1(my + 2)}" rx="${r1(er * 0.7)}" ry="${r1(er * 0.9)}" fill="${ink}"/>`,
    hot: `<path d="M${r1(cx - dx * 0.6)} ${r1(my + 2)} q${r1(dx * 0.6)} ${r1(-er)} ${r1(dx * 1.2)} 0" stroke="${ink}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`,
    cold: `<path d="M${r1(cx - dx * 0.6)} ${r1(my)} l${r1(dx * 0.3)} 3 l${r1(dx * 0.3)} -3 l${r1(dx * 0.3)} 3 l${r1(dx * 0.3)} -3" stroke="${ink}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`,
    sleepy: `<ellipse cx="${r1(cx)}" cy="${r1(my + 1)}" rx="${r1(er * 0.5)}" ry="${r1(er * 0.6)}" fill="${ink}"/>`,
    sad: `<path d="M${r1(cx - dx * 0.6)} ${r1(my + 3)} q${r1(dx * 0.6)} ${r1(-er * 1.4)} ${r1(dx * 1.2)} 0" stroke="${ink}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`,
  }[mood] || "";
  const closed = mood === "sleepy" || mood === "proud";
  const extras = [];
  const brow = (x, dir) => `<path d="M${r1(x - er * 0.9)} ${r1(fy - er * 1.7 + dir * er * 0.35)} q${r1(er * 0.9)} ${r1(-er * 0.45 - dir * er * 0.6)} ${r1(er * 1.8)} ${r1(-dir * er * 0.7)}" stroke="${ink}" stroke-width="${sw}" fill="none" stroke-linecap="round" opacity="0.75"/>`;
  if (mood === "sad" || mood === "thirsty") extras.push(brow(cx - dx, -1), `<g transform="translate(${r1(cx + dx)} ${r1(fy)}) scale(-1 1) translate(${r1(-(cx + dx))} ${r1(-fy)})">${brow(cx + dx, -1)}</g>`);
  if (mood === "proud" || mood === "hot") extras.push(brow(cx - dx, 1), `<g transform="translate(${r1(cx + dx)} ${r1(fy)}) scale(-1 1) translate(${r1(-(cx + dx))} ${r1(-fy)})">${brow(cx + dx, 1)}</g>`);
  if (mood === "thirsty" || mood === "hot") extras.push(`<path d="M${r1(cx + dx + er * 1.6)} ${r1(fy - er * 1.5)} q4 6 0 9 q-4 -3 0 -9 z" fill="#6fb6ff"/>`);
  if (mood === "hot") extras.push(`<path d="M${r1(cx - dx - er * 2.4)} ${r1(fy - er * 2)} q2 -4 0 -8 M${r1(cx - dx - er * 1.6)} ${r1(fy - er * 2)} q2 -4 0 -8" stroke="#e86a4a" stroke-width="1.6" fill="none" stroke-linecap="round"/>`);
  if (mood === "cold") extras.push(`<text x="${r1(cx + dx + er * 1.8)}" y="${r1(fy - er)}" font-size="10" fill="#6fb6ff">❄</text>`);
  if (mood === "proud") extras.push(`<text x="${r1(cx - dx - er * 3.2)}" y="${r1(fy - er * 1.5)}" font-size="11" fill="#f2c230">✦</text>`);
  if (mood === "sleepy") extras.push(`<text x="${r1(cx + dx + er * 1.6)}" y="${r1(fy - er * 1.2)}" font-size="11" fill="${ink}" opacity="0.7">z</text>`);
  const blush = mood === "happy" || mood === "proud" ? `<circle cx="${r1(cx - dx - er * 1.2)}" cy="${r1(fy + er * 1.2)}" r="${r1(er * 0.7)}" fill="#f09a9a" opacity="0.55"/><circle cx="${r1(cx + dx + er * 1.2)}" cy="${r1(fy + er * 1.2)}" r="${r1(er * 0.7)}" fill="#f09a9a" opacity="0.55"/>` : "";
  return `<g class="tree-face">${eye(cx - dx, closed)}${eye(cx + dx, closed)}${mouth}${blush}${extras.join("")}</g>`;
}

/**
 * 나무 한 그루의 SVG 문자열.
 * @param {object} o  species, info(수종 정보), dbh, form(tree_form.json), season, style("character"|"real"), mood, seed, size, label
 */
export function treeSVG(o) {
  const { species = "기타", info = null, dbh = 15, form = null, style = "character", mood = "happy", size = 160, label } = o;
  const season = o.season || seasonForDate();
  const type = archetype(species, info);
  const rand = rng(o.seed ?? hashSeed(`${species}|${dbh}`));
  const L = layout(type, info, dbh, form, style);
  const pal = palette(type, info, season);
  const real = style === "real";
  const parts = [];
  parts.push(`<ellipse cx="${CX}" cy="${BASE_Y + 4}" rx="${r1(Math.max(L.trunkW * 2.2, L.CW * 0.42))}" ry="6" fill="#000" opacity="${real ? 0.14 : 0.1}"/>`);
  // 줄기와 가지를 먼저, 수관을 그 위에 그려 가지가 잎에 가려지게 한다
  parts.push(`<g class="tree-trunk">${trunk(type, L, pal, rand)}</g><g class="tree-crown">${crown(type, L, pal, rand, season, real)}</g>`);
  if (!real && !pal.bare) parts.push(face(L, mood, pal, type));
  else if (!real && pal.bare) parts.push(face({ ...L, top: L.top + 4 }, mood === "happy" ? "sleepy" : mood, pal, type));
  const aria = label || `${species} 캐릭터`;
  const w = size, h = Math.round(size * VIEW_H / VIEW_W);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${w}" height="${h}" class="tree tree-${type} season-${season} style-${style} mood-${mood}" role="img" aria-label="${esc(aria)}">${parts.join("")}</svg>`;
}

// 계절·날씨·활동에서 캐릭터 기분을 고른다
export function moodFor({ season = seasonForDate(), weather = null, lastCareDays = null, justCared = false } = {}) {
  if (justCared) return "proud";
  if (weather?.heat) return "hot";
  if (weather?.freeze) return "cold";
  if (weather?.dry && season !== "winter") return "thirsty";
  if (season === "winter") return "sleepy";
  if (lastCareDays !== null && lastCareDays > 30) return "sad";
  return "happy";
}
