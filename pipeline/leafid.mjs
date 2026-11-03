// 잎 사진 수종 인식(docs/js/leafid.js)용 수종 문장 임베딩을 만들고, 사진 묶음으로 정확도를 잰다.
// 브라우저는 이 파일이 만든 docs/data/leafid.json(수종별 평균 문장 임베딩)과 그림 인코더만 받는다.
//
//   npm i --prefix <작업 폴더> @huggingface/transformers@4.3.1
//   TRANSFORMERS_JS=<작업 폴더>/node_modules/@huggingface/transformers/dist/transformers.node.mjs \
//     node pipeline/leafid.mjs                       # docs/data/leafid.json 다시 만들기
//     node pipeline/leafid.mjs --eval <사진 폴더>     # <사진 폴더>/manifest.json [{species, kind, file}]로 top-1·top-3
//     node pipeline/leafid.mjs --model Xenova/clip-vit-base-patch32 --eval <사진 폴더> --no-write
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const k = args.indexOf(name); return k >= 0 ? args[k + 1] : fallback; };
const MODEL = opt("--model", "Xenova/mobileclip_s0");
const DTYPE = opt("--dtype", "q8");          // 브라우저와 같은 그림 인코더 정밀도
const EVAL = opt("--eval");
const PRIOR = Number(opt("--prior", "0.5"));  // 전주 수종 비율을 사전확률로 섞는 세기(0 = 안 씀)
const TTA = args.includes("--tta");            // 가운데·양 끝 잘라 낸 그림 3장 평균
const WRITE = !args.includes("--no-write");
const root = new URL("../", import.meta.url);
const lib = process.env.TRANSFORMERS_JS ? pathToFileURL(process.env.TRANSFORMERS_JS).href : "@huggingface/transformers";
const { AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, AutoProcessor, RawImage } = await import(lib);

// 수종별 영어 이름과 생김새. 문장 여러 개(잎·나무·꽃·열매)를 평균한다
const SPECIES = {
  "은행나무": { en: "ginkgo", sci: "Ginkgo biloba", leaf: "fan-shaped leaves", extra: ["a photo of yellow ginkgo leaves in autumn."] },
  "벚나무": { en: "Japanese cherry tree", sci: "Prunus serrulata", leaf: "oval serrated leaves", flower: "pink cherry blossoms", fruit: "small dark cherries" },
  "느티나무": { en: "Japanese zelkova", sci: "Zelkova serrata", leaf: "small oval leaves with serrated edges", extra: ["a photo of a large spreading zelkova tree with a vase-shaped crown."] },
  "이팝나무": { en: "Chinese fringe tree", sci: "Chionanthus retusus", leaf: "smooth oval leaves", flower: "fluffy white fringe flowers covering the tree" },
  "단풍나무": { en: "Japanese maple", sci: "Acer palmatum", leaf: "deeply lobed palmate leaves", extra: ["a photo of red Japanese maple leaves in autumn."] },
  "중국단풍": { en: "trident maple", sci: "Acer buergerianum", leaf: "three-lobed leaves" },
  "양버즘나무": { en: "American sycamore plane tree", sci: "Platanus occidentalis", leaf: "large maple-like lobed leaves", fruit: "round hanging seed balls", extra: ["a photo of the mottled peeling bark of a plane tree."] },
  "메타세쿼이아": { en: "dawn redwood", sci: "Metasequoia glyptostroboides", leaf: "soft feathery flat needles", extra: ["a photo of a tall conical dawn redwood tree."] },
  "회화나무": { en: "Japanese pagoda tree", sci: "Styphnolobium japonicum", leaf: "pinnate compound leaves with small leaflets", flower: "creamy white pea-like flowers" },
  "히말라야시다": { en: "deodar cedar", sci: "Cedrus deodara", leaf: "clusters of short blue-green needles", extra: ["a photo of a deodar cedar with drooping branch tips."] },
  "팽나무": { en: "Chinese hackberry", sci: "Celtis sinensis", leaf: "asymmetric oval leaves", fruit: "small orange berries" },
  "소나무": { en: "Korean red pine", sci: "Pinus densiflora", leaf: "long paired pine needles", fruit: "pine cones", extra: ["a photo of the reddish bark of a red pine."] },
  "버드나무": { en: "willow", sci: "Salix", leaf: "long narrow leaves on drooping branches" },
  "감나무": { en: "persimmon tree", sci: "Diospyros kaki", leaf: "glossy broad oval leaves", fruit: "orange persimmons" },
  "참나무": { en: "oak", sci: "Quercus", leaf: "lobed or toothed oak leaves", fruit: "acorns" },
  "삼나무": { en: "Japanese cedar", sci: "Cryptomeria japonica", leaf: "short awl-shaped needles" },
  "아까시나무": { en: "black locust", sci: "Robinia pseudoacacia", leaf: "pinnate leaves with round leaflets", flower: "hanging white flower clusters" },
  "잎갈나무": { en: "larch", sci: "Larix", leaf: "soft needles in tufts", fruit: "small cones" },
  "모감주나무": { en: "golden rain tree", sci: "Koelreuteria paniculata", leaf: "pinnate toothed leaves", flower: "yellow flower panicles", fruit: "papery lantern-shaped seed pods" },
  "향나무": { en: "Chinese juniper", sci: "Juniperus chinensis", leaf: "scale-like evergreen foliage" },
  "목련": { en: "magnolia", sci: "Magnolia", leaf: "large smooth oval leaves", flower: "large white magnolia flowers" },
};
// 나무가 아닌 사진을 걸러 내는 반대 부류(결과 목록에는 나오지 않는다)
const OTHER = ["a photo of a building.", "a photo of a person.", "a photo of food.", "a photo of a car on a road.", "a photo of an indoor room.", "a screenshot of text."];

