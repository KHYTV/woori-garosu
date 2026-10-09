// 연구4 실험: 같은 나무 정보를 텍스트 / 이미지 / 몰입형 3D로 보여 주고 장소애착·행동의도를 묻는다.
// 세 조건 모두 같은 설명문을 보고, 이미지·몰입형은 같은 모형의 그림을 더 본다(정보량은 같고 표현 방식만 다름).
import { createTreeScene, treeFacts, SEASONS, MAX_YEARS } from "../js/tree3d.js";
import { mulberry32 } from "../js/carbon.js";
import { newPid, nextCondition, saveRecord } from "./records.js";

const app = document.getElementById("app");
const bar = document.getElementById("progressBar");
const params = new URLSearchParams(location.search);
const nf = (v, d = 0) => Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const kg = v => (Math.abs(v) < 10 ? nf(v, 1) : nf(Math.round(v / 10) * 10));
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const now = () => new Date().toISOString();

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
function josa(word, withFinal, withoutFinal) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code >= 11172) return word + withFinal;
  const fin = code % 28;
  if (withFinal === "으로" && fin === 8) return word + "로"; // ㄹ 받침은 '로'
  return word + (fin ? withFinal : withoutFinal);
}
const show = (...nodes) => { app.replaceChildren(...nodes); window.scrollTo(0, 0); };
const progress = (step, total) => { bar.style.width = `${Math.round(step / total * 100)}%`; };

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

let C, T, S, P, FORM, tree, facts, record, rand;

async function main() {
  try {
    [C, T, S, P, FORM] = await Promise.all([loadJSON("study.json"), loadJSON("../data/trees.json"),
      loadJSON("../data/summary.json"), loadJSON("../data/params.json"), loadJSON("../data/tree_form.json")]);
  } catch (e) {
    show(el("p", {}, "실험 자료를 불러오지 못했습니다. 연구자에게 알려 주세요."));
    throw e;
  }
  const i = T.id.indexOf(C.tree_id);
  if (i < 0) { show(el("p", {}, `실험 나무(${C.tree_id})를 찾지 못했습니다. study.json을 확인해 주세요.`)); return; }
  const species = T.species[T.sp[i]];
  const info = S.species_info[species];
  tree = {
    id: T.id[i], species, info, road: T.roads[T.rd[i]],
    model: { jenkins_group: info.jenkins_group, alt_group: info.alt_group, growth_class: info.growth_class,
      mature_height_class: info.mature_height_class, dbh: T.dbh[i], block: Boolean(T.block[i]) },
  };
  let same = 0;
  for (let k = 0; k < T.id.length; k++) if (T.rd[k] === T.rd[i] && T.sp[k] === T.sp[i]) same++;
  facts = { now: treeFacts(tree, P, FORM, 0), future: treeFacts(tree, P, FORM, MAX_YEARS), sameRoad: same };

  const forced = params.get("cond");
  const condition = C.conditions.includes(forced) ? forced : nextCondition(C.conditions);
  record = {
    pid: newPid(), study_id: C.study_id, condition, assignment: C.conditions.includes(forced) ? "forced" : "block-device",
    session: params.get("session") || "", status: "started", tree_id: tree.id, started_at: now(),
    device_w: window.innerWidth, device_h: window.innerHeight, touch: navigator.maxTouchPoints > 0,
    interactions: {}, answers: {}, recall_ok: {},
  };
  rand = mulberry32(parseInt(record.pid.slice(0, 6), 36) >>> 0);
  saveRecord(record);
  consentScreen();
}

// 1. 동의
function consentScreen() {
  progress(0, 1);
  const agree = el("input", { type: "checkbox", id: "agree" });
  const start = el("button", { type: "button", class: "btn", disabled: true }, "시작하기");
  agree.addEventListener("change", () => { start.disabled = !agree.checked; });
  start.addEventListener("click", () => {
    record.consent_at = now();
    saveRecord(record);
    stimulusScreen();
  });
  show(
    el("h1", {}, C.consent.title),
    el("div", { class: "consent" }, ...C.consent.paragraphs.map(p => el("p", {}, p))),
    el("label", { class: "check", for: "agree" }, agree, el("span", {}, C.consent.agree)),
    el("div", { class: "next-row" }, start));
}

