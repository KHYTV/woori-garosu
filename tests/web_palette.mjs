// 수종 상징색(SIGNATURE)이 지도에서 함께 많이 나오는 수종끼리 구분되는지 확인한다.
//   node tests/web_palette.mjs [--all]
// 쌍 목록은 전주 가로수를 약 300m 칸으로 나눠 두 수종이 같은 칸에 함께 있는 그루 수(작은 쪽)를 더한 값이 100 이상인 쌍(2026-11 trees.json 기준).
// 색 차이는 OKLab ΔE×100. 색각 이상은 Machado(2009) 적색약·녹색약 시뮬레이션(심도 1.0).
// 기준: 모양이 같은 쌍(둘 다 원)은 정상 시각 ΔE ≥ 15, 색각 이상 ΔE ≥ 6.
//       한쪽만 침엽수(지도에서 세모)라 모양으로도 갈리는 쌍은 정상 시각 ΔE ≥ 10만 본다.
import { SIGNATURE, isConifer } from "../docs/js/characters.js";

const PAIRS = [
  ["느티나무", "벚나무"], ["느티나무", "은행나무"], ["벚나무", "은행나무"], ["느티나무", "이팝나무"], ["단풍나무", "벚나무"],
  ["벚나무", "이팝나무"], ["느티나무", "단풍나무"], ["단풍나무", "은행나무"], ["기타", "벚나무"], ["은행나무", "히말라야시다"],
  ["소나무", "은행나무"], ["기타", "느티나무"], ["느티나무", "회화나무"], ["느티나무", "양버즘나무"], ["느티나무", "메타세쿼이아"],
  ["기타", "은행나무"], ["벚나무", "회화나무"], ["은행나무", "이팝나무"], ["단풍나무", "이팝나무"], ["벚나무", "히말라야시다"],
  ["메타세쿼이아", "버드나무"], ["벚나무", "양버즘나무"], ["버드나무", "히말라야시다"], ["느티나무", "중국단풍"], ["단풍나무", "회화나무"],
  ["단풍나무", "메타세쿼이아"], ["메타세쿼이아", "히말라야시다"], ["양버즘나무", "은행나무"], ["은행나무", "중국단풍"], ["버드나무", "은행나무"],
  ["메타세쿼이아", "팽나무"], ["느티나무", "히말라야시다"], ["팽나무", "회화나무"], ["느티나무", "소나무"], ["메타세쿼이아", "중국단풍"],
  ["메타세쿼이아", "벚나무"], ["메타세쿼이아", "은행나무"], ["양버즘나무", "이팝나무"], ["은행나무", "회화나무"],
];
const M = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
};
const lin = c => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = h => [1, 3, 5].map(i => lin(parseInt(h.slice(i, i + 2), 16)));
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const sim = (c, k) => (k ? M[k].map(r => Math.min(1, Math.max(0, r[0] * c[0] + r[1] * c[1] + r[2] * c[2]))) : c);
export const deltaE = (a, b, k = null) => { const A = oklab(sim(rgb(a), k)), B = oklab(sim(rgb(b), k)); return 100 * Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
const lum = h => { const [r, g, b] = rgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed++; };
const all = process.argv.includes("--all");
for (const [a, b] of PAIRS) {
  const n = deltaE(SIGNATURE[a], SIGNATURE[b]), p = deltaE(SIGNATURE[a], SIGNATURE[b], "protan"), d = deltaE(SIGNATURE[a], SIGNATURE[b], "deutan");
  const shape = isConifer(a) !== isConifer(b);
  const ok = shape ? n >= 10 : n >= 15 && Math.min(p, d) >= 6;
  if (all || !ok) check(ok, `${a}–${b} ΔE 정상 ${n.toFixed(1)} · 적색약 ${p.toFixed(1)} · 녹색약 ${d.toFixed(1)}${shape ? " (세모로도 구분)" : ""}`);
}
if (!all && !failed) check(true, `함께 많이 나오는 ${PAIRS.length}쌍 모두 기준 통과 (자세히: --all)`);
// 아이폰 파일럿 의견: 느티나무와 히말라야시다가 구분되지 않음
check(deltaE(SIGNATURE.느티나무, SIGNATURE.히말라야시다) >= 20, `느티나무–히말라야시다 ΔE ${deltaE(SIGNATURE.느티나무, SIGNATURE.히말라야시다).toFixed(1)} ≥ 20`);
// 벚나무는 분홍(OKLCH 색상각 330~10°)이고 밝은 배경지도(#F2F3F0)에서 대비 2.8 이상
const [L, A, B] = oklab(rgb(SIGNATURE.벚나무)), hue = (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
check((hue >= 330 || hue <= 10) && contrast(SIGNATURE.벚나무, "#F2F3F0") >= 2.8, `벚나무 ${SIGNATURE.벚나무} 분홍(색상각 ${hue.toFixed(0)}°, 밝기 ${L.toFixed(2)}) · 배경지도 대비 ${contrast(SIGNATURE.벚나무, "#F2F3F0").toFixed(2)}`);
check(["메타세쿼이아", "히말라야시다", "소나무", "삼나무", "잎갈나무", "향나무"].every(s => isConifer(s)) && !isConifer("느티나무") && !isConifer("벚나무"), "침엽수 6종은 세모, 활엽수는 원");
if (failed) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log("상징색 모두 통과");
