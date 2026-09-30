"""전체 파이프라인 실행.

  python -m pipeline.run_all                                  # 합성 샘플(없으면 생성)
  python -m pipeline.run_all --input data/raw/jeonju_extract.csv --kind real \
      --summary data/raw/jeonju_extract_summary.json          # 전주 실데이터(extract_region으로 추출한 파일)

출력은 data/out/<입력 파일 이름>/ 에 쓴다.
"""

import argparse
import json
from pathlib import Path

import pandas as pd

from . import carbon, etl, make_sample
from .aggregate import assign_grid
from .export_itree import to_itree
from .schema import LARGE_TREE_DBH_CM, OUT_DIR, RAW_DIR

SEOUL_SAMPLE = {"species_ko": "느티나무", "dbh_cm": 33.0, "storage_lb_c": 478.10}
LB_TO_KG = 0.45359237
JEONJU_REPORTED_TOTAL = {"count": 57950, "as_of": "2016-09", "source": "전주시 발표(2016년 10월 보도)"}
GRADES = ["A", "B", "C", "X"]


def _one_tree(species_tbl: pd.DataFrame, species: str, dbh: float, dbh_block: bool = False) -> pd.DataFrame:
    r = species_tbl.loc[species]
    return pd.DataFrame([{"species_ko": species, "dbh_cm": dbh, "jenkins_group": r.jenkins_group,
                          "alt_group": r.alt_group, "growth_class": r.growth_class,
                          "mature_height_class": r.mature_height_class, "dbh_block": dbh_block}])


def _map_payload(df: pd.DataFrame, pct) -> dict:
    """보고서 지도용 열 단위 배열(나무 3~4만 그루도 수 MB 안에 들어가게)."""
    m = df[df["on_map"]]
    species = sorted(m["species_ko"].unique())
    roads = sorted(m["road_section"].unique())
    sp_idx = {s: i for i, s in enumerate(species)}
    rd_idx = {r: i for i, r in enumerate(roads)}
    has = m["carbon_eligible"].to_numpy()

    def col(name, digits):
        return [round(float(v), digits) if ok else None for v, ok in zip(m[name], has)]

    max_dbh = carbon.load_params()["growth"]["max_dbh_cm"]
    height = m.groupby("species_ko")["mature_height_class"].first()
    return {
        "species": species, "roads": roads, "grades": GRADES,
        "sp_dmax": [max_dbh[height[s]] for s in species],
        "id": m["tree_id"].tolist(),
        "lon": m["lon"].round(6).tolist(), "lat": m["lat"].round(6).tolist(),
        "dbh": [None if pd.isna(v) else round(float(v), 1) for v in m["dbh_cm"]],
        "sp": m["species_ko"].map(sp_idx).tolist(), "rd": m["road_section"].map(rd_idx).tolist(),
        "grade": m["grade"].map(GRADES.index).tolist(), "issues": m["issues"].tolist(),
        "seq": [col(f"seq_co2_p{q}", 1) for q in pct],
        "stor": [col(f"storage_co2_p{q}", 0) for q in pct],
        "point_seq": col("point_seq_co2", 1),
    }


