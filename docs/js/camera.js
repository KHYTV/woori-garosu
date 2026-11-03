// 사진 '바로 찍기': 앱 안에서 카메라를 열어 셔터로 찍고, 미리 본 뒤 올린다.
// 카메라를 못 쓰면(권한 거부·지원 안 함·http) 기기 카메라 앱(capture)이나 앨범으로 넘어간다.
// 활동 기록 대화상자(<dialog> 모달) 위에서도 보이도록 카메라 화면도 <dialog>의 showModal로 띄운다.

let stream = null;

export function cameraSupported() {
  return !!(navigator.mediaDevices?.getUserMedia) && window.isSecureContext !== false;
}

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

function stopStream() {
  for (const t of stream?.getTracks() || []) t.stop();
  stream = null;
}

// 파일 고르기(앨범) 또는 기기 카메라 앱(capture). 고르지 않고 닫으면 null(cancel 이벤트를 아는 브라우저)
export function pickFile({ capture = false } = {}) {
  return new Promise(resolve => {
    const input = h("input", { type: "file", accept: "image/*", capture: capture ? "environment" : false, hidden: true });
    let done = false;
    const finish = v => { if (done) return; done = true; input.remove(); resolve(v); };
    input.addEventListener("change", () => finish(input.files?.[0] || null));
    input.addEventListener("cancel", () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** 앱 안 카메라로 한 장 찍는다. 찍어서 '이 사진 쓰기'를 누르면 Blob(JPEG), 그만두면 null. */
export function takePhoto({ title = "사진 찍기", hint = "" } = {}) {
  if (!cameraSupported()) return pickFile({ capture: true });
  return new Promise(resolve => {
    let result = null, facing = "environment", shot = null;
    const video = h("video", { class: "cam-video", playsinline: true, muted: true, autoplay: true });
    video.muted = true;
    const still = h("img", { class: "cam-still", alt: "찍은 사진 미리 보기", hidden: true });
    const status = h("p", { class: "cam-status" }, "카메라를 여는 중…");
    const shutter = h("button", { type: "button", class: "cam-shutter", "aria-label": "찍기", disabled: true, onclick: snap });
    const flip = h("button", { type: "button", class: "cam-side", "aria-label": "앞뒤 카메라 바꾸기", hidden: true, onclick: () => { facing = facing === "environment" ? "user" : "environment"; start(); } }, "🔄");
    const album = h("button", { type: "button", class: "cam-side", "aria-label": "앨범에서 고르기", onclick: fromFile(false) }, "🖼️");
    const shootRow = h("div", { class: "cam-row" }, album, shutter, flip);
    const retake = h("button", { type: "button", class: "btn ghost big", onclick: () => { shot = null; still.hidden = true; video.hidden = false; reviewRow.hidden = true; shootRow.hidden = false; status.textContent = hint || "나무에 맞추고 가운데 버튼을 눌러요."; } }, "다시 찍기");
    const use = h("button", { type: "button", class: "btn big", onclick: () => { result = shot; d.close(); } }, "이 사진 쓰기");
    const reviewRow = h("div", { class: "cam-row review", hidden: true }, retake, use);
    const fallback = h("div", { class: "cam-row fallback", hidden: true },
      h("button", { type: "button", class: "btn big", onclick: fromFile(true) }, "📷 기기 카메라로 찍기"),
      h("button", { type: "button", class: "btn ghost big", onclick: fromFile(false) }, "🖼️ 앨범에서 고르기"));
    const d = h("dialog", { class: "cam-dialog", "aria-label": title },
      h("div", { class: "cam-top" }, h("button", { type: "button", class: "cam-close", "aria-label": "닫기", onclick: () => d.close() }, "✕"), h("b", {}, title)),
      h("div", { class: "cam-stage" }, video, still),
      h("div", { class: "cam-bottom" }, status, shootRow, reviewRow, fallback));
    d.addEventListener("close", () => { stopStream(); d.remove(); resolve(result); });
    document.body.append(d);
    d.showModal();
    start();

    async function start() {
      stopStream();
      shutter.disabled = true;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false });
        if (!d.open) { stopStream(); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        shutter.disabled = false;
        status.textContent = hint || "나무에 맞추고 가운데 버튼을 눌러요.";
        const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(x => x.kind === "videoinput");
        flip.hidden = cams.length < 2;
      } catch (err) {
        video.hidden = true; shootRow.hidden = true; fallback.hidden = false;
        status.textContent = err?.name === "NotAllowedError"
          ? "카메라 권한이 꺼져 있어요. 기기 카메라로 찍거나 앨범에서 골라 주세요."
          : "이 기기에서는 앱 안 카메라를 열 수 없어요. 기기 카메라로 찍거나 앨범에서 골라 주세요.";
      }
    }
    function snap() {
      const w = video.videoWidth, hgt = video.videoHeight;
      if (!w || !hgt) { status.textContent = "아직 화면이 준비되지 않았어요. 잠시 뒤 다시 눌러요."; return; }
      const c = document.createElement("canvas");
      const k = Math.min(1, 2048 / Math.max(w, hgt));
      c.width = Math.round(w * k); c.height = Math.round(hgt * k);
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      c.toBlob(b => {
        if (!b) { status.textContent = "사진을 만들지 못했어요. 다시 눌러 주세요."; return; }
        shot = b;
        if (still.src) URL.revokeObjectURL(still.src);
        still.src = URL.createObjectURL(b);
        still.hidden = false; video.hidden = true; shootRow.hidden = true; reviewRow.hidden = false;
        status.textContent = "이 사진으로 올릴까요?";
      }, "image/jpeg", 0.9);
    }
    function fromFile(capture) {
      return async () => {
        const f = await pickFile({ capture });
        if (!f) return;
        result = f; d.close();
      };
    }
  });
}

/**
 * 사진 입력 칸: [📷 바로 찍기] [🖼️ 앨범에서] + 미리 보기·지우기.
 * compress(file) → Blob 으로 줄여 담고, field.blob 으로 꺼낸다. onChange(blob|null)
 */
export function photoField({ label = "사진", required = false, compress = f => f, onChange = () => {}, toast = () => {}, hint = "" } = {}) {
  const field = { blob: null };
  const preview = h("div", { class: "photo-preview", hidden: true });
  const set = blob => {
    field.blob = blob;
    if (blob) {
      const img = h("img", { src: URL.createObjectURL(blob), alt: "올릴 사진" });
      preview.replaceChildren(img, h("button", { type: "button", class: "photo-clear", "aria-label": "사진 빼기", onclick: () => set(null) }, "✕"));
      preview.hidden = false;
    } else { preview.replaceChildren(); preview.hidden = true; }
    onChange(blob);
  };
  const take = async file => {
    if (!file) return;
    try { set(await compress(file)); } catch (e) { toast(e.message, true); }
  };
  field.node = h("div", { class: "photo-field" },
    h("span", { class: "photo-label" }, `${label} ${required ? "(필수)" : "(선택)"}`),
    h("div", { class: "photo-buttons" },
      h("button", { type: "button", class: "btn", onclick: async () => take(await takePhoto({ title: label, hint })) }, "📷 바로 찍기"),
      h("button", { type: "button", class: "btn ghost", onclick: async () => take(await pickFile()) }, "🖼️ 앨범에서")),
    preview);
  field.set = set;
  return field;
}
