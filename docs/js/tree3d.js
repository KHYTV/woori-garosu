// 나무 한 그루 3D 뷰어와 AR. three.js로 수종 모양·흉고·계절에 맞는 모형을 만들고,
// 같은 모형을 glTF로 내보내 model-viewer로 AR(실제 크기)에 띄운다.
// 모양과 미래 크기는 흉고로 추정한 모형이다(data/tree_form.json, 실측 아님).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { expectedGrowth, mulberry32, projectDbh, simulateTree } from "./carbon.js";
import { estimateForm } from "./treeform.js";

const MODEL_VIEWER_URL = "https://unpkg.com/@google/model-viewer@4.3.1/dist/model-viewer.min.js";
const MAX_YEARS = 20;
const PERSON_HEIGHT = 1.74;
const SEASONS = [["spring", "봄"], ["summer", "여름"], ["autumn", "가을"], ["winter", "겨울"]];
const BLOSSOM = { 벚나무: "#f2c4d2", 이팝나무: "#f4f2e6" };
const UP = new THREE.Vector3(0, 1, 0);

const nf = (v, d = 0) => Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const kg = v => (Math.abs(v) < 10 ? nf(v, 1) : nf(v, 0));

function hashSeed(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function seasonForMonth(month = new Date().getMonth() + 1) {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

function foliageColor(species, info, season) {
  const evergreen = info.leaf_habit === "evergreen";
  if (evergreen) return season === "spring" ? "#3c6e45" : "#2f5d3a";
  if (season === "winter") return null;
  if (season === "spring") return BLOSSOM[species] || "#9cc46a";
  if (season === "autumn") return info.autumn_color || "#c49a3a";
  return "#4f8a4b";
}

// 가지 한 토막: 시작점에서 dir 방향으로 len만큼, 굵기는 r0 → r1
function segment(start, dir, len, r0, r1) {
  const g = new THREE.CylinderGeometry(Math.max(r1, 0.01), Math.max(r0, 0.012), len, 6, 1);
  g.deleteAttribute("uv"); // 텍스처를 쓰지 않으니 AR 파일 크기를 줄인다
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(start, q, new THREE.Vector3(1, 1, 1)));
  return g;
}

// 울퉁불퉁한 잎 덩어리(같은 위치의 꼭짓점은 같은 만큼 밀어 틈이 생기지 않게)
function clump(center, radius, rand) {
  const g = new THREE.IcosahedronGeometry(radius, 1);
  g.deleteAttribute("uv");
  const pos = g.attributes.position;
  const salt = rand() * 1000;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
    const n = Math.sin((x * 12.9898 + y * 78.233 + z * 37.719) / radius + salt) * 43758.5453;
    const s = 0.78 + 0.32 * (n - Math.floor(n));
    pos.setXYZ(k, x * s + center.x, y * s * 0.9 + center.y, z * s + center.z);
  }
  g.computeVertexNormals();
  return g;
}

function randomTilt(dir, minDeg, maxDeg, rand) {
  const axis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5)).normalize();
  const ang = THREE.MathUtils.degToRad(minDeg + (maxDeg - minDeg) * rand());
  return dir.clone().applyAxisAngle(axis, ang).normalize();
}

