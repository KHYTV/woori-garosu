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

const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
// 동·도로 색인에서 찾기: 앞부분 일치 → 포함 순. "효자동 백제대로"처럼 두 단어면 둘 다 들어간 곳을 앞세운다
export function searchPlaces(places, q, limit = 8) {
  const words = String(q || "").trim().split(/\s+/).map(norm).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const p of places) {
    const name = norm(p.name);
    let score = 0;
    for (const w of words) {
      if (name === w) score += 6;
      else if (name.startsWith(w)) score += 4;
      else if (name.includes(w)) score += 2;
      else if (w.startsWith(name)) score += 1;
    }
    if (score > 0) scored.push({ p, score: score + Math.log10(p.count + 1) * 0.1 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.p);
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

// 좌표 → OSM 주소(도로명·법정동·지번). 나무 카드를 열 때 한 번만 부른다. 실패하면 null
export async function reverseGeocode(lon, lat) {
  const wait = 1100 - (Date.now() - lastGeocode);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=ko&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const a = (await r.json()).address || {};
    const dong = a.quarter || a.village || a.neighbourhood || null, hjd = a.suburb || null;
    return { road: a.road || null, dong, hjd, number: a.house_number || null, gu: a.borough || a.city_district || null,
      text: [a.borough || a.city_district, dong, a.road, a.house_number].filter(Boolean).join(" ") || null };
  } catch { return null; }
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