// 2. 자극물: 공통 설명문 + 조건별 그림
function factParagraphs() {
  const { now: f0, future: f20, sameRoad } = facts;
  const info = tree.info, sp = tree.species;
  const evergreen = info.leaf_habit === "evergreen";
  const spring = sp === "벚나무" ? "분홍 꽃이 피고" : sp === "이팝나무" ? "흰 꽃이 피고" : "연두색 새잎이 돋고";
  const seasons = evergreen
    ? "사계절 내내 초록 잎을 달고 있습니다."
    : `봄에는 ${spring}, 여름에는 짙은 초록 잎이 무성하며, 가을에는 잎이 ${josa(info.autumn_color_name || "노란색", "으로", "로")} 물들고, 겨울에는 잎이 모두 떨어져 가지만 남습니다.`;
  return [
    `전주시 ${tree.road}에 서 있는 ${sp}입니다.` + (sameRoad > 2 ? ` 이 길에는 같은 ${sp} ${nf(sameRoad)}그루가 줄지어 서 있습니다.` : sameRoad === 2 ? ` 이 길에는 같은 ${josa(sp, "이", "가")} 한 그루 더 있습니다.` : ""),
    `줄기 지름(흉고)은 ${nf(f0.dbh)}cm이고, 높이는 약 ${nf(f0.h)}m, 가지와 잎이 퍼진 폭은 약 ${nf(f0.cw)}m로 추정됩니다.`,
    seasons,
    `이 나무는 지금까지 이산화탄소(CO₂)를 약 ${kg(f0.storage[0])}~${kg(f0.storage[2])}kg 저장한 것으로 추정되고, 해마다 약 ${kg(f0.seq[0])}~${kg(f0.seq[2])}kg을 흡수합니다.`,
    `지금처럼 자란다면 20년 뒤에는 높이 약 ${nf(f20.h)}m, 폭 약 ${nf(f20.cw)}m가 되고, 그동안 CO₂를 약 ${kg(f20.storage[1] - f0.storage[1])}kg 더 저장할 것으로 추정됩니다.`,
  ];
}

const SNAPSHOTS = [
  { season: "spring", years: 0, caption: "지금 · 봄" },
  { season: "summer", years: 0, caption: "지금 · 여름" },
  { season: "autumn", years: 0, caption: "지금 · 가을" },
  { season: "winter", years: 0, caption: "지금 · 겨울" },
  { season: "summer", years: MAX_YEARS, caption: `${MAX_YEARS}년 뒤 · 여름` },
];

