// 내 프로필(#profile): 생활 실천 기록, 내 실천 기록·누적 감축량, 점수·레벨 요약, 닉네임·온라인 참여와 동네 순위.
// 저장 형식과 서버 스키마는 그대로다. 생활 실천도 지금처럼 친구 나무 한 그루에 붙는 활동
// (post.treeId, kind "practice" → 서버 activities.tree_id)으로 저장·전송한다. 그래서 기록할 때 어느 나무와 함께할지 고르고,
// 기본값은 #profile?tree=<id>로 넘어온 나무 → 지난번에 고른 나무 → 처음 친구 맺은 나무 순이다.
// 화면에 쓰는 도우미(el, kpi, postCard, saveActivity, onlineCard …)는 home.js가 넘겨준다.
// 실천 사진 인증(선택)은 게시물에 사진 Blob을 붙여 기기에만 둔다. 점수·서버 전송 값은 사진이 있든 없든 같다.
import { db, compressImage } from "./db.js";
import { photoField } from "./camera.js";
import { proofCount, cutText, infoButton, explainOnce } from "./records.js";

const PICK_KEY = "practice-tree";
const SHOW = 20;

export async function renderProfileScreen(box, h) {
  const { state, ACT, el, nf, mass, massText, kpi, levelOf, postCard, onlineCard } = h;
  const my = state.my;
  const ids = new Set(my.map(t => t.id));
  const practice = state.posts.filter(p => p.kind === "practice" && ids.has(p.treeId));
  const sumKg = rows => rows.reduce((a, p) => a + (p.kg || 0), 0);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const month = practice.filter(p => new Date(p.t) >= monthStart);
  const points = my.reduce((a, t) => a + (t.points || 0), 0);
  const lv = levelOf(points);
  const online = h.cloudOn();
  const nick = online ? state.profile.nickname : null;

  const head = el("header", { class: "screen-head profile-me" },
    el("span", { class: "me-avatar", "aria-hidden": "true" }, nick ? [...nick][0] : "나"),
    el("div", { class: "me-txt" }, el("p", { class: "eyebrow" }, "내 프로필"),
      el("h1", {}, nick || "나의 실천"),
      el("p", { class: "sub" }, online ? `온라인 참여 중${state.profile.dong ? " · " + state.profile.dong : ""}` : `친구 나무 ${my.length}그루 · 기록은 이 기기에 저장돼요`)));

  const levelCard = el("section", { class: "card level-card" },
    el("div", { class: "row between" }, el("div", {}, el("span", { class: "k" }, "내 레벨 "), el("b", { class: "level-name" }, lv.name)), el("b", { class: "num" }, `${nf(points)}점`)),
    levelBar(el, points, ACT.levels),
    el("p", { class: "limit" }, lv.next ? `다음 레벨까지 ${nf(lv.next)}점 · 친구 나무 돌봄과 생활 실천 점수를 더했어요.` : "가장 높은 레벨이에요."));

  const kpis = el("div", { class: "kpis tight" },
    kpi("내 생활 실천 감축(추정)", ...mass(sumKg(practice)), `실천 ${nf(practice.length)}회를 평균 계수로 환산`),
    kpi("이번 달 감축(추정)", ...mass(sumKg(month)), `${monthStart.getMonth() + 1}월 실천 ${nf(month.length)}회`));
  const proofs = proofCount(practice);

  const recordCard = el("section", { class: "card practice-card", id: "practice" }, el("div", { class: "k" }, "생활 실천 기록하기"));
  if (!my.length) {
    recordCard.append(
      el("p", { class: "limit" }, "생활 실천은 친구 나무와 함께 기록돼요. 우리 동네 가로수와 친구를 맺으면 여기서 바로 기록할 수 있어요."),
      el("div", { class: "row" }, el("a", { class: "btn small", href: "#map" }, "우리동네 나무 찾기")));
  } else {
    recordCard.append(
      el("p", { class: "limit" }, "오늘 한 실천을 눌러 기록해요. 사진으로 인증할 수도 있어요(선택). 감축량은 평균 계수로 환산한 추정치예요. ", infoButton(h.records)),
      el("div", { class: "act-list practice-grid" }, ...ACT.practice.map(a => el("button", { type: "button", class: "act", "data-id": a.id, onclick: () => openPractice(h, a) },
        el("span", { class: "act-icon" }, a.icon), el("span", { class: "act-label" }, a.label), el("span", { class: "act-sub" }, actSub(a, massText))))));
  }

  // 활동별 횟수 요약
  const byAct = new Map();
  for (const p of practice) byAct.set(p.activity, { icon: p.icon, label: p.label, n: (byAct.get(p.activity)?.n || 0) + 1 });
  const tally = byAct.size ? el("div", { class: "tally" }, ...[...byAct.values()].sort((a, b) => b.n - a.n).map(v => el("span", { class: "chip" }, `${v.icon} ${v.label} ${v.n}회`))) : null;
  const feed = el("div", { class: "feed" }, ...(practice.length ? practice.slice(0, SHOW).map(postCard)
    : [el("p", { class: "empty" }, my.length ? "아직 실천 기록이 없어요. 위에서 오늘 한 실천을 눌러 보세요." : "아직 실천 기록이 없어요.")]));

  box.replaceChildren(el("div", { class: "page-inner" },
    head, levelCard, kpis, recordCard,
    el("h2", { id: "online" }, "온라인 · 동네 순위"), onlineCard(),
    el("h2", {}, `내 실천 기록 ${nf(practice.length)}건`),
    practice.length ? el("p", { class: "proof-sum" }, el("span", { class: "badge proof" }, `📷 인증 ${nf(proofs)}건`), el("span", {}, `사진 없이 ${nf(practice.length - proofs)}건 · 인증해도 점수는 같아요`)) : null,
    tally, feed,
    practice.length > SHOW ? el("p", { class: "small" }, `최근 ${SHOW}건만 보여요.`) : null));
}

