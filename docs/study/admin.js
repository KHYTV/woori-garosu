import { clearRecords, loadRecords, toCSV } from "./records.js";

const $ = s => document.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const C = await (await fetch("study.json")).json();

function render() {
  const recs = loadRecords();
  const statuses = ["complete", "handoff", "진행 중"];
  const statusOf = r => (r.status === "complete" || r.status === "handoff" ? r.status : "진행 중");
  const head = el("tr", {}, el("th", {}, "조건"), ...statuses.map(s => el("th", { class: "r" }, { complete: "완료", handoff: "외부 설문으로 이동", "진행 중": "진행 중·중단" }[s])),
    el("th", { class: "r" }, "주의 점검 통과"), el("th", { class: "r" }, "평균 노출(초)"));
  const rows = C.conditions.map(c => {
    const rs = recs.filter(r => r.condition === c);
    const done = rs.filter(r => r.status === "complete");
    const exp = rs.filter(r => r.stimulus_ms);
    return el("tr", {}, el("td", {}, C.condition_labels[c] || c),
      ...statuses.map(s => el("td", { class: "r num" }, String(rs.filter(r => statusOf(r) === s).length))),
      el("td", { class: "r num" }, done.length ? `${done.filter(r => r.attention_ok).length}/${done.length}` : "–"),
      el("td", { class: "r num" }, exp.length ? (exp.reduce((a, r) => a + r.stimulus_ms, 0) / exp.length / 1000).toFixed(0) : "–"));
  });
  $("#counts").replaceChildren(el("thead", {}, head), el("tbody", {}, ...rows));
  $("#exportNote").textContent = `저장된 응답 ${recs.length}건(완료 ${recs.filter(r => r.status === "complete").length}건).`;
}

$("#csv").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  download(`${C.study_id}_${stamp}.csv`, toCSV(loadRecords(), C), "text/csv;charset=utf-8");
});
$("#json").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  download(`${C.study_id}_${stamp}.json`, JSON.stringify({ study: C.study_id, exported_at: new Date().toISOString(), records: loadRecords() }, null, 1), "application/json");
});
$("#confirmText").addEventListener("input", e => { $("#clear").disabled = e.target.value.trim() !== "삭제"; });
$("#clear").addEventListener("click", () => {
  clearRecords();
  $("#confirmText").value = "";
  $("#clear").disabled = true;
  render();
});

$("#pilot").replaceChildren(...C.conditions.map(c => el("li", {}, el("a", { href: `./?cond=${c}&session=pilot` }, `${C.condition_labels[c] || c} 조건으로 시작`))));
const cfg = [["실험 ID", C.study_id], ["상태", C.status], ["대상 나무", C.tree_id], ["최소 노출 시간", `${C.min_exposure_sec}초`],
  ["외부 설문 주소", C.external_survey_url || "없음(내장 설문 사용)"], ["메모", C.note]];
$("#config").replaceChildren(...cfg.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
render();