/** 나무 모형(THREE.Group). 땅은 y=0, 단위는 m */
export function buildTree({ species, info, dbh, form, season, seed }) {
  const rand = mulberry32(seed);
  const { shape, h, cw, base } = estimateForm(dbh, info, form);
  const crownH = h - base;
  const r0 = Math.max(dbh / 200, 0.05);
  const branches = [], tips = [];

  if (shape === "cone") {
    branches.push(segment(new THREE.Vector3(), UP, h * 0.97, r0, r0 * 0.15));
    const step = Math.max(0.45, crownH / 12);
    const lift = species === "은행나무" ? 0.45 : 0.05;
    let whorl = 0;
    for (let y = base; y < h - 0.6; y += step, whorl++) {
      const reach = (cw / 2) * (1 - (y - base) / crownH) * 0.95;
      const rr = r0 * 0.35 * (1 - (y - base) / crownH) + 0.015;
      const n = 4 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) {
        const az = (2 * Math.PI * k) / n + whorl * 0.7 + rand() * 0.4;
        const dir = new THREE.Vector3(Math.cos(az), lift + (rand() - 0.5) * 0.2, Math.sin(az)).normalize();
        const start = new THREE.Vector3(0, y, 0);
        branches.push(segment(start, dir, Math.max(reach, 0.3), rr, rr * 0.3));
        tips.push(start.clone().addScaledVector(dir, reach * 0.55), start.clone().addScaledVector(dir, reach * 0.95));
      }
    }
  } else {
    const top = new THREE.Vector3(0, base + crownH * 0.12, 0);
    branches.push(segment(new THREE.Vector3(), UP, top.y, r0, r0 * 0.75));
    const n = 3 + Math.floor(rand() * 3);
    const elev = shape === "umbrella" ? 32 : 55;
    const firstLen = shape === "umbrella" ? cw * 0.42 : crownH * 0.42;
    const grow = (p, dir, len, r, depth) => {
      const end = p.clone().addScaledVector(dir, len);
      branches.push(segment(p, dir, len, r, r * 0.68));
      if (depth >= 2 || len < 0.5) { tips.push(end); return; }
      const kids = 2 + (rand() < 0.5 ? 1 : 0);
      for (let k = 0; k < kids; k++) {
        const nd = randomTilt(dir, 22, 42, rand);
        nd.y += shape === "umbrella" ? -0.04 : 0.12;
        grow(end, nd.normalize(), len * 0.7, r * 0.62, depth + 1);
      }
    };
    for (let k = 0; k < n; k++) {
      const az = (2 * Math.PI * k) / n + rand() * 0.6;
      const e = THREE.MathUtils.degToRad(elev + (rand() - 0.5) * 18);
      grow(top, new THREE.Vector3(Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)), firstLen, r0 * 0.62, 0);
    }
  }

  const group = new THREE.Group();
  group.name = `${species} 추정 모형`;
  const bark = new THREE.MeshStandardMaterial({ color: form.colors.trunk, roughness: 1 });
  const wood = new THREE.Mesh(mergeGeometries(branches), bark);
  wood.castShadow = true;
  wood.name = "가지";
  group.add(wood);
  branches.forEach(g => g.dispose());

  const color = foliageColor(species, info, season);
  if (color) {
    // 잎 덩어리: 가지 끝 + 수관 윤곽 안을 채우는 덩어리. 색은 밝기를 조금씩 달리한 세 묶음
    const rc = THREE.MathUtils.clamp(cw * (shape === "cone" ? 0.11 : 0.14), shape === "cone" ? 0.25 : 0.4, 2.2);
    const centers = tips.map(t => t.clone());
    const fill = THREE.MathUtils.clamp(Math.round((cw * cw * crownH) / (rc ** 3) * 0.35), 30, 150);
    for (let k = 0; k < fill; k++) {
      const u = rand(), v = rand(), w = rand();
      const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1), rr = 0.55 + 0.45 * Math.cbrt(w);
      let c;
      if (shape === "cone") {
        const y = base + crownH * Math.pow(rand(), 1.3) * 0.95;
        const rad = (cw / 2) * (1 - (y - base) / crownH) * rr;
        c = new THREE.Vector3(Math.cos(theta) * rad, y, Math.sin(theta) * rad);
      } else {
        const cy = shape === "umbrella" ? base + crownH * 0.62 : base + crownH * 0.5;
        const ry = shape === "umbrella" ? crownH * 0.4 : crownH * 0.5;
        c = new THREE.Vector3(Math.sin(phi) * Math.cos(theta) * (cw / 2) * rr, cy + Math.cos(phi) * ry * rr, Math.sin(phi) * Math.sin(theta) * (cw / 2) * rr);
      }
      centers.push(c);
    }
    const buckets = [[], [], []];
    for (const c of centers) buckets[Math.floor(rand() * 3)].push(clump(c, rc * (0.75 + rand() * 0.5), rand));
    const baseColor = new THREE.Color(color);
    buckets.forEach((geoms, b) => {
      if (!geoms.length) return;
      const tint = baseColor.clone().offsetHSL(0, 0, (b - 1) * 0.05);
      const mesh = new THREE.Mesh(mergeGeometries(geoms), new THREE.MeshStandardMaterial({ color: tint, roughness: 0.85, flatShading: true }));
      mesh.castShadow = true;
      mesh.name = `잎${b + 1}`;
      group.add(mesh);
      geoms.forEach(g => g.dispose());
    });
  }
  return { group, h, cw, base };
}

function disposeObject(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
  });
}

