// 지명 사전 전수 검수: 행정동·법정동 이름을 실제 검색 엔진(geo.js)에 넣어, 나온 좌표가 맞는 곳인지 대조한다.
//   node tests/gazetteer_audit.mjs           # 요약
//   node tests/gazetteer_audit.mjs --list    # 항목별 표
// 기준:
//  - 행정동: 검색 1순위가 그 행정동이고, 좌표가 같은 이름의 행정동 경계(vuski/admdongkor) 안에 있어야 한다.
//  - 법정동: 검색 결과에 그 법정동이 1순위(같은 이름 행정동이 있으면 2순위 안)로 나오고,
//    ① OSM 동네 점(place=quarter, 기준 위치)에서 300m 안, ② 이름 뿌리가 같은 행정동이 있으면(호성동1가 → 호성동,
//    효자동3가 → 효자1~5동) 그 행정동 경계 안이어야 한다(경계 문서가 OSM과 독립이라 교차 확인이 된다).
//  - 예전 places.json의 법정동 좌표(원본 구간 글자에 그 동이 적힌 나무들의 평균)도 같은 기준으로 채점해 전후를 비교한다.
import { readFileSync, existsSync } from "node:fs";
import { searchPlaces, distanceM } from "../docs/js/geo.js";

const root = new URL("../", import.meta.url);
const read = p => JSON.parse(readFileSync(new URL(p, root), "utf8"));
export const GAZ = read("docs/data/gazetteer.json");
const HJD = read("config/boundaries/jeonju_hangjeongdong.geojson").features.map(f => ({ name: f.properties.adm_nm.split(" ").pop(), geom: f.geometry }));

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inGeom(lon, lat, g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some(rings => inRing(lon, lat, rings[0]) && !rings.slice(1).some(h => inRing(lon, lat, h)));
}
export const hjdAt = (lon, lat) => HJD.find(h => inGeom(lon, lat, h.geom))?.name || null;
export const hjdGeom = name => HJD.find(h => h.name === name)?.geom;
// 법정동 이름 뿌리와 같은 행정동들: 호성동1가 → [호성동], 효자동3가 → [효자1동…효자5동]
export function sameRootHjd(jibun) {
  const root = jibun.replace(/\d+가$/, "");
  return HJD.filter(h => h.name === root || h.name.replace(/\d+동$/, "동") === root).map(h => h.name);
}

export function audit() {
  const rows = [];
  for (const d of GAZ.filter(p => p.kind === "dong")) {
    const top = searchPlaces(GAZ, d.name, 3)[0];
    const ok = top === d && inGeom(top.lon, top.lat, hjdGeom(d.dongName)) && d.dongName === d.name;
    rows.push({ kind: "dong", name: d.name, ok, top: top && `${top.kind}:${top.name}`, at: top && hjdAt(top.lon, top.lat) });
  }
  const jibun = GAZ.filter(p => p.kind === "jibun");
  for (const j of jibun) {
    const res = searchPlaces(GAZ, j.name, 3);
    const rank = res.indexOf(j);
    const shadow = res[0] && res[0].kind === "dong" && res[0].name === j.name; // 같은 이름 행정동이 1순위
    const roots = sameRootHjd(j.name);
    const at = hjdAt(j.lon, j.lat);
    const rootOk = !roots.length || roots.includes(at);
    rows.push({ kind: "jibun", name: j.name, ok: (rank === 0 || (rank === 1 && shadow)) && rootOk && j.hjd === at, rank, at, roots: roots.join("·") });
  }
  return rows;
}

// 예전 places.json 법정동 좌표 채점(파일이 남아 있으면)
export function auditOld(oldPlaces) {
  const ref = new Map(GAZ.filter(p => p.kind === "jibun").map(p => [p.name, p]));
  return oldPlaces.filter(p => p.kind === "jibun").map(p => {
    const r = ref.get(p.name), roots = sameRootHjd(p.name), at = hjdAt(p.lon, p.lat);
    const d = r ? distanceM(p.lon, p.lat, r.lon, r.lat) : null;
    return { name: p.name, d, at, roots: roots.join("·"), far: d !== null && d > 1000, rootBad: roots.length > 0 && !roots.includes(at), outside: !at };
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("gazetteer_audit.mjs")) {
  const rows = audit();
  const list = process.argv.includes("--list");
  const bad = rows.filter(r => !r.ok);
  const by = k => rows.filter(r => r.kind === k);
  console.log(`행정동 ${by("dong").length}개 중 틀림 ${by("dong").filter(r => !r.ok).length}`);
  console.log(`법정동 ${by("jibun").length}개 중 틀림 ${by("jibun").filter(r => !r.ok).length}`);
  for (const r of list ? rows : bad) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.kind} ${r.name} → ${r.top || `순위 ${r.rank}`} · 좌표가 든 행정동 ${r.at}${r.roots ? ` · 뿌리 같은 행정동 ${r.roots}` : ""}`);
  const oldPath = new URL("docs/data/places.json", root);
  const oldArg = process.argv.find(a => a.startsWith("--old="));
  const oldFile = oldArg ? oldArg.slice(6) : oldPath;
  if (existsSync(oldFile)) {
    const old = auditOld(JSON.parse(readFileSync(oldFile, "utf8")));
    if (old.length) {
      const wrong = old.filter(o => o.far || o.rootBad || o.outside);
      console.log(`\n[전] 예전 places.json 법정동 ${old.length}개: 기준 위치에서 1km 넘게 떨어짐 ${old.filter(o => o.far).length}, 이름 뿌리 행정동 밖 ${old.filter(o => o.rootBad).length}, 행정동 경계 밖 ${old.filter(o => o.outside).length} → 틀림 ${wrong.length}`);
      for (const o of list ? old : wrong) console.log(`  ${o.name}: 기준과 ${o.d === null ? "기준 없음" : `${Math.round(o.d)}m`} · 좌표가 든 행정동 ${o.at}${o.roots ? ` (뿌리 ${o.roots})` : ""}`);
    }
  }
  if (bad.length) process.exitCode = 1;
}
