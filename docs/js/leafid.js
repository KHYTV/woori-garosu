// 잎·나무 사진으로 수종 후보 고르기(AI, 브라우저 안에서만). 'AI로 알아보기'를 누를 때만 불러온다.
// CLIP 계열 제로샷: 그림 인코더(transformers.js, 버전 고정)로 사진 임베딩을 만들고,
// 전주 수종별 영어 문장(잎·나무·꽃·열매) 임베딩 평균(data/leafid.json, pipeline/leafid.mjs가 만듦)과 비교한다.
// 서버·키 없이 동작한다. data/backend.json에 plantnet_key가 있으면 Pl@ntNet API를 먼저 쓴다(선택, 기본은 없음).
const TJS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
// 그림 인코더 크기(MB, 양자화 q8) — 처음 한 번 받고 브라우저 캐시에 남는다
export const MODEL_MB = { "Xenova/mobileclip_s0": 12, "Xenova/clip-vit-base-patch32": 89, "Xenova/clip-vit-base-patch16": 88 };
let ready = null;

async function loadJSON(path) { const r = await fetch(path); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); }

// 모델 준비. onProgress({ loaded, total, pct, text })
export function loadLeafModel(onProgress = () => {}) {
  if (ready) return ready;
  ready = (async () => {
    const t0 = performance.now();
    const meta = await loadJSON("data/leafid.json");
    onProgress({ pct: 0, text: "AI 모듈을 불러오는 중…" });
    const T = await import(/* webpackIgnore: true */ TJS);
    T.env.allowLocalModels = false;
    const files = new Map();
    const progress_callback = e => {
      if (e.status !== "progress" || !e.total) return;
      files.set(e.file, { loaded: e.loaded, total: e.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      onProgress({ loaded, total, pct: Math.round(loaded / total * 100), text: `AI 모델 받는 중 ${Math.round(loaded / 1e6)}/${Math.round(total / 1e6)}MB` });
    };
    const [processor, vision] = await Promise.all([
      T.AutoProcessor.from_pretrained(meta.model, { progress_callback }),
      T.CLIPVisionModelWithProjection.from_pretrained(meta.model, { dtype: meta.dtype || "q8", device: "wasm", progress_callback }),
    ]);
    const loadMs = Math.round(performance.now() - t0);
    return { T, meta, processor, vision, loadMs };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

const norm = v => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Array.from(v, x => x / n); };

// 사진(Blob/File) → { top: [{species, p, score}], notTree, ms, model }
// candidates: 고를 수 있는 수종 이름 목록(전주 수종). p는 그 후보들 안에서의 상대 확신도(softmax)
export async function identifyLeaf(blob, { candidates = null, onProgress } = {}) {
  const m = await loadLeafModel(onProgress);
  const t0 = performance.now();
  const image = await m.T.RawImage.fromBlob(blob);
  // 가운데를 잘라 쓰는 전처리라 긴 사진은 양 끝도 따로 보고 평균한다(meta.tta)
  const views = [image];
  if (m.meta.tta && image.width !== image.height) {
    const side = Math.min(image.width, image.height);
    if (image.width > image.height) views.push(await image.crop([0, 0, side - 1, side - 1]), await image.crop([image.width - side, 0, image.width - 1, side - 1]));
    else views.push(await image.crop([0, 0, side - 1, side - 1]), await image.crop([0, image.height - side, side - 1, image.height - 1]));
  }
  const embs = [];
  for (const im of views) { const { image_embeds } = await m.vision(await m.processor(im)); embs.push(norm(image_embeds.tolist()[0])); }
  const v = norm(embs[0].map((_, k) => embs.reduce((a, e) => a + e[k], 0)));
  const dot = e => e.reduce((a, x, k) => a + x * v[k], 0);
  const classes = m.meta.classes.filter(c => !candidates || candidates.includes(c.species));
  const scale = m.meta.logit_scale || 100;
  // 전주 가로수 수종 비율을 약하게 사전확률로 섞는다(prior_strength, pipeline/leafid.mjs와 같은 식)
  const ps = m.meta.prior_strength || 0;
  const scores = classes.map(c => ({ species: c.species, score: dot(c.emb) + (ps && c.prior ? ps * Math.log(c.prior) / scale : 0) }));
  const max = Math.max(...scores.map(s => s.score));
  const exps = scores.map(s => Math.exp(scale * (s.score - max)));
  const sum = exps.reduce((a, b) => a + b, 0);
  const ranked = scores.map((s, k) => ({ ...s, p: exps[k] / sum })).sort((a, b) => b.p - a.p);
  const notTree = m.meta.other ? dot(m.meta.other) > Math.max(...classes.map(c => dot(c.emb))) : false;
  return { top: ranked.slice(0, 3), all: ranked, notTree, ms: Math.round(performance.now() - t0), loadMs: m.loadMs, model: m.meta.model };
}

// 확신도를 말로(정확도 측정 결과에 맞춰 보수적으로)
export function confidenceLabel(p) {
  if (p >= 0.6) return "가능성 높음";
  if (p >= 0.3) return "가능성 있음";
  return "가능성 낮음";
}

// (선택) Pl@ntNet API. backend.json에 plantnet_key가 있을 때만. 학명 → 전주 수종으로 맞춘다
export async function identifyPlantNet(blob, { key, S, organ = "auto" }) {
  const form = new FormData();
  form.append("images", blob, "tree.jpg");
  form.append("organs", organ);
  const r = await fetch(`https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(key)}&lang=ko&nb-results=10`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`Pl@ntNet ${r.status}`);
  const data = await r.json();
  const bySci = Object.entries(S.species_info).filter(([sp]) => sp !== "기타")
    .map(([sp, info]) => ({ sp, genus: info.scientific_name.split(" ")[0].toLowerCase(), sci: info.scientific_name.toLowerCase().replace(/ spp\.?$/, "") }));
  const out = new Map();
  for (const res of data.results || []) {
    const name = (res.species?.scientificNameWithoutAuthor || "").toLowerCase();
    const hit = bySci.find(b => name === b.sci) || bySci.find(b => name.startsWith(b.genus + " "));
    if (hit && !out.has(hit.sp)) out.set(hit.sp, { species: hit.sp, p: res.score, score: res.score });
  }
  return { top: [...out.values()].slice(0, 3), notTree: false, model: "Pl@ntNet" };
}
