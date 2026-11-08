// 처음 쓰는 사람 안내(사용성 평가 파일럿 반영).
//  - 인트로의 '할 수 있는 일 3가지'(아이콘은 하단 탭 아이콘과 같게 해 어디로 가면 되는지 이어지게)
//  - 지도 첫 방문 단계 안내(3단계). 내 나무가 아직 없을 때 앱을 열 때마다 한 번 뜨고, '다시 보지 않기'를 누르면 다시 뜨지 않는다(localStorage)
//  - 상단바 오른쪽·지도 위 '도움말' 버튼: 사용법과 화면별로 무엇을 하는지 다시 보기
const KEY = "wg-guide-map"; // "off" = 다시 보지 않기
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 동작 */ } },
};
let shownThisVisit = false;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const icon = markup => { const s = el("span", { class: "g-ico", "aria-hidden": "true" }); s.innerHTML = markup; return s; };
const SVG = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
// 하단 탭과 같은 아이콘
const I = {
  map: SVG(`<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>`),
  tree: SVG(`<circle cx="12" cy="9" r="6"/><path d="M12 15v6"/>`),
  city: SVG(`<path d="M5 20V11M12 20V5M19 20v-6"/>`),
  me: SVG(`<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4.1 3.4-6.5 7.5-6.5s7.5 2.4 7.5 6.5"/>`),
  search: SVG(`<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>`),
  pick: SVG(`<circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="8"/>`),
  heart: SVG(`<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>`),
  locate: SVG(`<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/>`),
  help: SVG(`<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17h.01"/>`),
};

export const SERVICE_LINE = "우리 동네 가로수와 친구가 되어 돌보고, 나무가 흡수하는 탄소와 내 생활 실천을 함께 기록해요.";

// 인트로: 할 수 있는 일 3가지
export function introSteps() {
  const steps = [[I.map, "나무 찾아", "친구 맺기"], [I.tree, "돌봄·실천", "기록하기"], [I.city, "동네와", "함께 보기"]];
  return el("ol", { class: "intro-steps", "aria-label": "할 수 있는 일" }, ...steps.map(([svg, a, b], k) =>
    el("li", {}, icon(svg), el("span", { class: "g-txt" }, el("b", {}, `${k + 1}`), ` ${a}`, el("br"), b))));
}

const MAP_STEPS = [
  [I.search, "찾기", "검색창에 동·도로·건물 이름을 넣거나, 오른쪽 위 내 위치 버튼으로 내 주변을 봐요."],
  [I.pick, "고르기", "지도의 점이나 아래 목록에서 나무를 골라요."],
  [I.heart, "친구 맺기", "'친구 맺기'를 누르고 이름을 지어 주면 끝이에요."],
];
const stepList = () => el("ol", { class: "guide-steps" }, ...MAP_STEPS.map(([svg, t, d], k) =>
  el("li", {}, icon(svg), el("div", {}, el("b", {}, `${k + 1}. ${t}`), el("p", {}, d)))));

function openDialog(cls, ...kids) {
  const d = el("dialog", { class: `sheet-dialog guide-dialog ${cls}` }, el("div", { class: "dialog-form" }, ...kids));
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

// 지도 첫 방문 안내. 띄웠으면 true(이때 위치 찾기는 사용자가 버튼을 누를 때 한다)
export function mapGuide({ hasTrees = false, located = false, onLocate, onSearch } = {}) {
  if (shownThisVisit || hasTrees || store.get(KEY) === "off") return false;
  if (!document.body.contains(document.querySelector("#s-map")) || typeof HTMLDialogElement !== "function") return false;
  shownThisVisit = true;
  let d;
  const close = after => () => { d.close(); after?.(); };
  const primary = located
    ? el("button", { type: "button", class: "btn big", onclick: close(), "data-guide-close": true }, "알겠어요")
    : el("button", { type: "button", class: "btn big", onclick: close(onLocate), "data-guide-close": true }, icon(I.locate), "내 주변 나무 보기");
  d = openDialog("map-guide",
    el("p", { class: "eyebrow" }, "처음이세요?"),
    el("h2", {}, "지도에서 나무와 친구 맺기"),
    stepList(),
    primary,
    el("div", { class: "row between guide-foot" },
      located ? el("span") : el("button", { type: "button", class: "btn ghost small", onclick: close(onSearch) }, "주소로 찾을게요"),
      el("button", { type: "button", class: "link-btn", onclick: close(() => store.set(KEY, "off")) }, "다시 보지 않기")));
  return true;
}

// 도움말: 사용법 다시 보기 + 화면별로 무엇을 하나요
export function openHelp() {
  const rows = [
    [I.map, "#map", "지도", "나무 찾기 · 친구 맺기"],
    [I.tree, "#sns", "내 나무", "수종 · 오늘 흡수량 · 돌봄 기록 · 대화 · 사진"],
    [I.me, "#profile", "내 프로필", "생활 실천 기록 · 내 감축량 · 레벨"],
    [I.city, "#city", "전주 현황", "전주 가로수 전체 연간 흡수량 · 오늘 흡수량"],
  ];
  let d;
  d = openDialog("help",
    el("h2", {}, "사용법"),
    el("p", { class: "small" }, SERVICE_LINE),
    el("h3", {}, "어디서 무엇을 하나요 (아래 탭)"),
    el("ul", { class: "guide-tabs" }, ...rows.map(([svg, href, name, what]) =>
      el("li", {}, el("a", { href, onclick: () => d.close() }, icon(svg), el("b", {}, name), el("span", {}, what))))),
    el("h3", {}, "나무와 친구 맺기 3단계"),
    stepList(),
    el("p", { class: "small" }, "탄소 수치는 공공데이터로 계산한 추정값(검증 전)이에요."),
    el("div", { class: "row end" }, el("button", { type: "button", class: "btn", onclick: () => d.close() }, "닫기")));
}

// 상단바 오른쪽 빈 칸에 도움말 버튼
export function mountHelp() {
  const slot = document.querySelector(".topbar-end");
  if (!slot || slot.querySelector("#helpBtn")) return;
  slot.removeAttribute("aria-hidden");
  slot.append(el("button", { type: "button", class: "help-btn", id: "helpBtn", "aria-label": "도움말 · 사용법 다시 보기", onclick: openHelp }, icon(I.help), el("span", {}, "도움말")));
}
// 지도는 상단바가 없어 지도 위('나무 등록' 옆)에 둔다
export function mountMapHelp(box) {
  if (box.querySelector(".map-help")) return;
  const btn = el("button", { type: "button", class: "map-help", "aria-label": "도움말 · 사용법 다시 보기", onclick: openHelp }, icon(I.help));
  const bar = box.querySelector(".user-reg-bar");
  const reg = bar?.querySelector(".user-reg-btn");
  if (reg) bar.insertBefore(btn, reg);
  else box.querySelector(".map-top")?.append(btn);
}
