// 실험 응답 저장(이 기기 브라우저)과 내보내기. 참가자 화면과 연구자 화면이 같이 쓴다.
// 서버가 생기면 saveRecord만 바꾸면 된다.

export const STORE_KEY = "wg-study-v1";
const BLOCK_KEY = "wg-study-block";

export function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}

export function saveRecord(rec) {
  const all = loadRecords();
  const i = all.findIndex(r => r.pid === rec.pid);
  if (i >= 0) all[i] = rec; else all.push(rec);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); return true; } catch { return false; }
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
