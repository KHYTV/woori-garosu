"""나무별 CO2 저장량·연간 흡수량의 몬테카를로 범위 추정.

계산식
  지상부 건중량(kg) = exp(b0 + b1·ln DBH) · exp(잔차)          (Jenkins 등 2003 수종군 식)
  CO2(kg)          = 지상부 × 도시보정 × (1 + 뿌리비) × 탄소비율 × 44/12
  연간 흡수량       = CO2(DBH) − CO2(DBH − 연간 직경생장량)
  연간 직경생장량   = 표준생장(생장 유형) × 서리 없는 기간/153 × 수관 광노출 계수 × (1 − 고사율)
                      × 크기 계수(최대 흉고의 80%부터 125%까지 1 → 0.0222로 선형 감소)   (i-Tree, Nowak 2021)

불확실성 원천
  계통(추출마다 한 번, 모든 나무 공통): 도시보정, 뿌리비, 탄소비율, 수종별 대리군 선택, 서리 없는 기간
  개체(나무마다): 흉고 측정 오차, 상대생장식 잔차, 수관 광노출, 개체 생장 편차
계통 오차를 나무끼리 공유해야 동·구간 합계의 범위가 지나치게 좁아지지 않는다.
"""

import json

import numpy as np
import pandas as pd

from .schema import CONFIG_DIR

SOURCES = {
    "mapping": "수종 대리군 선택",
    "urban_factor": "도시 개방생육 보정",
    "root_shoot": "뿌리/지상부 비율",
    "carbon_fraction": "탄소 비율",
    "dbh_error": "흉고 측정 오차",
    "residual": "상대생장식 개체 잔차",
    "growth": "연간 직경생장량",
}
_SYS_PARAM = {"urban_factor": "urban_factor", "root_shoot": "root_shoot_ratio",
              "carbon_fraction": "carbon_fraction"}


def load_params() -> dict:
    return json.loads((CONFIG_DIR / "carbon_params.json").read_text(encoding="utf-8"))


def _coefs(groups: dict, names) -> tuple[np.ndarray, np.ndarray]:
    return (np.array([groups[g]["b0"] for g in names]),
            np.array([groups[g]["b1"] for g in names]))


def size_factor(dbh, dmax, decline: dict):
    """i-Tree 크기 계수: 최대 흉고의 start(80%)까지 1, end(125%)에서 floor(2.22%)까지 선형 감소."""
    s = np.asarray(dbh, float) / dmax
    f = 1 - (1 - decline["floor"]) * (s - decline["start"]) / (decline["end"] - decline["start"])
    return np.clip(f, decline["floor"], 1.0)


def light_mean(cle: dict) -> float:
    """수관 광노출 계수의 기댓값. 단일값·고정·실측 시나리오의 중심으로 쓴다."""
    return cle["open_factor"] * (1 - cle["partial_prob"]) + cle["partial_factor"] * cle["partial_prob"]


def _growth_inputs(trees: pd.DataFrame, params: dict) -> tuple[np.ndarray, np.ndarray]:
    """나무별 표준생장(고사율 반영, cm/년)과 최대 흉고(cm)."""
    g = params["growth"]
    std = trees["growth_class"].map(g["standard_cm_per_yr"]).to_numpy(float) * (1 - g["dieback"]["value"])
    dmax = trees["mature_height_class"].map(g["max_dbh_cm"]).to_numpy(float)
    return std, dmax


