"""웹 데모(docs/)용 정적 데이터를 만든다.

  python -m pipeline.export_web                       # data/out/jeonju_extract → docs/data
  python -m pipeline.export_web --dataset sample_jeonju_synthetic

run_all이 만든 carbon_profiles.csv·results.json을 읽어, 지도가 바로 쓰는 열 단위 JSON과
요약·계수 JSON을 docs/data/에 쓰고, 분석 보고서를 docs/report/에 복사한다.
"""

import argparse
import json
import shutil

import pandas as pd

from . import carbon, etl
from .schema import CONFIG_DIR, OUT_DIR, ROOT

DOCS = ROOT / "docs"
GRADES = ["A", "B", "C", "X"]


def _round_list(series, digits):
    return [None if pd.isna(v) else round(float(v), digits) for v in series]


def export(dataset: str) -> dict:
    src = OUT_DIR / dataset
    df = pd.read_csv(src / "carbon_profiles.csv", encoding="utf-8-sig", dtype={"tree_id": str})
    result = json.loads((src / "results.json").read_text(encoding="utf-8"))
    df = df[df["grade"] != "X"].reset_index(drop=True)

    species = sorted(df["species_ko"].unique())
    roads = sorted(df["road_section"].astype(str).unique())
    sp_idx = {s: i for i, s in enumerate(species)}
    rd_idx = {r: i for i, r in enumerate(roads)}
    issues = df["issues"].fillna("")
    trees = {
        "species": species, "roads": roads, "grades": GRADES,
        "id": df["tree_id"].tolist(),
        "lon": _round_list(df["lon"], 6), "lat": _round_list(df["lat"], 6),
        "dbh": _round_list(df["dbh_cm"], 1),
        "sp": df["species_ko"].map(sp_idx).tolist(),
        "rd": df["road_section"].astype(str).map(rd_idx).tolist(),
        "grade": df["grade"].map(GRADES.index).tolist(),
        "block": issues.str.contains("dbh_block").astype(int).tolist(),
        "seq": [_round_list(df[f"seq_co2_p{q}"], 1) for q in (10, 50, 90)],
        "stor": [_round_list(df[f"storage_co2_p{q}"], 0) for q in (10, 50, 90)],
        "point_seq": _round_list(df["point_seq_co2"], 1),
    }

    table = etl.load_species_table().set_index("species_ko")
    species_info = {
        s: {k: table.loc[s, k] for k in ("scientific_name", "jenkins_group", "alt_group", "growth_class",
                                         "mature_height_class", "crown_shape", "leaf_habit", "autumn_color",
                                         "autumn_color_name", "mapping_note")}
        for s in species
    }
    summary = {
        "meta": result["meta"], "extraction": result["extraction"], "quality": result["quality"],
        "totals": result["totals"], "model_notes": result["model_notes"],
        "species": [{k: s[k] for k in ("species", "scientific_name", "count", "median_dbh", "total_seq_t",
                                        "total_storage_t", "rep_seq", "dbh_block_share")} for s in result["species"]],
        "roads": sorted(result["roads"], key=lambda r: -r["count"])[:30],
        "species_info": species_info,
    }

    out = DOCS / "data"
    out.mkdir(parents=True, exist_ok=True)
    compact = {"separators": (",", ":"), "ensure_ascii": False}
    (out / "trees.json").write_text(json.dumps(trees, **compact), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, **compact), encoding="utf-8")
    (out / "params.json").write_text(json.dumps(carbon.load_params(), **compact), encoding="utf-8")
    shutil.copyfile(CONFIG_DIR / "boundaries" / "jeonju_osm.geojson", out / "boundary.geojson")
    shutil.copyfile(CONFIG_DIR / "tree_form.json", out / "tree_form.json")

    reports = DOCS / "report"
    reports.mkdir(parents=True, exist_ok=True)
    for name, target in (("jeonju_extract", "jeonju.html"), ("sample_jeonju_synthetic", "sample.html")):
        report = OUT_DIR / name / "report.html"
        if report.exists():
            html = report.read_text(encoding="utf-8")
            # 보고서는 게시용 뼈대 없이 만들어지므로 독립 페이지로 쓸 수 있게 문서 틀을 씌운다
            if not html.lstrip().lower().startswith("<!doctype"):
                html = ('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
                        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                        '<style>body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
                        + html + "\n</body>\n</html>\n")
            (reports / target).write_text(html, encoding="utf-8")
    return {"trees": len(df), "species": len(species), "roads": len(roads),
            "bytes": {p.name: p.stat().st_size for p in out.iterdir()}}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="jeonju_extract")
    args = ap.parse_args()
    print(json.dumps(export(args.dataset), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