let modelViewerLoading = null;
function loadModelViewer() {
  modelViewerLoading ||= import(MODEL_VIEWER_URL);
  return modelViewerLoading;
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

/**
 * 전체 화면 뷰어를 연다.
 * ctx: { tree: {id, species, info, dbh, block, ...modelTree 필드}, P, form, token }
 */
export function openTreeViewer({ tree, P, form, token }) {
  const species = tree.species, info = tree.info;
  const seed = hashSeed(tree.id);
  let season = seasonForMonth(), years = 0, current = null, arUrl = null;

  const stage = el("div", { class: "viewer-stage" });
  const info3d = el("div", { class: "viewer-info", "aria-live": "polite" });
  const yearOut = el("output", { for: "yearRange", class: "num" }, "지금");
  const yearRange = el("input", { type: "range", id: "yearRange", min: "0", max: String(MAX_YEARS), step: "1", value: "0", "aria-label": "몇 년 뒤 모습" });
  const seasonSeg = el("div", { class: "seg", role: "group", "aria-label": "계절" },
    ...SEASONS.map(([key, label]) => el("button", { type: "button", "data-season": key, "aria-pressed": String(key === season) }, label)));
  const arBtn = el("button", { type: "button", class: "btn" }, "AR로 내 앞에 놓기 (실제 크기)");
  const arBox = el("div", { class: "ar-box", hidden: true });
  const closeBtn = el("button", { type: "button", class: "close", "aria-label": "3D 보기 닫기" }, "×");
  const root = el("div", { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": `${species} 3D 보기` },
    el("div", { class: "viewer-head" },
      el("div", {}, el("h2", {}, `${species} 3D`), el("div", { class: "id" }, `관리번호 ${tree.id} · 추정 모형`)), closeBtn),
    stage,
    el("div", { class: "viewer-panel" },
      el("div", { class: "row" }, seasonSeg),
      el("label", { class: "range", for: "yearRange" }, el("span", {}, "시간"), yearRange, yearOut),
      info3d,
      el("div", { class: "row" }, arBtn),
      arBox,
      el("p", { class: "hint" }, "모양과 미래 크기는 흉고로 추정한 모형입니다(실측 아님). 회색 사람 모형은 키 1.7m입니다.")));
  document.body.append(root);
  document.body.style.overflow = "hidden";

  // 렌더러·장면
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(token("--bg") || "#f3f5f1");
  scene.add(new THREE.HemisphereLight(0xe6eef5, 0x8a7f6a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun, sun.target);

  // 20년 뒤 크기까지 화면에 들어오게 카메라를 맞춘다
  const modelTree = { ...tree.model };
  const dbhFuture = projectDbh(modelTree, P, MAX_YEARS);
  const maxForm = estimateForm(dbhFuture, info, form);
  const span = Math.max(maxForm.h, maxForm.cw);
  const groundR = Math.max(maxForm.cw * 1.1, 6);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(groundR, 48), new THREE.MeshStandardMaterial({ color: token("--accent-soft") || "#e2ede5", roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, PERSON_HEIGHT - 0.4, 4, 8), new THREE.MeshStandardMaterial({ color: 0x7d877f, roughness: 0.9 }));
  person.position.set(maxForm.cw / 2 + 1.6, PERSON_HEIGHT / 2, 0.6);
  person.castShadow = true;
  scene.add(person);
  Object.assign(sun.position, { x: span, y: span * 2, z: span * 0.8 });
  const sc = sun.shadow.camera;
  Object.assign(sc, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: span * 6 });
  sc.updateProjectionMatrix();

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, maxForm.h * 0.45, 0);
  // 화면 비율에 맞춰 20년 뒤 나무 전체(높이·수관폭)가 들어오는 거리로 카메라를 놓는다. 처음 한 번만 맞춘다
  let fitted = false;
  const fitCamera = () => {
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const width = Math.max(maxForm.cw, person.position.x * 2 + 1);
    const dist = Math.max((maxForm.h * 0.62) / Math.tan(vfov / 2), (width * 0.62) / Math.tan(hfov / 2)) + 2;
    const dir = new THREE.Vector3(1, 0.42, 1.1).normalize();
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    controls.update();
    fitted = true;
  };
  controls.enableDamping = false;
  controls.minDistance = 2;
  controls.maxDistance = span * 5;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  const render = () => renderer.render(scene, camera);
  controls.addEventListener("change", render);
  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!fitted) fitCamera();
    render();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  const nowRange = simulateTree(modelTree, P, { n: 1500 }).storage;
  function rebuild() {
    if (current) { scene.remove(current.group); disposeObject(current.group); }
    const dbh = years ? projectDbh(modelTree, P, years) : modelTree.dbh;
    current = { ...buildTree({ species, info, dbh, form, season, seed }), dbh };
    scene.add(current.group);
    if (arUrl) { URL.revokeObjectURL(arUrl); arUrl = null; arBox.hidden = true; arBox.replaceChildren(); }
    render();
    updateInfo();
  }
  function updateInfo() {
    const c = current;
    const lines = [
      el("div", {}, `${years ? `${years}년 뒤` : "지금"} · 흉고 약 ${nf(c.dbh)}cm · 높이 약 ${nf(c.h)}m · 수관폭 약 ${nf(c.cw)}m`),
      el("div", {}, `지금 저장한 CO₂ ${kg(nowRange[0])}~${kg(nowRange[2])}kg (추정)`),
    ];
    if (years) {
      const fut = simulateTree({ ...modelTree, dbh: c.dbh }, P, { n: 1500 }).storage;
      lines.push(el("div", {}, `${years}년 뒤 저장 CO₂ ${kg(fut[0])}~${kg(fut[2])}kg, 그동안 약 ${kg(fut[1] - nowRange[1])}kg 더 저장(중앙값 기준)`));
      lines.push(el("div", { class: "hint" }, `해마다 흉고가 약 ${nf(expectedGrowth(modelTree, P, c.dbh), 1)}cm 자란다고 본 기댓값입니다. 실제 생장은 관리와 환경에 따라 다릅니다.`));
    }
    if (season === "winter" && info.leaf_habit !== "evergreen") lines.push(el("div", { class: "hint" }, "겨울에는 잎이 떨어져 가지만 보입니다."));
    info3d.replaceChildren(...lines);
  }

  seasonSeg.addEventListener("click", e => {
    const b = e.target.closest("button[data-season]");
    if (!b) return;
    season = b.dataset.season;
    for (const x of seasonSeg.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    rebuild();
  });
  yearRange.addEventListener("input", () => {
    years = Number(yearRange.value);
    yearOut.textContent = years ? `${years}년 뒤` : "지금";
    rebuild();
  });

  // AR: 현재 모형을 glTF로 내보내 model-viewer에 넘긴다. AR 시작은 model-viewer 버튼(사용자 탭)으로 한다
  arBtn.addEventListener("click", async () => {
    arBtn.disabled = true;
    arBox.hidden = false;
    arBox.replaceChildren(el("p", { class: "hint" }, "AR 모형을 준비하는 중입니다."));
    try {
      const [glb] = await Promise.all([new GLTFExporter().parseAsync(current.group, { binary: true }), loadModelViewer()]);
      arUrl = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
      const mv = el("model-viewer", {
        src: arUrl, alt: `${species} 추정 모형`, ar: true, "ar-modes": "webxr scene-viewer quick-look",
        "ar-scale": "fixed", "ar-placement": "floor", "camera-controls": true, "shadow-intensity": "1",
        "touch-action": "pan-y",
      }, el("button", { slot: "ar-button", class: "btn" }, "내 앞에 실제 크기로 놓기"));
      const msg = el("p", { class: "hint" }, "");
      mv.addEventListener("load", () => {
        msg.textContent = mv.canActivateAR
          ? "버튼을 누르고 휴대폰으로 바닥을 비추면 실제 크기의 나무가 나타납니다."
          : "이 기기나 브라우저에서는 AR을 쓸 수 없습니다. 안드로이드 Chrome(ARCore 지원 기기)이나 아이폰·아이패드 Safari에서 열어 주세요.";
      });
      mv.addEventListener("ar-status", e => {
        if (e.detail.status === "failed") msg.textContent = "AR을 시작하지 못했습니다. 다른 브라우저(안드로이드 Chrome, 아이폰 Safari)에서 다시 시도해 주세요.";
      });
      arBox.replaceChildren(mv, msg);
    } catch (err) {
      console.error(err);
      arBox.replaceChildren(el("p", { class: "hint" }, "AR 모형을 만들지 못했습니다. 네트워크 연결을 확인해 주세요."));
    } finally {
      arBtn.disabled = false;
    }
  });

  function close() {
    ro.disconnect();
    controls.dispose();
    if (current) disposeObject(current.group);
    disposeObject(scene);
    renderer.dispose();
    if (arUrl) URL.revokeObjectURL(arUrl);
    root.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
  }
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  closeBtn.addEventListener("click", close);
  closeBtn.focus();

  rebuild();
  resize();
  return { close };
}