export function promptsFor(s) {
  const p = [
    `a photo of the leaves of a ${s.en} (${s.sci}).`,
    `a close-up photo of a ${s.en} leaf, ${s.leaf}.`,
    `a photo of a ${s.en} tree (${s.sci}).`,
    `a photo of a ${s.en} tree planted along a street.`,
  ];
  if (s.flower) p.push(`a photo of ${s.en} flowers, ${s.flower}.`);
  if (s.fruit) p.push(`a photo of ${s.en} fruit, ${s.fruit}.`);
  return p.concat(s.extra || []);
}
const norm = v => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Array.from(v, x => x / n); };
const mean = rows => norm(rows[0].map((_, k) => rows.reduce((a, r) => a + r[k], 0) / rows.length));

async function textEmbeddings() {
  const tok = await AutoTokenizer.from_pretrained(MODEL);
  const model = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: "fp32" });
  const embed = async texts => {
    const inputs = tok(texts, { padding: "max_length", truncation: true });
    const { text_embeds } = await model(inputs);
    return text_embeds.tolist().map(norm);
  };
  const classes = [];
  for (const [species, s] of Object.entries(SPECIES)) classes.push({ species, prompts: promptsFor(s), emb: mean(await embed(promptsFor(s))) });
  return { classes, other: mean(await embed(OTHER)) };
}

const t0 = Date.now();
const { classes, other } = await textEmbeddings();
// 사전확률: docs/data/summary.json의 수종별 그루 수(기타 제외)
const SUMMARY = JSON.parse(readFileSync(new URL("docs/data/summary.json", root), "utf8"));
const counts = Object.fromEntries(SUMMARY.species.map(s => [s.species, s.count]));
const total = classes.reduce((a, c) => a + (counts[c.species] || 1), 0);
for (const c of classes) c.prior = (counts[c.species] || 1) / total;
console.log(`문장 임베딩 ${classes.length}종 × ${classes[0].emb.length}차원 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${MODEL})`);
if (WRITE) {
  const r4 = v => v.map(x => Math.round(x * 1e4) / 1e4);
  const out = { note: "pipeline/leafid.mjs가 만든 수종별 평균 문장 임베딩(CLIP 제로샷). 브라우저는 그림 인코더만 받아 이 값과 코사인 유사도를 잰다.",
    model: MODEL, dtype: DTYPE, logit_scale: 100, prior_strength: PRIOR, tta: TTA, built: new Date().toISOString().slice(0, 10),
    classes: classes.map(c => ({ species: c.species, prior: Math.round(c.prior * 1e5) / 1e5, emb: r4(c.emb) })), other: r4(other) };
  writeFileSync(new URL("docs/data/leafid.json", root), JSON.stringify(out) + "\n");
  console.log("docs/data/leafid.json 저장");
}

if (EVAL) {
  const manifest = JSON.parse(readFileSync(path.join(EVAL, "manifest.json"), "utf8"));
  const t1 = Date.now();
  const processor = await AutoProcessor.from_pretrained(MODEL);
  const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: DTYPE });
  console.log(`그림 인코더(${DTYPE}) 불러오기 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  const stats = {}, rows = [];
  const bump = (key, top1, top3) => { const s = (stats[key] ||= { n: 0, top1: 0, top3: 0 }); s.n++; s.top1 += top1; s.top3 += top3; };
  for (const m of manifest) {
    if (!SPECIES[m.species]) continue;
    const image = await RawImage.read(path.join(EVAL, m.file));
    const views = [image];
    if (TTA) {
      const side = Math.min(image.width, image.height);
      if (image.width > image.height) views.push(await image.crop([0, 0, side - 1, side - 1]), await image.crop([image.width - side, 0, image.width - 1, side - 1]));
      else views.push(await image.crop([0, 0, side - 1, side - 1]), await image.crop([0, image.height - side, side - 1, image.height - 1]));
    }
    const embs = [];
    for (const im of views) { const { image_embeds } = await vision(await processor(im)); embs.push(norm(image_embeds.tolist()[0])); }
    const v = mean(embs);
    const dot = e => e.reduce((a, x, k) => a + x * v[k], 0);
    const ranked = classes.map(c => ({ species: c.species, s: dot(c.emb) + PRIOR * Math.log(c.prior) / 100 })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex(r => r.species === m.species);
    const otherWins = dot(other) > Math.max(...classes.map(c => dot(c.emb)));
    rows.push({ ...m, pred: ranked.slice(0, 3).map(r => r.species), rank, otherWins });
    for (const key of ["전체", `${m.kind}`, `${m.species}`, `${m.species}/${m.kind}`]) bump(key, rank === 0 ? 1 : 0, rank < 3 ? 1 : 0);
  }
  const pct = (a, n) => `${Math.round(a / n * 100)}%`;
  console.log(`\n| 묶음 | 장 | top-1 | top-3 |\n|---|---:|---:|---:|`);
  for (const [k, s] of Object.entries(stats).sort()) console.log(`| ${k} | ${s.n} | ${pct(s.top1, s.n)} | ${pct(s.top3, s.n)} |`);
  console.log(`\n나무 아님으로 판정: ${rows.filter(r => r.otherWins).length}장`);
  writeFileSync(path.join(EVAL, `result_${MODEL.replace(/\W+/g, "_")}_${DTYPE}_p${PRIOR}${TTA ? "_tta" : ""}.json`), JSON.stringify({ model: MODEL, dtype: DTYPE, stats, rows }, null, 1));
}
