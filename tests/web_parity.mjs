// 브라우저 탄소 모듈(docs/js/carbon.js)이 파이썬 파이프라인과 같은 값을 내는지 대조한다.
//   node tests/web_parity.mjs
import { readFileSync } from "node:fs";
import { pointEstimate, simulateTree, sizeFactor } from "../docs/js/carbon.js";

const root = new URL("../", import.meta.url);
const P = JSON.parse(readFileSync(new URL("docs/data/params.json", root), "utf8"));
const S = JSON.parse(readFileSync(new URL("docs/data/summary.json", root), "utf8"));
const R = JSON.parse(readFileSync(new URL("data/out/jeonju_extract/results.json", root), "utf8"));

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed++; };

check(sizeFactor(60, 76.2, P.growth.size_decline) === 1, "크기 계수: 최대 흉고 80% 이하는 1");
check(Math.abs(sizeFactor(95.25, 76.2, P.growth.size_decline) - 0.0222) < 1e-9, "크기 계수: 125%에서 0.0222");

for (const sp of R.species.slice(0, 6)) {
  const info = S.species_info[sp.species];
  const tree = { ...info, dbh: sp.median_dbh, block: sp.rep_dbh_block };
  const pt = pointEstimate(tree, P).seq;
  check(Math.abs(pt - sp.rep_point_seq) <= 0.06, `${sp.species} 단일값 ${pt.toFixed(2)} vs 파이썬 ${sp.rep_point_seq}`);
  const sim = simulateTree(tree, P, { n: 20000, seed: 7 }).seq;
  const rel = sim.map((v, i) => Math.abs(v / sp.rep_seq[i] - 1));
  check(Math.max(...rel) < 0.06, `${sp.species} 범위 [${sim.map(v => v.toFixed(1)).join(", ")}] vs 파이썬 [${sp.rep_seq.join(", ")}]`);
}
if (failed) { console.error(`${failed}개 불일치`); process.exit(1); }
console.log("모두 일치");
