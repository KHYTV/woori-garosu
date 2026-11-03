// 거리 계산, 동네 찾기(동·도로 색인 + OSM 지오코딩), 내 위치
export const JEONJU = { lon: 127.148, lat: 35.824, bbox: [126.95, 35.70, 127.35, 35.95] };
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

export function distanceM(lon1, lat1, lon2, lat2) {
  const R = 6371000, toRad = v => v * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 반경 안의 가까운 나무 [{i, d}] (가까운 순)
export function nearestTrees(T, lon, lat, { radius = 300, limit = 40 } = {}) {
  const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
  const out = [];
  for (let i = 0; i < T.id.length; i++) {
    const x = T.lon[i], y = T.lat[i];
    if (x === null || y === null || Math.abs(x - lon) > dLon || Math.abs(y - lat) > dLat) continue;
    const d = distanceM(lon, lat, x, y);
    if (d <= radius) out.push({ i, d });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, limit);
}

// 반경 안 나무가 거의 없을 때(캠퍼스 안 등): 반경과 상관없이 가장 가까운 n그루
export function nearestAny(T, lon, lat, n = 10) {
  let out = [];
  for (const radius of [1000, 3000, 10000, 60000]) {
    out = nearestTrees(T, lon, lat, { radius, limit: n });
    if (out.length >= n) break;
  }
  return out;
}

// ---------- 지명 검색(전주 지명 사전 data/gazetteer.json) ----------
// 장소 객체: {kind, name, lon, lat, gu?, hjd?, dongName?, alias?, cat?, rank?, count?}
//   kind: gu 구 · dong 행정동 · jibun 법정동 · road 도로 · poi 장소 · apt 아파트 · addr 외부 지오코딩 주소
// 한글은 NFC로 맞춘다(NFD·NFKD면 글자가 자모로 갈라져 일치하지 않는다). 공백·문장부호는 지운다
export function normText(s) {
  return String(s ?? "").normalize("NFC").toLowerCase().replace(/[\s·・.,()[\]{}"'`~!?@#$%^&*_+=|\\/:;<>\-–—]+/g, "");
}
// 시·도·구 접두어. '전북'은 '전북대'와 겹치므로 뒤에 '전주'가 올 때만, '전주'는 뒤에 두 글자 이상 남을 때만('전주역'은 그대로) 뗀다
const PREFIX = /^(전북특별자치도|전라북도|전북도|전북(?=전주)|전주시|전주(?=..)|완산구(?=.)|덕진구(?=.))/;
function stripPrefix(k) {
  for (let i = 0; i < 4; i++) { const t = k.replace(PREFIX, ""); if (t === k) break; k = t; }
  return k;
}
// 이름 하나에서 만드는 다른 표기들(대학교 → 대·대학, 고등학교 → 고, 호성동1가 → 호성1가, 끝의 '아파트' 빼기)
const VARIANT_RULES = [
  [/아파트$/, ""], [/대학교병원/, "대병원"], [/대학교/, "대"], [/대학교/, "대학"],
  [/여자고등학교$/, "여고"], [/고등학교$/, "고"], [/여자중학교$/, "여중"], [/중학교$/, "중"], [/초등학교$/, "초"],
  [/^(\D+)동(\d+가)$/, "$1$2"],
];
function nameVariants(k) {
  const out = [stripPrefix(k)];
  for (const base of [k, out[0]]) for (const [re, to] of VARIANT_RULES) { const t = base.replace(re, to); if (t !== base && t.length >= 2) out.push(t); }
  return out;
}
const KIND_BONUS = { gu: 3, dong: 4, jibun: 4, poi: 2, apt: 1, road: 1, addr: 0 };
const INDEX = new WeakMap();
function indexOf(places) {
  let idx = INDEX.get(places);
  if (idx) return idx;
  idx = places.map(p => {
    const keys = new Map(); // 표기 → 가중치(원 이름 1, 별칭 0.97, 다른 표기 0.93, 묶음 이름 0.85)
    const add = (k, w) => { if (k && (keys.get(k) || 0) < w) keys.set(k, w); };
    const name = normText(p.name), alias = (p.alias || []).map(normText);
    add(name, 1);
    for (const a of alias) add(a, 0.97);
    for (const k of [name, ...alias]) for (const v of nameVariants(k)) add(v, 0.93);
    // 묶음 이름: 효자1동 → 효자동, 호성동1가 → 호성동 ('효자동'을 찾으면 효자1~5동·효자동1~3가가 함께 나온다)
    const group = p.kind === "dong" ? name.replace(/^(\D+)\d+동$/, "$1동") : p.kind === "jibun" ? name.replace(/^(\D+동)\d+가$/, "$1") : name;
    if (group !== name) add(group, 0.85);
    return { p, keys: [...keys] };
  });
  INDEX.set(places, idx);
  return idx;
}
function matchScore(q, key) {
  if (!q || !key) return 0;
  if (key === q) return 100;
  if (key.startsWith(q)) return 60 + 30 * q.length / key.length;
  if (q.length >= 2 && key.includes(q)) return 40 + 20 * q.length / key.length;
  if (key.length >= 2 && q.length > key.length && q.startsWith(key)) return 20 + 10 * key.length / q.length; // '호성동1가664'처럼 더 긴 검색어
  return 0;
}
function queryVariants(k) {
  const out = new Set([k, stripPrefix(k)]);
  for (const v of [...out]) { const t = v.replace(/아파트$/, ""); if (t.length >= 2) out.add(t); }
  return [...out].filter(Boolean);
}
function scoreAll(idx, qvs) {
  const out = [];
  for (const { p, keys } of idx) {
    let best = 0, via = null;
    for (const [k, w] of keys) for (const q of qvs) {
      const s = matchScore(q, k) * w;
      if (s > best) { best = s; via = k; }
    }
    if (best > 0) out.push({ p, match: best, score: best + (KIND_BONUS[p.kind] ?? 0) + (p.rank || 0), via });
  }
  return out;
}
/** 지명 사전 검색 → [{p, match(0~100), score, via}] 점수 순. 로컬 검색이라 키 입력마다 불러도 된다 */
export function searchPlacesScored(places, q, limit = 8) {
  const raw = String(q ?? "").normalize("NFC").trim();
  const whole = normText(raw);
  if (!whole || !places?.length) return [];
  const idx = indexOf(places);
  let scored = scoreAll(idx, queryVariants(whole));
  const words = raw.split(/\s+/).map(normText).filter(Boolean);
  if (words.length > 1 && !scored.some(s => s.match >= 60)) {
    // "효자 백제"처럼 여러 단어: 단어별 점수를 더해 여러 단어가 맞는 곳을 앞세운다
    const sum = new Map();
    for (const w of words) for (const s of scoreAll(idx, queryVariants(w))) {
      const prev = sum.get(s.p) || { p: s.p, match: 0, score: 0, via: s.via };
      prev.match += s.match / words.length; prev.score += s.score / words.length;
      sum.set(s.p, prev);
    }
    scored = [...sum.values()];
  }
  scored.sort((a, b) => b.score - a.score || a.p.name.length - b.p.name.length || a.p.name.localeCompare(b.p.name, "ko"));
  return scored.slice(0, limit);
}
// 장소 객체만 돌려준다(예전 이름 그대로)
export function searchPlaces(places, q, limit = 8) {
  return searchPlacesScored(places, q, limit).map(s => s.p);
}

/** 이름에서 검색어와 일치하는 부분 [[시작, 끝)] (강조 표시용). 공백·문장부호는 건너뛰어 맞춘다 */
export function matchRanges(name, q) {
  const chars = [...String(name ?? "")];
  let compact = "";
  const map = [], pos = [];
  let off = 0;
  chars.forEach((c, i) => { pos.push(off); off += c.length; const n = normText(c); compact += n; for (let j = 0; j < n.length; j++) map.push(i); });
  const toRange = (at, len) => [pos[map[at]], pos[map[at + len - 1]] + chars[map[at + len - 1]].length];
  const whole = normText(q);
  const tries = [...new Set([...queryVariants(whole), ...String(q ?? "").trim().split(/\s+/).map(normText)])].filter(Boolean).sort((a, b) => b.length - a.length);
  const out = [];
  for (const t of tries) {
    const at = compact.indexOf(t);
    if (at < 0) continue;
    const r = toRange(at, t.length);
    if (!out.some(([s, e]) => s < r[1] && r[0] < e)) out.push(r);
  }
  // 묶음 이름으로 찾은 경우('효자동' → 효자1동): 검색어 앞부분이라도 강조
  for (let len = whole.length - 1; !out.length && len >= 2; len--) {
    const at = compact.indexOf(whole.slice(0, len));
    if (at >= 0) out.push(toRange(at, len));
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** 번지가 붙은 주소인가: '백제대로 567', '덕진동1가 664-14', '아중1길 10' → {base, num}. 아니면 null */
export function parseAddress(q) {
  const s = String(q ?? "").normalize("NFC").trim().replace(/\s*번지$/, "");
  const m = s.match(/^(.+?[가-힣\d](?:로|길|동|가|리))\s*(산\s*)?(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
  if (!m) return null;
  return { base: m[1].trim(), num: `${m[2] ? "산" : ""}${m[3]}${m[4] ? `-${m[4]}` : ""}` };
}

// OSM Nominatim으로 번지·건물까지 찾기(전주 범위 안, 1초에 1번 이하). 실패하면 빈 배열
let lastGeocode = 0;
export async function geocode(q) {
  const wait = 1100 - (Date.now() - lastGeocode);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();
  const text = /전주/.test(q) ? q : `전주시 ${q}`;
  const [w, s, e, n] = JEONJU.bbox;
  const url = `${NOMINATIM}?format=jsonv2&limit=5&countrycodes=kr&accept-language=ko&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(text)}`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return [];
    const rows = await r.json();
    return rows.map(x => ({ kind: "osm", name: x.display_name.split(",").slice(0, 3).join(" ").trim(), lon: Number(x.lon), lat: Number(x.lat), count: null }));
  } catch {
    return [];
  }
}

// ---------- 외부 지오코딩(검색 버튼·Enter 때만. 키 입력마다 부르지 않는다) ----------
const PHOTON = "https://photon.komoot.io/api/";
const geoCache = new Map();
async function nominatimSearch(q) {
  const wait = 1100 - (Date.now() - lastGeocode); // Nominatim 이용 정책: 1초에 1번 이하
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();
  const text = /전주/.test(q) ? q : `전주시 ${q}`;
  const [w, s, e, n] = JEONJU.bbox;
  const url = `${NOMINATIM}?format=jsonv2&addressdetails=1&limit=6&countrycodes=kr&accept-language=ko&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(text)}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return [];
  return (await r.json()).map(x => {
    const a = x.address || {}, num = a.house_number || null;
    const name = a.road && num && !x.name ? `${a.road} ${num}` : (x.name || x.display_name.split(",")[0]).trim();
    return { kind: "addr", name, sub: [a.borough || a.city_district, a.quarter || a.suburb || a.neighbourhood, x.name && a.road ? `${a.road}${num ? ` ${num}` : ""}` : null].filter(Boolean).join(" "),
      lon: Number(x.lon), lat: Number(x.lat), num, source: "Nominatim" };
  });
}
async function photonSearch(q) {
  const [w, s, e, n] = JEONJU.bbox;
  const r = await fetch(`${PHOTON}?limit=6&lat=${JEONJU.lat}&lon=${JEONJU.lon}&bbox=${w},${s},${e},${n}&q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } });
  if (!r.ok) return [];
  return ((await r.json()).features || []).map(f => {
    const p = f.properties || {}, [lon, lat] = f.geometry.coordinates, num = p.housenumber || null;
    const street = [p.street, num].filter(Boolean).join(" ");
    return { kind: "addr", name: p.name || street || p.district || "", sub: [p.district || p.locality, p.name ? street : null].filter(Boolean).join(" "),
      lon, lat, num, source: "Photon" };
  });
}
/** Nominatim·Photon(둘 다 OpenStreetMap 기반, 키 없음)을 함께 묻고 전주 범위 안 결과만 겹치지 않게 모은다 */
export async function geocodeAll(q) {
  const key = normText(q);
  if (geoCache.has(key)) return geoCache.get(key);
  const settle = p => p.then(v => v, () => []);
  const [a, b] = await Promise.all([settle(nominatimSearch(q)), settle(photonSearch(q))]);
  const out = [];
  for (const h of [...a, ...b]) {
    if (!h.name || !Number.isFinite(h.lon) || !insideJeonju(h.lon, h.lat)) continue;
    if (out.some(o => distanceM(o.lon, o.lat, h.lon, h.lat) < 60)) continue;
    out.push(h);
  }
  geoCache.set(key, out);
  return out;
}

/**
 * 검색창에서 Enter·검색을 눌렀을 때. 확실하면 {pick}, 아니면 {candidates}로 사용자가 고르게 한다.
 * 번지가 있으면 로컬 색인으로 동·도로를 먼저 잡고, 외부 결과 중 그 근처에서 번지까지 맞는 것만 바로 고른다.
 */
export async function resolveQuery(places, q, { geocoder = geocodeAll } = {}) {
  const addr = parseAddress(q);
  if (!addr) {
    const local = searchPlacesScored(places, q, 8);
    const [a, b] = local;
    const sameName = a && b && a.p.name === b.p.name && a.p.kind === "dong" && b.p.kind === "jibun"; // 서신동(행정동) = 서신동(법정동)
    if (a && a.match >= 99 && (!b || b.match < 99 || sameName)) return { pick: a.p, candidates: local.map(s => s.p) };
    if (a && a.match >= 60) return { candidates: local.map(s => s.p) };
    const ext = await geocoder(q);
    return { candidates: [...local.slice(0, 4).map(s => s.p), ...ext], external: true };
  }
  const anchor = searchPlacesScored(places, addr.base, 4).find(s => s.match >= 70 && ["road", "jibun", "dong"].includes(s.p.kind))?.p || null;
  const ext = await geocoder(q);
  const maxD = !anchor ? Infinity : anchor.kind === "road" ? 8000 : 2500; // 도로는 길어서 중심에서 멀 수 있다
  const near = ext.filter(e => !anchor || distanceM(anchor.lon, anchor.lat, e.lon, e.lat) <= maxD);
  const numOk = near.filter(e => e.num && e.num.replace(/\s/g, "") === addr.num);
  // 같은 번지의 여러 건물(캠퍼스 등)은 1km 안에 모이면 같은 곳으로 본다
  if (numOk.length && numOk.every(e => distanceM(numOk[0].lon, numOk[0].lat, e.lon, e.lat) < 1000)) return { pick: numOk[0], candidates: near, external: true };
  const candidates = [...near];
  if (anchor) candidates.push({ ...anchor, note: "번지는 못 찾았어요 · 중심으로" });
  return { candidates, external: true, anchor };
}

// 좌표 → OSM 주소(도로명·법정동·지번). 나무 카드를 열 때 부른다. 같은 좌표는 한 번만 묻고(기기 캐시), 실패하면 한 번 더 시도한다
const REV_KEY = "wg-revgeo-v1";
function revCache() { try { return JSON.parse(sessionStorage.getItem(REV_KEY)) || {}; } catch { return {}; } }
export async function reverseGeocode(lon, lat, { retry = 1 } = {}) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cache = revCache();
  if (cache[key]) return cache[key];
  for (let attempt = 0; attempt <= retry; attempt++) {
    const wait = 1100 - (Date.now() - lastGeocode);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeocode = Date.now();
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=ko&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, { headers: { Accept: "application/json" } });
      if (r.status === 429) { await new Promise(res => setTimeout(res, 2000)); continue; }
      if (!r.ok) return null;
      const a = (await r.json()).address || {};
      const dong = a.quarter || a.village || a.neighbourhood || null, hjd = a.suburb || null;
      const out = { road: a.road || null, dong, hjd, number: a.house_number || null, gu: a.borough || a.city_district || null,
        text: [a.borough || a.city_district, dong, a.road, a.house_number].filter(Boolean).join(" ") || null };
      try { sessionStorage.setItem(REV_KEY, JSON.stringify({ ...revCache(), [key]: out })); } catch { /* 캐시 없이 진행 */ }
      return out;
    } catch { /* 네트워크 오류: 다시 시도 */ }
  }
  return null;
}

export function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("이 기기에서는 위치를 쓸 수 없습니다."));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lon: pos.coords.longitude, lat: pos.coords.latitude, acc: pos.coords.accuracy }),
      err => reject(new Error(err.code === 1 ? "위치 권한이 거부되었습니다." : "위치를 가져오지 못했습니다.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

export function insideJeonju(lon, lat) {
  const [w, s, e, n] = JEONJU.bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}