def simulate(trees: pd.DataFrame, params: dict, *, n: int | None = None, seed: int | None = None,
             fixed=frozenset(), overrides: dict | None = None, group_cols=(), chunk: int = 2000):
    """나무별 백분위와 그룹별 합계 추출값을 돌려준다.

    fixed: 중앙값으로 고정할 불확실성 원천(SOURCES 키). 기여도 분석에 쓴다.
    overrides: 시나리오 값(dbh_error_cv, growth_measured_rel_halfwidth, allometry_residual_sd_log,
               mapping_alt_prob, size_decline).
    """
    p = params
    overrides = overrides or {}
    n = n or p["n_draws"]
    rng = np.random.default_rng(p["seed"] if seed is None else seed)
    pct = p["interval_percentiles"]
    groups = {k: v for k, v in p["jenkins_groups"].items() if not k.startswith("_")}

    sys_vals = {}
    for src, key in _SYS_PARAM.items():
        d = p[key]
        sys_vals[src] = np.full(n, d["center"]) if src in fixed else rng.uniform(d["low"], d["high"], n)
    k_sys = sys_vals["urban_factor"] * (1 + sys_vals["root_shoot"]) * sys_vals["carbon_fraction"] * p["co2_per_c"]

    species = sorted(trees["species_ko"].unique())
    sp_idx = trees["species_ko"].map({s: i for i, s in enumerate(species)}).to_numpy()
    alt_prob = 0.0 if "mapping" in fixed else overrides.get("mapping_alt_prob", p["mapping_alt_prob"]["value"])
    alt_choice = rng.random((n, len(species))) < alt_prob

    b0p, b1p = _coefs(groups, trees["jenkins_group"])
    b0a, b1a = _coefs(groups, trees["alt_group"])
    gp = p["growth"]
    std, dmax = _growth_inputs(trees, p)
    ffd = gp["frost_free_days"]
    measured_hw = overrides.get("growth_measured_rel_halfwidth")
    if "growth" in fixed or measured_hw is not None:
        # 실측 생장량이 있으면 서리 기간·광노출 불확실성은 이미 실측값에 들어 있다
        season = np.full(n, ffd["center"] / gp["standard_frost_free_days"])
    else:
        season = rng.uniform(ffd["low"], ffd["high"], n) / gp["standard_frost_free_days"]
    cle = gp["crown_light_exposure"]
    indiv_hw = gp["individual_rel_halfwidth"]["value"]
    decline_on = overrides.get("size_decline", True)
    T = len(trees)
    # 흉고 오차: 일괄 입력 의심 나무는 크게, 시나리오(시민 실측)가 있으면 모두 그 값으로
    if "dbh_error" in fixed:
        cv = np.zeros(T)
    elif "dbh_error_cv" in overrides:
        cv = np.full(T, overrides["dbh_error_cv"])
    else:
        cv = np.full(T, p["dbh_error_cv"]["value"])
        if "dbh_block" in trees:
            cv[trees["dbh_block"].to_numpy(bool)] = p["dbh_error_cv_block"]["value"]
    sd = 0.0 if "residual" in fixed else overrides.get("allometry_residual_sd_log",
                                                        p["allometry_residual_sd_log"]["value"])
    dmin = p["min_dbh_cm"]
    dbh = trees["dbh_cm"].to_numpy(float)

    q_stor = np.empty((T, len(pct)))
    q_seq = np.empty((T, len(pct)))
    acc = {col: {} for col in group_cols}
    for start in range(0, T, chunk):
        sl = slice(start, min(T, start + chunk))
        m = sl.stop - sl.start
        alt = alt_choice[:, sp_idx[sl]]
        b0 = np.where(alt, b0a[sl], b0p[sl])
        b1 = np.where(alt, b1a[sl], b1p[sl])
        d = np.maximum(dbh[sl] * (1 + rng.normal(0, 1, (n, m)) * cv[sl]), dmin)
        eps = rng.normal(0, sd, (n, m)) if sd > 0 else 0.0
        sf = size_factor(d, dmax[sl], gp["size_decline"]) if decline_on else 1.0
        base = std[sl] * season[:, None] * sf
        if "growth" in fixed:
            g = base * light_mean(cle)
        elif measured_hw is not None:
            g = base * light_mean(cle) * (1 + measured_hw * (2 * rng.random((n, m)) - 1))
        else:
            light = np.where(rng.random((n, m)) < cle["partial_prob"], cle["partial_factor"], cle["open_factor"])
            g = base * light * (1 + indiv_hw * (2 * rng.random((n, m)) - 1))
        k = k_sys[:, None] * np.exp(eps)
        stor = np.exp(b0 + b1 * np.log(d)) * k
        prev = np.exp(b0 + b1 * np.log(np.maximum(d - g, dmin))) * k
        seq = stor - prev
        q_stor[sl] = np.percentile(stor, pct, axis=0).T
        q_seq[sl] = np.percentile(seq, pct, axis=0).T
        for col in group_cols:
            codes = trees[col].to_numpy()[sl]
            for key in np.unique(codes):
                mask = codes == key
                a = acc[col].setdefault(key, [np.zeros(n), np.zeros(n)])
                a[0] += stor[:, mask].sum(axis=1)
                a[1] += seq[:, mask].sum(axis=1)

    names = [f"p{q}" for q in pct]
    out = pd.DataFrame(index=trees.index)
    for j, nm in enumerate(names):
        out[f"storage_co2_{nm}"] = q_stor[:, j]
        out[f"seq_co2_{nm}"] = q_seq[:, j]
    return out, acc


