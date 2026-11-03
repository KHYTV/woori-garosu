// 검색창 자동완성: 검색창 아래 드롭다운(종류·소속 표시, 일치 글자 강조, 터치·키보드).
// 키 입력 때는 기기 안 지명 사전(gazetteer.json)만 찾고, 외부 지오코딩은 Enter·검색 때 home.js가 부른다.
import { searchPlacesScored, matchRanges } from "./geo.js";

export const KIND_LABEL = { gu: "구", dong: "행정동", jibun: "법정동", road: "도로", poi: "장소", apt: "아파트", addr: "주소" };
export const kindLabel = p => (p.kind === "poi" && p.cat) ? p.cat : (KIND_LABEL[p.kind] || p.kind || "장소");

// 보조 표기: 소속 구·행정동
export function placeSub(p) {
  if (p.note) return p.note;
  if (p.kind === "addr") return [p.sub, `${p.source || "지도"} 검색 결과`].filter(Boolean).join(" · ");
  if (p.kind === "gu") return "전주시";
  if (p.kind === "dong") return p.gu || "전주시";
  if (p.kind === "road") return p.gu ? `${p.gu} 일대 도로` : "도로";
  const hjd = p.hjd && p.hjd !== p.name ? `${p.hjd}${p.kind === "jibun" ? " 행정동" : ""}` : null;
  return [p.gu, hjd].filter(Boolean).join(" · ");
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
function highlighted(name, q) {
  const out = [];
  let at = 0;
  for (const [s, e] of q ? matchRanges(name, q) : []) {
    if (s > at) out.push(name.slice(at, s));
    out.push(el("mark", {}, name.slice(s, e)));
    at = e;
  }
  if (at < name.length) out.push(name.slice(at));
  return out;
}

/**
 * @param o.input     검색 input
 * @param o.form      input이 든 form(드롭다운을 그 아래에 붙인다)
 * @param o.places    () => 지명 사전 배열
 * @param o.onChoose  장소를 골랐을 때 (place)
 * @param o.onSubmit  목록에서 고르지 않고 Enter·'검색'을 눌렀을 때 (text)
 */
export function createSearchBox({ input, form, places, onChoose, onSubmit }) {
  const id = `ac-${Math.random().toString(36).slice(2, 7)}`;
  const list = el("ul", { class: "ac-list", id, role: "listbox", "aria-label": "검색 후보", hidden: true });
  form.classList.add("ac-host");
  form.append(list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", id);
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("list");
  let items = [], active = -1, closeTimer = null;

  function close() {
    list.hidden = true; items = []; active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function setActive(i) {
    active = i;
    list.querySelectorAll("[role=option]").forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
    const cur = list.querySelector(`#${id}-${i}`);
    if (cur) { input.setAttribute("aria-activedescendant", cur.id); cur.scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  }
  function pick(i) {
    const it = items[i];
    if (!it) return;
    close();
    if (it.submit) { onSubmit(input.value); return; }
    input.value = it.name;
    onChoose(it);
  }
  // rows: 장소 목록. title: 위 제목. q: 강조할 검색어. action: 마지막 줄 '주소·건물 검색'
  function render(rows, { title = null, q = "", action = true } = {}) {
    items = [...rows];
    const text = input.value.trim();
    if (action && text) items.push({ submit: true, name: text });
    list.replaceChildren(
      ...(title ? [el("li", { class: "ac-head", role: "presentation" }, title)] : []),
      ...items.map((p, i) => el("li", { id: `${id}-${i}`, role: "option", class: p.submit ? "ac-item ac-action" : "ac-item", "aria-selected": "false",
        onpointerdown: e => e.preventDefault(), // 입력창 포커스를 잃지 않게(모바일 키보드 깜빡임 방지)
        onclick: () => pick(i) },
        p.submit
          ? [el("span", { class: "ac-kind", "data-kind": "search" }, "검색"), el("span", { class: "ac-txt" }, el("span", { class: "ac-name" }, `‘${p.name}’ 주소·건물로 찾기`), el("span", { class: "ac-sub" }, "번지·건물 이름은 지도 검색(OpenStreetMap)으로 찾아요"))]
          : [el("span", { class: "ac-kind", "data-kind": p.kind }, kindLabel(p)),
             el("span", { class: "ac-txt" }, el("span", { class: "ac-name" }, ...highlighted(p.name, q)), el("span", { class: "ac-sub" }, placeSub(p)))])),
      el("li", { class: "ac-src", role: "presentation" }, "지명: OpenStreetMap 기여자(ODbL) · 행정동 경계: 통계청"));
    list.hidden = !items.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
    setActive(-1);
  }
  function suggest() {
    const q = input.value;
    if (!q.trim()) { close(); return; }
    render(searchPlacesScored(places(), q, 8).map(s => s.p), { q });
  }

  input.addEventListener("input", suggest);
  input.addEventListener("focus", () => { if (input.value.trim() && list.hidden) suggest(); });
  input.addEventListener("blur", () => { clearTimeout(closeTimer); closeTimer = setTimeout(() => { if (document.activeElement !== input) close(); }, 200); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (list.hidden) { suggest(); if (list.hidden) return; }
      e.preventDefault();
      const n = items.length, d = e.key === "ArrowDown" ? 1 : -1;
      setActive(active < 0 ? (d > 0 ? 0 : n - 1) : (active + d + n) % n);
    } else if (e.key === "Enter" && !list.hidden && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      close();
    }
  });
  document.addEventListener("pointerdown", e => { if (!list.hidden && !form.contains(e.target)) close(); });

  return {
    close,
    // 외부 검색 뒤 후보 목록(사용자가 고른다)
    showCandidates(rows, q, title = "어느 곳인가요? 골라 주세요") {
      clearTimeout(closeTimer);
      render(rows, { title, q, action: false });
    },
  };
}
