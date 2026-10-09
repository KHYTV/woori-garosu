import { backendEnabled, clearRecords, configureBackend, loadRecords, onlineCounts, pendingRecords, syncPending, toCSV } from "./records.js";

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
const params = new URLSearchParams(location.search);
const dev = ["localhost", "127.0.0.1"].includes(location.hostname);
configureBackend(dev && params.get("backend") ? { url: params.get("backend"), key: params.get("backendkey") || "dev" } : C.backend);
const statusLabel = { complete: "완료", handoff: "외부 설문으로 이동", in_progress: "진행 중·중단" };

async function renderOnline() {
  if (!backendEnabled()) return;
  $("#onlineSec").hidden = false;
  $("#onlineNote").textContent = "불러오는 중입니다.";
  try {
    const rows = await onlineCounts(C.study_id);
    const by = (c, s) => rows.find(r => r.condition === c && r.status === s) || { n: 0, attention_ok: 0, avg_exposure_sec: null };
    const head = el("tr", {}, el("th", {}, "조건"), ...Object.values(statusLabel).map(l => el("th", { class: "r" }, l)),
      el("th", { class: "r" }, "주의 점검 통과(완료 중)"), el("th", { class: "r" }, "평균 노출(초, 완료)"));
    const body = C.conditions.map(c => {
      const done = by(c, "complete");
      return el("tr", {}, el("td", {}, C.condition_labels[c] || c),
        ...Object.keys(statusLabel).map(s => el("td", { class: "r num" }, String(by(c, s).n))),
        el("td", { class: "r num" }, done.n ? `${done.attention_ok}/${done.n}` : "–"),
        el("td", { class: "r num" }, done.avg_exposure_sec ?? "–"));
    });
    $("#onlineCounts").replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
    const total = rows.reduce((a, r) => a + Number(r.n), 0);
    $("#onlineNote").textContent = `서버에 저장된 응답 ${total}건 · ${new Date().toLocaleTimeString("ko-KR")} 기준`;
  } catch (err) {
    console.error(err);
    $("#onlineNote").textContent = "서버 집계를 불러오지 못했습니다. study.json의 backend 주소·키와 SQL 설치(supabase/study_schema.sql)를 확인해 주세요.";
  }
}

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
  $("#exportNote").textContent = `이 기기에 저장된 응답 ${recs.length}건(완료 ${recs.filter(r => r.status === "complete").length}건).`;
  $("#localNotice").textContent = backendEnabled()
    ? "아래는 이 기기 브라우저에 남은 응답입니다. 서버로 보내지 못한 응답이 있으면 다시 보낼 수 있습니다."
    : "서버(Supabase)가 설정되지 않아 응답이 이 기기 브라우저에만 저장됩니다. 실험에 쓴 기기마다 이 화면을 열어 내보낸 뒤 합쳐 주세요.";
  const pending = backendEnabled() ? pendingRecords() : [];
  $("#pendingBox").hidden = !pending.length;
  $("#pendingNote").textContent = `서버로 보내지 못한 응답 ${pending.length}건`;
}

$("#resend").addEventListener("click", async () => {
  $("#resend").disabled = true;
  const r = await syncPending();
  $("#pendingNote").textContent = `보냄 ${r.sent}건, 실패 ${r.failed}건`;
  $("#resend").disabled = false;
  render();
  renderOnline();
});
$("#refreshOnline").addEventListener("click", renderOnline);

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
  ["외부 설문 주소", C.external_survey_url || "없음(내장 설문 사용)"],
  ["응답 저장", backendEnabled() ? `Supabase (${(C.backend && C.backend.url) || params.get("backend")})` : "이 기기 브라우저만"],
  ["메모", C.note]];
$("#config").replaceChildren(...cfg.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
render();
renderOnline();
