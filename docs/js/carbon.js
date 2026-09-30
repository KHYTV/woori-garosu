// pipeline/carbon.py의 한 그루 계산을 브라우저로 옮긴 것. 계수는 data/params.json을 그대로 쓴다.
// 난수 생성기는 파이썬과 달라 백분위가 조금 다를 수 있지만 분포는 같다(tests/web_parity.mjs로 대조).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalFrom(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// numpy.percentile 기본값(linear)과 같은 보간
export function percentile(sorted, q) {
  const pos = (sorted.length - 1) * (q / 100);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function sizeFactor(dbh, dmax, decline) {
  const s = dbh / dmax;
  const f = 1 - (1 - decline.floor) * (s - decline.start) / (decline.end - decline.start);
  return Math.min(1, Math.max(decline.floor, f));
}

export function lightMean(cle) {
  return cle.open_factor * (1 - cle.partial_prob) + cle.partial_factor * cle.partial_prob;
}

function groupCoef(P, name) {
  const g = P.jenkins_groups[name];
  return [g.b0, g.b1];
}

function treeInputs(tree, P) {
  const G = P.growth;
  return {
    std: G.standard_cm_per_yr[tree.growth_class] * (1 - G.dieback.value),
    dmax: G.max_dbh_cm[tree.mature_height_class],
  };
}

// 단일값(중앙값 계수, 대리군 고정, 생장 기댓값, 잔차 0)
export function pointEstimate(tree, P) {
  const G = P.growth;
  const [b0, b1] = groupCoef(P, tree.jenkins_group);
  const { std, dmax } = treeInputs(tree, P);
  const k = P.urban_factor.center * (1 + P.root_shoot_ratio.center) * P.carbon_fraction.center * P.co2_per_c;
  const d = Math.max(tree.dbh, P.min_dbh_cm);
  const g = std * G.frost_free_days.center / G.standard_frost_free_days * lightMean(G.crown_light_exposure)
    * sizeFactor(d, dmax, G.size_decline);
  const prev = Math.max(d - g, P.min_dbh_cm);
  const stor = Math.exp(b0 + b1 * Math.log(d)) * k;
  return { storage: stor, seq: stor - Math.exp(b0 + b1 * Math.log(prev)) * k };
}

/**
 * 한 그루의 몬테카를로 추정.
 * opts.dbhCv: 흉고 오차(없으면 일괄 입력 여부로 결정), opts.measuredGrowth: 생장을 실측했는지
 */
export function simulateTree(tree, P, opts = {}) {
  const n = opts.n || P.n_draws;
  const rand = mulberry32(opts.seed ?? P.seed);
  const G = P.growth, cle = G.crown_light_exposure, ffd = G.frost_free_days;
  const [b0p, b1p] = groupCoef(P, tree.jenkins_group);
  const [b0a, b1a] = groupCoef(P, tree.alt_group);
  const { std, dmax } = treeInputs(tree, P);
  const cv = opts.dbhCv ?? (tree.block ? P.dbh_error_cv_block.value : P.dbh_error_cv.value);
  const sd = P.allometry_residual_sd_log.value;
  const altProb = P.mapping_alt_prob.value;
  const indiv = G.individual_rel_halfwidth.value;
  const measuredHw = P.scenarios.citizen_measured.growth_measured_rel_halfwidth;
  const uni = (lo, hi) => lo + (hi - lo) * rand();
  const stor = new Float64Array(n), seq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const kSys = uni(P.urban_factor.low, P.urban_factor.high) * (1 + uni(P.root_shoot_ratio.low, P.root_shoot_ratio.high))
      * uni(P.carbon_fraction.low, P.carbon_fraction.high) * P.co2_per_c;
    const alt = rand() < altProb;
    const b0 = alt ? b0a : b0p, b1 = alt ? b1a : b1p;
    const d = Math.max(tree.dbh * (1 + normalFrom(rand) * cv), P.min_dbh_cm);
    const k = kSys * Math.exp(normalFrom(rand) * sd);
    const season = (opts.measuredGrowth ? ffd.center : uni(ffd.low, ffd.high)) / G.standard_frost_free_days;
    const base = std * season * sizeFactor(d, dmax, G.size_decline);
    let g;
    if (opts.measuredGrowth) g = base * lightMean(cle) * (1 + measuredHw * (2 * rand() - 1));
    else g = base * (rand() < cle.partial_prob ? cle.partial_factor : cle.open_factor) * (1 + indiv * (2 * rand() - 1));
    stor[i] = Math.exp(b0 + b1 * Math.log(d)) * k;
    seq[i] = stor[i] - Math.exp(b0 + b1 * Math.log(Math.max(d - g, P.min_dbh_cm))) * k;
  }
  stor.sort(); seq.sort();
  const qs = P.interval_percentiles;
  return { storage: qs.map(q => percentile(stor, q)), seq: qs.map(q => percentile(seq, q)) };
}

// 흉고둘레(cm, 1.2m 높이) → 흉고직경(cm)
export const circumferenceToDbh = c => c / Math.PI;
