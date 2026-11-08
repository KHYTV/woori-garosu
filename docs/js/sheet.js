// 지도 화면 아래 시트(#mapSheet)를 끌어 접고 펼친다.
//   - 손잡이(.handle, 화면 너비 44px 띠)를 끌거나, 시트 내용이 맨 위일 때 아래로 끌면 접힌다(손잡이와 제목 줄만 남음).
//   - 접힌 시트는 끌어 올리거나 손잡이·제목 줄을 누르면 펼쳐진다. 손잡이는 키보드(Enter·Space)와 스크린리더(aria-expanded)로도 쓴다.
//   - 시트 내용이 바뀌면(새 검색·나무 선택 등으로 시트를 새로 그리면) 다시 펼친다.
// 시트를 그리는 쪽(home.js·area.js·friends.js·register.js)은 지금처럼 첫 자식으로 <span class="handle">만 넣으면 된다.

const SLOP = 8;          // 이만큼 움직여야 끌기로 본다(px)
const DECIDE = 0.28;     // 접힌 높이와 펼친 높이 사이에서 이 비율 넘게 끌면 상태를 바꾼다
const FLICK = 0.45;      // 손을 뗄 때 속도가 이보다 빠르면(px/ms) 거리와 상관없이 그 방향으로

/** #mapSheet 한 번만 부른다. */
export function initSheet(sheet) {
  if (!sheet || sheet.dataset.sheetReady) return;
  sheet.dataset.sheetReady = "1";
  let seenHandle = null, drag = null, suppressClick = 0, anim = null;

  const handle = () => (sheet.firstElementChild?.classList.contains("handle") ? sheet.firstElementChild : null);
  const collapsed = () => sheet.classList.contains("collapsed");
  const label = c => (c ? "정보 펼치기" : "정보 접기");

  function decorate() {
    const h = handle();
    if (!h) return;
    const c = collapsed();
    h.setAttribute("role", "button");
    h.setAttribute("tabindex", "0");
    h.setAttribute("aria-controls", sheet.id || "mapSheet");
    h.setAttribute("aria-expanded", String(!c));
    h.setAttribute("aria-label", label(c));
    h.title = label(c);
  }
  // 손잡이와 첫 줄(제목)까지의 높이 = 접힌 높이
  function collapsedHeight() {
    const cs = getComputedStyle(sheet);
    const kids = [...sheet.children].filter(k => getComputedStyle(k).display !== "none").slice(0, 2);
    const gap = parseFloat(cs.rowGap) || 0;
    const h = kids.reduce((a, k) => a + k.getBoundingClientRect().height, 0) + gap * Math.max(0, kids.length - 1);
    return Math.ceil(h + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
  }
  // 펼쳤을 때의 자연 높이(max-height 반영)
  function expandedHeight() {
    const prev = sheet.style.height, wasC = collapsed();
    sheet.classList.remove("collapsed");
    sheet.style.height = "";
    const h = sheet.getBoundingClientRect().height;
    if (wasC) sheet.classList.add("collapsed");
    sheet.style.height = prev;
    return h;
  }
  function finishAnim() {
    if (!anim) return;
    const a = anim; anim = null;
    clearTimeout(a.timer);
    sheet.removeEventListener("transitionend", a.done);
    sheet.classList.remove("sheet-anim", "sheet-dragging");
    sheet.style.height = "";
    sheet.classList.toggle("collapsed", a.to);
    decorate();
  }
  /** 접기(true)·펼치기(false). from: 지금 높이(끌던 중이면 그 높이) */
  function setCollapsed(to, { animate = true, from = null } = {}) {
    finishAnim();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce || !sheet.isConnected || sheet.offsetParent === null) {
      sheet.classList.remove("sheet-dragging");
      sheet.style.height = "";
      sheet.classList.toggle("collapsed", to);
      decorate();
      return;
    }
    const start = from ?? sheet.getBoundingClientRect().height;
    const target = to ? collapsedHeight() : expandedHeight();
    sheet.classList.remove("collapsed");          // 움직이는 동안은 내용을 다 두고 높이로 자른다
    sheet.classList.add("sheet-dragging");
    sheet.style.height = `${start}px`;
    sheet.getBoundingClientRect();                // 시작 높이 확정
    sheet.classList.add("sheet-anim");
    sheet.style.height = `${target}px`;
    const done = e => { if (!e || e.target === sheet) finishAnim(); };
    anim = { to, done, timer: setTimeout(done, 400) };
    sheet.addEventListener("transitionend", done);
    sheet.querySelector(".handle")?.setAttribute("aria-expanded", String(!to));
  }
  const toggle = () => setCollapsed(!collapsed());

  // 시트를 새로 그리면(손잡이가 새것이면) 펼친다
  const onContent = () => {
    const h = handle();
    if (h && h !== seenHandle) {
      seenHandle = h;
      drag = null;
      if (collapsed() || anim) setCollapsed(false, { animate: false });
      else decorate();
    }
  };
  new MutationObserver(onContent).observe(sheet, { childList: true });
  // 그리는 쪽은 모두 sheet.replaceChildren을 쓰고, 그 직후 시트 높이를 읽어 지도를 맞추기도 한다(동네 경계 fit).
  // 관찰자(마이크로태스크)보다 먼저 펼쳐 두려고 이 요소의 replaceChildren만 감싼다.
  const replace = sheet.replaceChildren;
  sheet.replaceChildren = function (...kids) { replace.apply(this, kids); onContent(); };
  seenHandle = handle();
  decorate();

  // ---- 끌기(터치). 내용 스크롤과 겹치지 않게: 손잡이 띠에서 시작했거나, 내용이 맨 위인데 아래로 끌 때만 시트를 움직인다
  const inGrabZone = (target, y) => {
    const h = handle();
    if (h && (h === target || h.contains(target))) return true;
    const top = sheet.getBoundingClientRect().top;
    return y - top < 44;
  };
  sheet.addEventListener("touchstart", e => {
    if (e.touches.length !== 1 || anim) { drag = null; return; }
    const t = e.touches[0];
    drag = { x0: t.clientX, y0: t.clientY, zone: inGrabZone(e.target, t.clientY), mode: null, h0: 0, lastY: t.clientY, lastT: e.timeStamp, v: 0 };
  }, { passive: true });
  sheet.addEventListener("touchmove", e => {
    if (!drag || e.touches.length !== 1) return;
    const t = e.touches[0], dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
    if (!drag.mode) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      const vertical = Math.abs(dy) > Math.abs(dx);
      const c = collapsed();
      if (!vertical) drag.mode = "none";
      else if (c) drag.mode = "sheet";                                   // 접힌 시트는 위아래 모두 시트를 움직인다
      else if (drag.zone) drag.mode = "sheet";
      else if (dy > 0 && sheet.scrollTop <= 0) drag.mode = "sheet";      // 맨 위에서 아래로 = 접기
      else drag.mode = "none";                                           // 그 밖은 내용 스크롤
      if (drag.mode === "sheet") {
        drag.cH = collapsedHeight();
        drag.eH = expandedHeight();
        drag.h0 = sheet.getBoundingClientRect().height;
        drag.y0 = t.clientY;
        sheet.classList.remove("collapsed");
        sheet.classList.add("sheet-dragging");
        sheet.style.height = `${drag.h0}px`;
      }
    }
    if (drag.mode !== "sheet") return;
    e.preventDefault();
    const raw = drag.h0 - (t.clientY - drag.y0);
    // 범위 밖으로는 조금만 따라온다(고무줄)
    const h = raw < drag.cH ? drag.cH - (drag.cH - raw) * 0.25 : raw > drag.eH ? drag.eH + (raw - drag.eH) * 0.15 : raw;
    sheet.style.height = `${Math.max(24, h)}px`;
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) { drag.v = (t.clientY - drag.lastY) / dt; drag.lastY = t.clientY; drag.lastT = e.timeStamp; }
  }, { passive: false });
  const endDrag = () => {
    const d = drag;
    drag = null;
    if (!d || d.mode !== "sheet") return;
    suppressClick = Date.now();
    const h = sheet.getBoundingClientRect().height, span = Math.max(1, d.eH - d.cH);
    const wasCollapsed = Math.abs(d.h0 - d.cH) < Math.abs(d.h0 - d.eH);
    let to;
    if (d.v > FLICK) to = true;
    else if (d.v < -FLICK) to = false;
    else if (wasCollapsed) to = (h - d.cH) / span < DECIDE;
    else to = (d.eH - h) / span > DECIDE;
    setCollapsed(to, { from: h });
  };
  sheet.addEventListener("touchend", endDrag);
  sheet.addEventListener("touchcancel", endDrag);

  // 마우스: 손잡이를 끌거나 누른다
  sheet.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const h = handle();
    if (!h || !(h === e.target || h.contains(e.target))) return;
    const y0 = e.clientY, h0 = sheet.getBoundingClientRect().height, cH = collapsedHeight(), eH = expandedHeight();
    let moved = false;
    const move = ev => {
      if (!moved && Math.abs(ev.clientY - y0) < SLOP) return;
      if (!moved) { moved = true; sheet.classList.remove("collapsed"); sheet.classList.add("sheet-dragging"); }
      sheet.style.height = `${Math.min(eH, Math.max(cH, h0 - (ev.clientY - y0)))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) return;
      suppressClick = Date.now();
      const hh = sheet.getBoundingClientRect().height;
      setCollapsed((hh - cH) / Math.max(1, eH - cH) < 0.5, { from: hh });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // 누르기: 손잡이는 접기/펼치기, 접힌 시트는 제목 줄 어디를 눌러도 펼친다(제목 줄의 버튼·링크는 그대로)
  sheet.addEventListener("click", e => {
    if (Date.now() - suppressClick < 400) { e.stopPropagation(); e.preventDefault(); return; }
    const h = handle();
    if (h && (h === e.target || h.contains(e.target))) { toggle(); return; }
    if (collapsed() && !e.target.closest("button, a, input, select, textarea, summary, label")) setCollapsed(false);
  }, true);
  sheet.addEventListener("keydown", e => {
    const h = handle();
    if (!h || e.target !== h) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowDown" && !collapsed()) { e.preventDefault(); setCollapsed(true); }
    else if (e.key === "ArrowUp" && collapsed()) { e.preventDefault(); setCollapsed(false); }
  });

  return { collapse: () => setCollapsed(true), expand: () => setCollapsed(false), toggle, get collapsed() { return collapsed(); } };
}
