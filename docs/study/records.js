// 실험 응답 저장과 내보내기. 참가자 화면과 연구자 화면이 같이 쓴다.
// 응답은 항상 이 기기 브라우저에 먼저 저장하고, Supabase가 설정돼 있으면 서버로도 보낸다.
// 서버 전송에 실패한 응답은 _rev(저장 횟수)와 _synced_rev(서버에 반영된 횟수)로 표시해 두었다가 다시 보낸다.

export const STORE_KEY = "wg-study-v1";
const BLOCK_KEY = "wg-study-block";

let backend = null;
const chains = new Map();

export function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}

function writeLocal(rec) {
  const all = loadRecords();
  const i = all.findIndex(r => r.pid === rec.pid);
  if (i >= 0) all[i] = { ...rec, _synced_rev: Math.max(rec._synced_rev || 0, all[i]._synced_rev || 0) };
  else all.push(rec);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); return true; } catch { return false; }
}

// Supabase 설정: { url, key }. key는 공개용 키(publishable 또는 anon)만 쓴다
export function configureBackend(cfg) {
  backend = cfg && cfg.url && cfg.key ? { url: cfg.url.replace(/\/+$/, ""), key: cfg.key } : null;
  return Boolean(backend);
}
export const backendEnabled = () => Boolean(backend);

async function rpc(name, body) {
  const headers = { apikey: backend.key, "Content-Type": "application/json" };
  if (backend.key.startsWith("eyJ")) headers.Authorization = `Bearer ${backend.key}`; // 예전 anon 키(JWT)
  const r = await fetch(`${backend.url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body), keepalive: true });
  if (!r.ok) throw new Error(`${name} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function markSynced(pid, rev) {
  const all = loadRecords();
  const rec = all.find(r => r.pid === pid);
  if (!rec) return;
  rec._synced_rev = Math.max(rec._synced_rev || 0, rev);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* 다음에 다시 보낸다 */ }
}

// 같은 참여 번호의 전송은 순서대로 보낸다(앞 단계 응답이 뒤 단계를 덮지 않게)
function queueSync(rec) {
  const payload = Object.fromEntries(Object.entries(rec).filter(([k]) => !k.startsWith("_")));
  const rev = rec._rev || 0;
  const prev = chains.get(rec.pid) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => rpc("submit_study_record", { p_pid: rec.pid, p_record: payload }))
    .then(() => markSynced(rec.pid, rev));
  chains.set(rec.pid, next);
  return next;
}

export function saveRecord(rec) {
  rec._rev = (rec._rev || 0) + 1;
  const ok = writeLocal(rec);
  if (backend) queueSync(rec).catch(err => console.warn("서버 저장 실패, 나중에 다시 보냅니다", err));
  return ok;
}

// 이 참여 번호의 서버 전송이 끝날 때까지 기다린다. 실패하거나 시간이 지나면 false
export async function flush(pid, timeoutMs = 10000) {
  if (!backend || !chains.has(pid)) return !backend;
  const timeout = new Promise(res => setTimeout(() => res(false), timeoutMs));
  return Promise.race([chains.get(pid).then(() => true, () => false), timeout]);
}

export const pendingRecords = () => loadRecords().filter(r => (r._rev || 0) > (r._synced_rev || 0));

// 이 기기에 남은 미전송 응답을 다시 보낸다
export async function syncPending() {
  if (!backend) return { sent: 0, failed: 0 };
  const results = await Promise.allSettled(pendingRecords().map(r => queueSync(r)));
  return { sent: results.filter(x => x.status === "fulfilled").length, failed: results.filter(x => x.status === "rejected").length };
}

export async function onlineCounts(studyId) {
  return rpc("study_counts", { p_study_id: studyId });
}

export function clearRecords() {
  try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(BLOCK_KEY); } catch { /* 무시 */ }
}

// 기기별 블록 무작위 배정: 세 조건을 섞은 묶음을 차례로 쓰고, 다 쓰면 새로 섞는다
export function nextCondition(conditions) {
  let block = [];
  try { block = JSON.parse(localStorage.getItem(BLOCK_KEY)) || []; } catch { block = []; }
  block = block.filter(c => conditions.includes(c));
  if (!block.length) {
    block = [...conditions];
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * (i + 1));
      [block[i], block[j]] = [block[j], block[i]];
    }
  }
  const cond = block.shift();
  try { localStorage.setItem(BLOCK_KEY, JSON.stringify(block)); } catch { /* 저장 못 해도 이번 배정은 유효 */ }
  return cond;
}

export function newPid() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 글자(0·O·1·I) 제외
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join("");
}

const BASE_COLUMNS = ["pid", "study_id", "condition", "assignment", "session", "status", "tree_id",
  "started_at", "consent_at", "min_exposure_sec", "stimulus_start", "stimulus_ms", "n_rotate", "n_season_change", "seasons_viewed",
  "n_year_change", "max_years", "completed_at", "attention_ok", "recall_score", "device_w", "device_h", "touch"];

export function columns(config) {
  const cols = [...BASE_COLUMNS];
  for (const s of config.sections) {
    for (const it of s.items) {
      cols.push(it.id);
      if (s.kind === "recall") cols.push(`${it.id}_ok`);
    }
  }
  return cols;
}

export function toCSV(records, config) {
  const cols = columns(config);
  const esc = v => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? v.join("|") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const flat = r => ({ ...r, ...(r.interactions || {}), ...(r.answers || {}), ...(r.recall_ok || {}) });
  return "﻿" + [cols.join(","), ...records.map(r => { const f = flat(r); return cols.map(c => esc(f[c])).join(","); })].join("\n");
}
