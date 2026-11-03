// 시민이 직접 등록한 나무(산림청 가로수 대장에 없는 캠퍼스·공원 나무 등).
// 기기 IndexedDB "wg-user-trees"에 따로 둔다(wg-sns 판을 올리지 않아 기존 기록과 섞이지 않는다).
// 화면은 이 파일의 userRecord()로 원본 나무(treeRecord)와 같은 모양의 기록을 받아 쓴다.
import { simulateTree, pointEstimate, circumferenceToDbh } from "./carbon.js";
import { estimateForm } from "./treeform.js";
import { nearestTrees, insideJeonju } from "./geo.js";

const NAME = "wg-user-trees", VERSION = 1, STORE = "trees";
let dbp = null;
const memory = new Map();

export const isUserTreeId = id => typeof id === "string" && id.startsWith("u-");
// u-<시각 36진수>-<난수 4자리>: 서버 tree_id 형식(^[0-9A-Za-z_-]{1,32}$)에 맞는다
export const newUserTreeId = (now = Date.now()) => `u-${now.toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;

function open() {
  if (dbp) return dbp;
  dbp = new Promise(resolve => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn("등록 나무 저장소를 열 수 없어 메모리에만 둡니다.", req.error); resolve(null); };
  });
  return dbp;
}
async function run(mode, fn) {
  const d = await open();
  if (!d) return fn(null);
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
export const userTrees = {
  async all() { const rows = await run("readonly", s => (s ? s.getAll() : null)); return rows || [...memory.values()]; },
  async put(rec) { await run("readwrite", s => (s ? s.put(rec) : (memory.set(rec.id, rec), null))); return rec; },
  async remove(id) { await run("readwrite", s => (s ? s.delete(id) : (memory.delete(id), null))); },
};

// ---------- 위치 ----------
// 전주시 경계(docs/data/boundary.geojson) 안인지. 경계를 못 받았으면 사각 범위로
export function insidePolygon(lon, lat, geo) {
  const polys = [];
  for (const f of geo?.features || []) {
    const g = f.geometry;
    if (g?.type === "Polygon") polys.push(g.coordinates);
    else if (g?.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  if (!polys.length) return insideJeonju(lon, lat);
  const inRing = ring => {
    let inside = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [x1, y1] = ring[a], [x2, y2] = ring[b];
      if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) inside = !inside;
    }
    return inside;
  };
  return polys.some(([outer, ...holes]) => inRing(outer) && !holes.some(inRing));
}
// 행정동은 가까운 원본 가로수(400m 안)의 동을 빌려 쓴다(동 순위 집계용 어림)
export function guessDong(T, lon, lat) {
  const [hit] = nearestTrees(T, lon, lat, { radius: 400, limit: 1 });
  return hit && T.dong?.[hit.i] != null ? T.dongs[T.dong[hit.i]] : null;
}

// ---------- 화면용 기록 ----------
const cache = new Map();
// 저장된 등록 나무 u → treeRecord()와 같은 꼴. 흉고가 있으면 carbon.js로 흡수 범위(추정)
export function userRecord(u, { S, P, FORM }) {
  const species = u.species && S.species_info[u.species] ? u.species : "기타";
  const info = S.species_info[species];
  const dbh = u.dbh || (u.circ ? circumferenceToDbh(u.circ) : null);
  const key = `${u.id}|${species}|${dbh}`;
  let est = cache.get(key);
  if (!est) {
    est = { seq: [null, null, null], stor: [null, null, null], annualKg: 0, heightM: null };
    if (dbh) {
      const model = { jenkins_group: info.jenkins_group, alt_group: info.alt_group, growth_class: info.growth_class, mature_height_class: info.mature_height_class, dbh, block: false };
      // 시민이 잰 둘레라 일괄 입력 오차(15%) 대신 개별 측정 오차를 쓴다
      const sim = simulateTree(model, P, { dbhCv: P.dbh_error_cv.value, seed: seedOf(u.id) });
      est = { seq: sim.seq, stor: sim.storage, annualKg: sim.seq[1] ?? pointEstimate(model, P).seq, heightM: estimateForm(dbh, info, FORM).h };
    }
    cache.set(key, est);
  }
  const place = u.place || {};
  return {
    i: -1, id: u.id, species, info, road: place.road || place.dong || u.dong || "우리 동네", dong: u.dong || null, section: null, dongEdge: false,
    grade: "시민 등록", dbh: dbh ? Math.round(dbh * 10) / 10 : null, block: false, seq: est.seq, annualKg: est.annualKg, lon: u.lon, lat: u.lat, heightM: est.heightM,
    user: true, verified: Boolean(u.verified), origin: u.origin || "mine", speciesSource: u.species && S.species_info[u.species] && u.species !== "기타" ? (u.speciesSource || "user") : "unknown",
    ai: u.ai || null, acc: u.acc ?? null, created: u.created, place, photo: u.photo || null, circ: u.circ || null, shared: Boolean(u.shared),
  };
}
function seedOf(id) { let h = 2166136261; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
export const SOURCE_KO = { user: "등록한 사람이 고름", ai: "AI 추정(사람이 확정)", unknown: "모름" };