const actSub = (a, massText) => `+${a.points}점${a.kg ? ` · −${massText(a.kg)}/${a.per} (추정)` : a.kg === null ? " · 점수만" : ""}`;

// 레벨 구간 안에서 얼마나 왔는지
function levelBar(el, points, levels) {
  let cur = levels[0];
  for (const l of levels) if (points >= l.min) cur = l;
  const next = levels.find(l => l.min > points);
  const pct = next ? Math.round(((points - cur.min) / (next.min - cur.min)) * 100) : 100;
  return el("div", { class: "level-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": "다음 레벨까지 진행" },
    el("span", { style: `width:${pct}%` }));
}

async function defaultTree(my) {
  const asked = new URLSearchParams(location.hash.split("?")[1] || "").get("tree");
  if (asked && my.some(t => t.id === asked)) return asked;
  const last = await db.getMeta(PICK_KEY);
  if (last && my.some(t => t.id === last)) return last;
  // state.my는 최근에 친구 맺은 순이라, 맨 끝이 처음 친구 맺은 나무
  return my[my.length - 1].id;
}

// 고른 실천 한 가지를 어느 친구 나무와 함께 기록할지 묻는다
async function openPractice(h, picked) {
  const { state, ACT, el, dialog, toast, avatar, massText, saveActivity } = h;
  const my = state.my;
  if (!my.length) return;
  let treeId = await defaultTree(my);
  const today = new Date().toDateString();
  const usedToday = id => state.posts.filter(p => p.treeId === id && p.activity === picked.id && new Date(p.t).toDateString() === today).length;
  const trees = el("div", { class: "tree-pick", role: "radiogroup", "aria-label": "함께 기록할 친구 나무" });
  const renderTrees = () => {
    trees.replaceChildren(...my.map(t => el("button", { type: "button", class: "pick", role: "radio", "aria-checked": String(t.id === treeId), onclick: () => { treeId = t.id; renderTrees(); } },
      avatar(t, { size: 32 }), el("span", { class: "pick-txt" }, el("b", {}, t.name), el("small", {}, t.road)))));
  };
  renderTrees();
  // 사진 인증(선택): 바로 찍기·앨범. 사진은 기기에만, 나무 사진 모음에는 섞이지 않는다
  const proof = photoField({ label: "📷 인증 사진", compress: f => compressImage(f), toast, hint: "버스 안, 텀블러처럼 실천이 보이게 찍어요." });
  dialog(`${picked.icon} ${picked.label}`, el("div", { class: "dialog-body" },
    el("p", { class: "act-sum" }, actSub(picked, massText)),
    picked.basis ? el("p", { class: "hint" }, `환산 근거: ${picked.basis}`) : null,
    el("div", { class: "pick-head" }, el("b", {}, "함께 기록할 친구 나무"), my.length > 1 ? el("span", { class: "hint" }, "점수는 고른 나무에 쌓여요") : null),
    trees,
    proof.node,
    el("p", { class: "hint" }, "인증하면 기록에 '📷 인증'이 붙어요. 점수는 같고, 사진은 이 기기에만 저장돼요."),
    el("textarea", { name: "text", maxlength: "200", placeholder: "한마디 (선택)" })), {
    confirm: "기록하기",
    onConfirm: async form => {
      const t = my.find(x => x.id === treeId);
      if (!t) return false;
      if (my.length > 1 && usedToday(t.id) >= ACT.daily_limit_per_tree) {
        toast(`${t.name}에는 오늘 '${picked.label}'을(를) 다 기록했어요. 다른 나무를 골라 주세요.`, true);
        return false;
      }
      const post = await saveActivity(t, "practice", picked, { photo: proof.blob, text: (form.text.value || "").trim() });
      if (!post) return false;
      await db.setMeta(PICK_KEY, t.id);
      toast(`기록했어요 · +${picked.points}점${picked.kg ? ` · ${cutText(massText, picked.kg)}` : ""}${proof.blob ? " · 📷 인증" : ""}`);
      await h.rerender();
      // 처음 기록했을 때 한 번: 감축량이 추정치라는 설명(기록 대화상자가 닫힌 뒤)
      setTimeout(() => explainOnce(h.records), 0);
      // 서버 전송은 saveActivity가 따로 보내므로, 조금 뒤 순위를 한 번 더 읽는다
      if (h.cloudOn()) setTimeout(() => { const rb = document.querySelector("#s-profile #rankBox"); if (rb) h.loadRankings(rb); }, 1500);
    },
  });
}
