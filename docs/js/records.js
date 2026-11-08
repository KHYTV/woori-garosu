// 기록 도우미: 나무 메모(관찰 일기), 생활 실천 사진 인증, 감축량 '추정' 표시와 도움말.
// 저장은 모두 기기(IndexedDB wg-sns의 posts)에만 한다. 판 번호·저장소는 그대로이고,
//  - 메모는 posts에 kind "memo"로 들어간다(activity 없음, 점수·감축 0). 서버로 보내지 않는다(syncable).
//  - 실천 사진 인증은 kind "practice" 게시물에 photo Blob이 붙은 것이다. 점수는 사진이 있든 없든 같다(서버 activity_catalog와 같게).
//  - 나무 사진 모음(#photo)에는 돌봄(사진 관찰·AR) 사진만 보인다(treePhotos).
import { db, compressImage } from "./db.js";
import { photoField } from "./camera.js";

export const MEMO = { kind: "memo", label: "메모", icon: "📝" };
export const MEMO_MAX = 1000;
export const isMemo = p => p?.kind === "memo";
// 서버로 보낼 수 있는 기록: 활동 종류가 있는 돌봄·실천만(메모·사진·글은 보내지 않는다)
export const syncable = p => !isMemo(p) && typeof p?.activity === "string" && p.activity !== "";
// '사진과 캐릭터' 화면의 나무 사진: 돌봄 기록 사진만(실천 인증·메모 사진은 섞지 않는다)
export const treePhotos = posts => posts.filter(p => p.photo && p.kind === "care");
export const isProof = p => p?.kind === "practice" && Boolean(p.photo);
export const proofCount = posts => posts.filter(isProof).length;
export function newMemo(treeId, { text = "", photo = null } = {}, now = new Date()) {
  return { treeId, t: now.toISOString(), kind: MEMO.kind, label: MEMO.label, icon: MEMO.icon, points: 0, kg: 0, text: text.trim(), photo: photo || null };
}

// 감축량 표시: 값 뒤에 늘 '(추정)'을 붙인다
export const EST = "추정";
export const cutText = (massText, v) => `−${massText(v)} (${EST})`;

// ---------- 감축량 추정 도움말 ----------
export const ESTIMATE_SEEN = "estimate-explained";

export function estimateBody(h) {
  const { el, ACT, massText } = h;
  const tr = ACT?.practice?.find(a => a.id === "transit");
  return el("div", { class: "dialog-body est-help" },
    el("p", { class: "est-lead" }, "실제로 잰 값이 아니라, 흔히 인용되는 평균 계수로 환산한 추정치예요."),
    el("p", {}, tr && massText ? `예를 들어 대중교통 1회는 승용차로 갈 약 10km를 버스로 갔다고 보고 약 ${massText(tr.kg)}으로 셈해요. 실제로 줄어든 양은 거리·차종·승객 수에 따라 달라요.`
      : "실제로 줄어든 양은 거리·차종·승객 수 같은 상황에 따라 달라요."),
    el("dl", { class: "est-compare" },
      el("dt", {}, "🌳 나무 흡수량"),
      el("dd", {}, "산림청 가로수 자료(줄기 지름·수종)로 나무가 한 해 들이마시는 CO₂를 계산한 추정 범위예요. 나무가 하는 일이에요."),
      el("dt", {}, "🌱 내 실천 감축"),
      el("dd", {}, "내 실천 한 번을 평균적인 경우로 가정해 환산한 추정치예요. 계수는 공식 자료로 확인하기 전(검증 전)이에요."),
      el("dt", {}, "📊 80% 범위"),
      el("dd", {}, "불확실한 값을 바꿔 가며 여러 번 계산했을 때, 결과 10개 중 8개가 들어가는 구간이에요.")),
    el("p", { class: "hint" }, "두 숫자는 성격이 달라 서로 더하지 않아요. 사진 인증을 해도 점수·감축량은 같아요."));
}
export function explainEstimate(h) {
  return h.dialog("감축량은 추정치예요", estimateBody(h), { confirm: "알겠어요", cancel: null, onConfirm: () => {} });
}
// 처음 생활 실천을 기록했을 때 한 번만 보여 준다. 보여 줬으면 true
export async function explainOnce(h) {
  if (await db.getMeta(ESTIMATE_SEEN)) return false;
  await db.setMeta(ESTIMATE_SEEN, new Date().toISOString());
  explainEstimate(h);
  return true;
}
export function infoButton(h, label = "추정이란?") {
  return h.el("button", { type: "button", class: "est-info", "aria-label": "감축량이 추정치인 이유 보기", onclick: () => explainEstimate(h) }, "ⓘ ", label);
}

// ---------- 메모(관찰 일기) ----------
// post가 있으면 고치기. onDone()은 저장·삭제 뒤 화면을 다시 그린다
export function openMemo(h, t, post = null, onDone = () => {}) {
  const { el, dialog, toast } = h;
  const text = el("textarea", { name: "text", maxlength: String(MEMO_MAX), rows: "5", placeholder: "오늘 본 것, 느낀 것을 자유롭게 적어요. (예: 새잎이 났어요, 줄기에 상처가 보여요)", "aria-label": "메모" });
  text.value = post?.text || "";
  const photo = photoField({ label: "사진", compress: f => compressImage(f), toast, hint: "남기고 싶은 모습에 맞추고 가운데 버튼을 눌러요." });
  if (post?.photo) photo.set(post.photo);
  dialog(post ? "메모 고치기" : `📝 ${t.name} 메모`, el("div", { class: "dialog-body" },
    el("p", { class: "hint" }, "점수와 상관없는 관찰 일기예요. 이 기기에만 저장되고 서버로 보내지 않아요."),
    text, photo.node,
    post ? el("button", { type: "button", class: "btn ghost small danger memo-del", onclick: e => { e.target.closest("dialog")?.close(); deleteMemo(h, post, onDone); } }, "이 메모 지우기") : null), {
    confirm: post ? "저장" : "메모 남기기",
    onConfirm: async () => {
      const body = text.value.trim();
      if (!body && !photo.blob) { toast("메모를 쓰거나 사진을 붙여 주세요.", true); return false; }
      if (post) {
        Object.assign(post, { text: body, photo: photo.blob || null, edited: new Date().toISOString() });
        await db.putPost(post);
        toast("메모를 고쳤어요");
      } else {
        await db.addPost(newMemo(t.id, { text: body, photo: photo.blob }));
        toast("메모를 남겼어요 · 이 기기에만 저장돼요");
      }
      await onDone();
    },
  });
  setTimeout(() => text.focus(), 50);
}
export function deleteMemo(h, post, onDone = () => {}) {
  const { el, dialog, toast } = h;
  dialog("메모를 지울까요?", el("p", { class: "dialog-body" }, "지운 메모와 사진은 되돌릴 수 없어요."), {
    confirm: "지우기",
    onConfirm: async () => {
      await db.deletePost(post.pid);
      toast("메모를 지웠어요");
      await onDone();
    },
  });
}