def point_estimate(trees: pd.DataFrame, params: dict, size_decline: bool = True) -> pd.DataFrame:
    """단일값 방식(중앙값 계수, 대리군 고정, 생장 기댓값, 잔차 0). 연구2의 '단일값' 조건에 쓴다."""
    p = params
    groups = {k: v for k, v in p["jenkins_groups"].items() if not k.startswith("_")}
    b0, b1 = _coefs(groups, trees["jenkins_group"])
    gp = p["growth"]
    std, dmax = _growth_inputs(trees, p)
    k = (p["urban_factor"]["center"] * (1 + p["root_shoot_ratio"]["center"])
         * p["carbon_fraction"]["center"] * p["co2_per_c"])
    d = np.maximum(trees["dbh_cm"].to_numpy(float), p["min_dbh_cm"])
    sf = size_factor(d, dmax, gp["size_decline"]) if size_decline else 1.0
    g = std * gp["frost_free_days"]["center"] / gp["standard_frost_free_days"] * light_mean(gp["crown_light_exposure"]) * sf
    prev = np.maximum(d - g, p["min_dbh_cm"])
    stor = np.exp(b0 + b1 * np.log(d)) * k
    seq = stor - np.exp(b0 + b1 * np.log(prev)) * k
    return pd.DataFrame({"point_storage_co2": stor, "point_seq_co2": seq}, index=trees.index)


def summarize_groups(acc: dict, pct) -> dict:
    """그룹별 합계 추출값 → 톤 단위 백분위."""
    result = {}
    for col, groups in acc.items():
        rows = []
        for key, (stor, seq) in groups.items():
            rows.append({
                "key": str(key),
                "storage_t": [round(float(v) / 1000, 2) for v in np.percentile(stor, pct)],
                "seq_t": [round(float(v) / 1000, 3) for v in np.percentile(seq, pct)],
            })
        result[col] = sorted(rows, key=lambda r: -r["storage_t"][1])
    return result


def contributions(tree: pd.DataFrame, params: dict, n: int = 4000) -> dict:
    """한 나무의 불확실성 원천별 기여도(해당 원천만 변동시킨 80% 구간 폭)."""
    full, _ = simulate(tree, params, n=n)
    lo, hi = f"seq_co2_p{params['interval_percentiles'][0]}", f"seq_co2_p{params['interval_percentiles'][-1]}"
    base = float(full[hi].iloc[0] - full[lo].iloc[0])
    rows = []
    for src, label in SOURCES.items():
        only, _ = simulate(tree, params, n=n, fixed=frozenset(SOURCES) - {src})
        rows.append({"source": src, "label": label,
                     "seq_width": round(float(only[hi].iloc[0] - only[lo].iloc[0]), 2)})
    return {"all_sources_seq_width": round(base, 2),
            "by_source": sorted(rows, key=lambda r: -r["seq_width"])}


def scenario(tree: pd.DataFrame, params: dict, name: str, n: int = 4000) -> dict:
    """시나리오(예: 시민 실측) 적용 전후 범위 비교."""
    sc = params["scenarios"][name]
    before, _ = simulate(tree, params, n=n)
    after, _ = simulate(tree, params, n=n, overrides=sc)
    cols = [f"seq_co2_p{q}" for q in params["interval_percentiles"]]
    return {"label": sc["label"],
            "before": [round(float(before[c].iloc[0]), 1) for c in cols],
            "after": [round(float(after[c].iloc[0]), 1) for c in cols]}