def run(input_path, n_draws=None, kind="sample", summary_path=None, label=None) -> dict:
    params = carbon.load_params()
    if n_draws:
        params["n_draws"] = n_draws
    pct = params["interval_percentiles"]
    input_path = Path(input_path)
    out_dir = OUT_DIR / input_path.stem
    out_dir.mkdir(parents=True, exist_ok=True)

    df = etl.clean(etl.read_source(input_path))
    quality = etl.quality_report(df)

    mapped = df[df["on_map"]].copy()
    grid_ids, grid_centers = assign_grid(mapped)
    df.loc[mapped.index, "grid_id"] = grid_ids

    elig = df[df["carbon_eligible"]].assign(area="전체")
    per_tree, acc = carbon.simulate(elig, params, group_cols=("area", "road_section", "species_ko", "grid_id"))
    point = carbon.point_estimate(elig, params)
    df = df.join(per_tree).join(point)
    groups = carbon.summarize_groups(acc, pct)
    counts = {col: elig[col].value_counts() for col in ("road_section", "species_ko", "grid_id")}
    for col in ("road_section", "species_ko", "grid_id"):
        for row in groups[col]:
            row["count"] = int(counts[col].get(row["key"], 0))
    for row in groups["grid_id"]:
        row["center"] = grid_centers[row["key"]]

    species_tbl = etl.load_species_table().set_index("species_ko")
    species_summary = []
    for sp, g in elig.groupby("species_ko"):
        rep_dbh = float(g["dbh_cm"].median())
        # 대표 나무는 그 수종의 흔한 데이터 상태(일괄 입력 여부)를 따른다
        rep_block = bool(g["dbh_block"].mean() >= 0.5)
        rep = _one_tree(species_tbl, sp, rep_dbh, rep_block)
        sim, _ = carbon.simulate(rep, params, n=4000)
        pt = carbon.point_estimate(rep, params).iloc[0]
        total = next(r for r in groups["species_ko"] if r["key"] == sp)
        species_summary.append({
            "species": sp, "scientific_name": species_tbl.loc[sp, "scientific_name"],
            "jenkins_group": species_tbl.loc[sp, "jenkins_group"],
            "growth_class": species_tbl.loc[sp, "growth_class"],
            "mapping_note": species_tbl.loc[sp, "mapping_note"],
            "count": int(len(g)), "median_dbh": rep_dbh, "rep_dbh_block": rep_block,
            "dbh_block_share": round(float(g["dbh_block"].mean()), 4),
            "total_storage_t": total["storage_t"], "total_seq_t": total["seq_t"],
            "rep_seq": [round(float(sim[f"seq_co2_p{q}"].iloc[0]), 1) for q in pct],
            "rep_storage": [round(float(sim[f"storage_co2_p{q}"].iloc[0])) for q in pct],
            "rep_point_seq": round(float(pt["point_seq_co2"]), 1),
            "contributions": carbon.contributions(rep, params),
            "scenarios": {name: carbon.scenario(rep, params, name) for name in params["scenarios"]},
        })
    species_summary.sort(key=lambda r: -r["count"])

    seoul_tree = _one_tree(species_tbl, SEOUL_SAMPLE["species_ko"], SEOUL_SAMPLE["dbh_cm"])
    seoul_sim, _ = carbon.simulate(seoul_tree, params, n=4000)
    c = params["co2_per_c"]
    seoul_cmp = {
        **SEOUL_SAMPLE,
        "storage_kg_c_seoul": round(SEOUL_SAMPLE["storage_lb_c"] * LB_TO_KG, 1),
        "storage_kg_c_ours": [round(float(seoul_sim[f"storage_co2_p{q}"].iloc[0]) / c, 1) for q in pct],
    }

    keep = ["tree_id", "species_ko", "scientific_name", "dbh_cm", "lat", "lon", "road_section",
            "grade", "issues", "grid_id"] + list(per_tree.columns) + list(point.columns)
    df[keep].to_csv(out_dir / "carbon_profiles.csv", index=False, encoding="utf-8-sig")
    to_itree(df).to_csv(out_dir / "itree_eco_import.csv", index=False, encoding="utf-8-sig")

    features = []
    for r in df[df["on_map"]].itertuples():
        props = {"id": r.tree_id, "species": r.species_ko, "dbh": None if pd.isna(r.dbh_cm) else r.dbh_cm,
                 "road": r.road_section, "grade": r.grade, "issues": r.issues}
        if r.carbon_eligible:
            props["storage"] = [round(getattr(r, f"storage_co2_p{q}")) for q in pct]
            props["seq"] = [round(getattr(r, f"seq_co2_p{q}"), 1) for q in pct]
            props["point_seq"] = round(r.point_seq_co2, 1)
        features.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "Point", "coordinates": [round(r.lon, 6), round(r.lat, 6)]}})
    (out_dir / "trees.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False), encoding="utf-8")

    extraction = json.loads(Path(summary_path).read_text(encoding="utf-8")) if summary_path else None
    ok = df[df["carbon_eligible"]]
    large = (ok["dbh_cm"] >= LARGE_TREE_DBH_CM).to_numpy()
    # 큰 나무 생장 둔화 반영 전후(단일값 기준) 비교
    no_decline = carbon.point_estimate(elig, params, size_decline=False)["point_seq_co2"].to_numpy()
    with_decline = ok["point_seq_co2"].to_numpy()
    gp = params["growth"]
    dmax = elig["mature_height_class"].map(gp["max_dbh_cm"]).to_numpy(float)
    slowed = (elig["dbh_cm"].to_numpy(float) / dmax) > gp["size_decline"]["start"]
    model_notes = {
        "large_tree": {
            "threshold_cm": LARGE_TREE_DBH_CM, "count": int(large.sum()),
            "share_trees": round(float(large.mean()), 4),
            "share_seq_p50": round(float(ok.loc[large, "seq_co2_p50"].sum() / ok["seq_co2_p50"].sum()), 4),
        },
        "size_decline": {
            "slowed_trees": int(slowed.sum()), "slowed_share": round(float(slowed.mean()), 4),
            "slowed_seq_before_t": round(float(no_decline[slowed].sum()) / 1000, 2),
            "slowed_seq_after_t": round(float(with_decline[slowed].sum()) / 1000, 2),
            "total_seq_before_t": round(float(no_decline.sum()) / 1000, 2),
            "total_seq_after_t": round(float(with_decline.sum()) / 1000, 2),
            "by_species": [
                {"species": sp, "slowed": int(s_mask.sum()), "count": int(len(s_mask))}
                for sp, s_mask in ((sp, slowed[(elig["species_ko"] == sp).to_numpy()])
                                   for sp in elig["species_ko"].value_counts().index)
                if s_mask.sum()
            ],
        },
    }
    result = {
        "meta": {"input": input_path.name, "kind": kind, "label": label or input_path.stem,
                 "param_version": params["version"], "n_draws": params["n_draws"], "interval": pct,
                 "reported_total": JEONJU_REPORTED_TOTAL if kind == "real" else None},
        "extraction": extraction,
        "model_notes": model_notes,
        "quality": quality,
        "totals": groups["area"][0],
        "roads": groups["road_section"],
        "grid": groups["grid_id"],
        "species": species_summary,
        "seoul_comparison": seoul_cmp,
        "params": params,
    }
    (out_dir / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"result": result, "map": _map_payload(df, pct), "out_dir": out_dir}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="산림청 스키마 CSV 경로")
    ap.add_argument("--kind", choices=["sample", "real"], default=None, help="합성 샘플(sample) 또는 실데이터(real)")
    ap.add_argument("--summary", help="extract_region이 만든 추출 요약 JSON")
    ap.add_argument("--label", help="보고서에 표시할 데이터 이름")
    ap.add_argument("--draws", type=int, help="몬테카를로 추출 수")
    args = ap.parse_args()
    path = Path(args.input) if args.input else RAW_DIR / "sample_jeonju_synthetic.csv"
    if not args.input and not path.exists():
        make_sample.main()
    kind = args.kind or ("sample" if path.stem.startswith("sample") else "real")
    label = args.label or ("합성 샘플(전북대 주변 가상 구간)" if kind == "sample" else None)
    out = run(path, args.draws, kind, args.summary, label)
    q, t = out["result"]["quality"], out["result"]["totals"]
    print(f"입력 {q['rows']}행 · 지도 {q['on_map']} · 탄소계산 {q['carbon_eligible']} · 등급 {q['grades']}")
    print(f"CO2 저장량 {t['storage_t']} t · 연간 흡수량 {t['seq_t']} t/년 (p10, p50, p90)")
    from .report import build
    print(f"보고서 → {build(out)}")


if __name__ == "__main__":
    main()
