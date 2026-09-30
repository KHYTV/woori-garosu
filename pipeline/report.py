"""결과를 한 파일짜리 HTML 보고서로 만든다(데이터는 페이지 안에 JSON으로 넣는다)."""

import json

from .schema import ROOT

TEMPLATE = ROOT / "web" / "report_template.html"
TITLES = {"real": "전주 가로수 탄소 추정", "sample": "우리동네가로수 탄소 샘플"}


def build(out: dict) -> str:
    result = {k: v for k, v in out["result"].items() if k != "grid"}  # 격자 합계는 results.json에만 둔다
    payload = json.dumps({"result": result, "map": out["map"]}, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("</", "<\\/")
    html = (TEMPLATE.read_text(encoding="utf-8")
            .replace("__TITLE__", TITLES[result["meta"]["kind"]])
            .replace("__DATA__", payload))
    path = out["out_dir"] / "report.html"
    path.write_text(html, encoding="utf-8")
    return str(path)