async function stimulusScreen() {
  progress(1, C.sections.length + 2);
  const cond = record.condition;
  const next = el("button", { type: "button", class: "btn", disabled: true }, "다음");
  const visual = el("div", {});
  const minSec = Number(params.get("minsec")) || C.min_exposure_sec;
  const minText = minSec % 60 === 0 ? `${minSec / 60}분` : `${minSec}초`;
  const instr = [C.instructions.common.replace("{min_exposure}이", josa(minText, "이", "가")).replace("{min_exposure}", minText), C.instructions[cond]].filter(Boolean).join(" ");
  show(
    el("h1", {}, `${tree.road}의 ${tree.species}`),
    el("p", { class: "instruction" }, instr),
    visual,
    el("div", { class: "facts" }, ...factParagraphs().map(p => el("p", {}, p)),
      el("p", { class: "small" }, "크기와 탄소량은 공공데이터의 흉고를 바탕으로 한 추정값입니다." + (cond === "text" ? "" : " 그림 속 회색 사람 모형은 키 1.7m입니다."))),
    el("div", { class: "next-row" }, next));

  const ix = { n_rotate: 0, n_season_change: 0, seasons_viewed: [], n_year_change: 0, max_years: 0 };
  let scene = null;
  if (cond === "image") {
    visual.replaceChildren(el("p", { class: "loading" }, "그림을 준비하는 중입니다."));
    await new Promise(r => setTimeout(r, 30));
    const box = el("div", { style: "position:fixed;left:-10000px;top:0;width:720px;height:540px" });
    document.body.append(box);
    const shot = createTreeScene(box, { tree, P, form: FORM, token, interactive: false });
    const imgs = SNAPSHOTS.map(s => ({ ...s, url: shot.snapshot({ season: s.season, years: s.years }) }));
    shot.dispose();
    box.remove();
    visual.replaceChildren(el("div", { class: "gallery" },
      ...imgs.map(s => el("figure", {}, el("img", { src: s.url, alt: `${tree.species} ${s.caption} 모습(추정 모형)` }), el("figcaption", {}, s.caption)))));
  } else if (cond === "immersive") {
    const stage = el("div", { class: "stage3d" });
    const seasonSeg = el("div", { class: "seg", role: "group", "aria-label": "계절" },
      ...SEASONS.map(([key, label]) => el("button", { type: "button", "data-season": key, "aria-pressed": String(key === "summer") }, label)));
    const yearOut = el("output", { class: "num" }, "지금");
    const range = el("input", { type: "range", min: "0", max: String(MAX_YEARS), step: "1", value: "0", "aria-label": "몇 년 뒤 모습" });
    visual.replaceChildren(el("div", { class: "controls3d" }, stage, el("div", { class: "row" }, seasonSeg),
      el("label", { class: "range" }, el("span", {}, "시간"), range, yearOut)));
    scene = createTreeScene(stage, { tree, P, form: FORM, token, interactive: true });
    scene.setSeason("summer");
    ix.seasons_viewed.push("summer");
    scene.controls.addEventListener("start", () => { ix.n_rotate++; });
    seasonSeg.addEventListener("click", e => {
      const b = e.target.closest("button[data-season]");
      if (!b) return;
      for (const x of seasonSeg.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
      scene.setSeason(b.dataset.season);
      ix.n_season_change++;
      if (!ix.seasons_viewed.includes(b.dataset.season)) ix.seasons_viewed.push(b.dataset.season);
    });
    range.addEventListener("input", () => {
      const y = Number(range.value);
      yearOut.textContent = y ? `${y}년 뒤` : "지금";
      scene.setYears(y);
      ix.n_year_change++;
      ix.max_years = Math.max(ix.max_years, y);
    });
  }

  // 그림이 준비된 뒤부터 노출 시간을 잰다. 최소 시간이 지나야 '다음'이 열린다
  const t0 = performance.now();
  record.stimulus_start = now();
  saveRecord(record);
  // 시범 실행용으로 ?minsec= 로 줄일 수 있다(위에서 읽음). 실제 적용한 값은 기록에 남긴다
  record.min_exposure_sec = minSec;
  const minMs = minSec * 1000;
  const tick = setInterval(() => {
    const left = Math.ceil((minMs - (performance.now() - t0)) / 1000);
    if (left <= 0) { clearInterval(tick); next.disabled = false; next.textContent = "다음"; }
    else next.textContent = `다음 (${left}초 후)`;
  }, 250);
  next.addEventListener("click", () => {
    record.stimulus_ms = Math.round(performance.now() - t0);
    record.interactions = cond === "immersive" ? ix : {};
    if (scene) scene.dispose();
    saveRecord(record);
    const survey = params.get("survey") || C.external_survey_url;
    if (survey) {
      // 외부 설문으로 넘길 때는 참여 번호와 조건만 넘긴다(응답·개인정보는 주소에 넣지 않음)
      record.status = "handoff";
      saveRecord(record);
      const u = new URL(survey);
      u.searchParams.set("pid", record.pid);
      u.searchParams.set("cond", record.condition);
      location.href = u.toString();
      return;
    }
    sectionScreen(0);
  });
}

// 3. 설문
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function recallOptions(item) {
  const { now: f0, future: f20 } = facts;
  const info = tree.info;
  const uniq = arr => [...new Set(arr)];
  let correct, wrong;
  if (item.fact === "species") {
    correct = tree.species;
    wrong = ["은행나무", "벚나무", "이팝나무", "느티나무", "메타세쿼이아", "회화나무"].filter(s => s !== correct).slice(0, 3);
  } else if (item.fact === "autumn") {
    const name = info.leaf_habit === "evergreen" ? null : info.autumn_color_name;
    correct = name ? `${josa(name, "으로", "로")} 물든다` : "사계절 초록 잎을 유지한다";
    wrong = uniq(["노란색으로 물든다", "붉은색으로 물든다", "적갈색으로 물든다", "사계절 초록 잎을 유지한다"]).filter(o => o !== correct).slice(0, 3);
  } else if (item.fact === "storage") {
    const fmt = (a, b) => `약 ${kg(a)}~${kg(b)}kg`;
    correct = fmt(f0.storage[0], f0.storage[2]);
    wrong = [0.1, 0.3, 4].map(m => fmt(f0.storage[0] * m, f0.storage[2] * m));
  } else if (item.fact === "height20") {
    const h = Math.round(f20.h);
    correct = `약 ${h}m`;
    wrong = uniq([0.45, 1.6, 2.3].map(m => Math.max(2, Math.round(h * m)))).filter(v => v !== h).map(v => `약 ${v}m`);
  }
  return { correct, options: shuffle(uniq([correct, ...wrong])) };
}

function sectionScreen(si) {
  const total = C.sections.length + 2;
  progress(si + 2, total);
  const sec = C.sections[si];
  const next = el("button", { type: "button", class: "btn", disabled: true }, si === C.sections.length - 1 ? "제출" : "다음");
  const fields = [];
  const keys = {};
  const items = sec.items;
  for (const it of items) {
    let field;
    if (sec.kind === "likert") {
      field = el("fieldset", { class: "item" }, el("legend", {}, it.text),
        el("div", { class: "scale" }, ...C.likert_anchors.map((a, k) =>
          el("label", { title: a }, el("input", { type: "radio", name: it.id, value: String(k + 1), "aria-label": `${k + 1} ${a}` }), String(k + 1)))),
        el("div", { class: "anchors" }, el("span", {}, C.likert_anchors[0]), el("span", {}, C.likert_anchors[C.likert_anchors.length - 1])));
    } else {
      let opts = it.options;
      if (sec.kind === "recall") { const r = recallOptions(it); opts = r.options; keys[it.id] = r.correct; }
      field = el("fieldset", { class: "item" }, el("legend", {}, it.text),
        el("div", { class: "options" }, ...opts.map(o => el("label", {}, el("input", { type: "radio", name: it.id, value: o }), o))));
    }
    fields.push(field);
  }
  const form = el("form", { "aria-label": sec.title }, ...fields);
  form.addEventListener("change", () => {
    next.disabled = !items.every(it => form.querySelector(`input[name="${it.id}"]:checked`));
  });
  form.addEventListener("submit", e => e.preventDefault());
  next.addEventListener("click", () => {
    for (const it of items) {
      const v = form.querySelector(`input[name="${it.id}"]:checked`).value;
      record.answers[it.id] = sec.kind === "likert" ? Number(v) : v;
      if (sec.kind === "recall") record.recall_ok[`${it.id}_ok`] = v === keys[it.id];
    }
    record.status = `section-${sec.id}`;
    saveRecord(record);
    if (si + 1 < C.sections.length) sectionScreen(si + 1); else doneScreen();
  });
  show(el("h2", {}, sec.title), form, el("div", { class: "next-row" }, el("span", { class: "hint" }, `${si + 1} / ${C.sections.length}`), next));
}

// 4. 완료
function doneScreen() {
  progress(1, 1);
  const attention = C.sections.flatMap(s => s.items).filter(it => it.attention !== undefined);
  record.attention_ok = attention.every(it => record.answers[it.id] === it.attention);
  record.recall_score = Object.values(record.recall_ok).filter(Boolean).length;
  record.completed_at = now();
  record.status = "complete";
  const saved = saveRecord(record);
  show(el("div", { class: "done" },
    el("h1", {}, "참여해 주셔서 감사합니다"),
    el("p", {}, "아래 참여 번호를 연구자에게 알려 주세요."),
    el("div", { class: "code" }, record.pid),
    saved ? null : el("p", { class: "hint" }, "이 브라우저에서는 응답을 저장하지 못했습니다. 연구자에게 알려 주세요.")));
}

main();
