// Supabase 연결(나무 SNS 온라인 부분): 익명 로그인, 보호자·내 나무·활동·메시지, 동네 순위.
// 공개 키(anon/publishable)만 쓰고, 쓰기 권한은 서버의 RLS와 트리거가 지킨다(supabase/sns_schema.sql).
// 사진·메모·위치는 올리지 않는다. 서버가 없으면(설정이 비어 있으면) 모든 함수가 조용히 null을 돌려준다.
const SESSION_KEY = "wg-cloud-session";
let cfg = null, session = null, refreshing = null;

export function configure(c) {
  cfg = c && c.url && c.key ? { url: c.url.replace(/\/+$/, ""), key: c.key } : null;
  if (cfg) {
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { session = null; }
    if (session && session.url !== cfg.url) session = null; // 다른 서버의 세션
    try { communityState = sessionStorage.getItem(COMMUNITY_MISSING) === cfg.url ? false : null; } catch { communityState = null; }
  }
  return Boolean(cfg);
}
export const configured = () => Boolean(cfg);
export const baseUrl = () => cfg?.url || null;
export const signedIn = () => Boolean(cfg && session?.refresh_token);
export const userId = () => session?.user_id || null;

function saveSession(s) {
  session = s ? { ...s, url: cfg.url } : null;
  try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(session)); else localStorage.removeItem(SESSION_KEY); } catch { /* 세션은 메모리에만 */ }
}
const baseHeaders = () => ({ apikey: cfg.key, "Content-Type": "application/json" });

async function authPost(path, body) {
  const r = await fetch(`${cfg.url}/auth/v1/${path}`, { method: "POST", headers: baseHeaders(), body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.msg || data.error_description || data.message || `auth ${r.status}`);
  return data;
}
function adopt(data) {
  saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, user_id: data.user?.id || session?.user_id,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
}
// 익명 계정 만들기(대시보드에서 Anonymous sign-ins를 켜야 한다)
export async function signIn() {
  if (!cfg) return null;
  if (signedIn()) return session;
  adopt(await authPost("signup", { data: { app: "woori-garosu" } }));
  return session;
}
export function signOut() { saveSession(null); }

async function accessToken() {
  if (!session?.refresh_token) throw new Error("not signed in");
  if (Date.now() < session.expires_at - 60000) return session.access_token;
  if (!refreshing) {
    refreshing = authPost("token?grant_type=refresh_token", { refresh_token: session.refresh_token })
      .then(data => { adopt(data); return session.access_token; })
      .catch(err => { if (/invalid|not found|expired/i.test(err.message)) saveSession(null); throw err; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function rest(path, { method = "GET", body, params = {}, prefer } = {}) {
  if (!cfg) return null;
  const q = new URLSearchParams(params).toString();
  const headers = { ...baseHeaders(), Authorization: `Bearer ${await accessToken()}` };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${cfg.url}/rest/v1/${path}${q ? "?" + q : ""}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(data?.message || data?.hint || `${path} ${r.status}`);
    err.status = r.status; err.code = data?.code;
    throw err;
  }
  return data;
}
const eq = v => `eq.${v}`;

export const api = {
  async me() {
    const rows = await rest("guardians", { params: { id: eq(userId()), select: "id,nickname,dong" } });
    return rows?.[0] || null;
  },
  async setProfile({ nickname, dong }) {
    const rows = await rest("guardians", { method: "POST", body: { id: userId(), nickname, dong: dong || null }, params: { on_conflict: "id" }, prefer: "resolution=merge-duplicates,return=representation" });
    return rows?.[0] || null;
  },
  follow(tree) {
    return rest("tree_follows", { method: "POST", body: { guardian_id: userId(), tree_id: tree.id, tree_name: tree.name, species: tree.species || null, dong: tree.dong || null, since: tree.since || new Date().toISOString() },
      params: { on_conflict: "guardian_id,tree_id" }, prefer: "resolution=merge-duplicates,return=minimal" });
  },
  unfollow(treeId) { return rest("tree_follows", { method: "DELETE", params: { guardian_id: eq(userId()), tree_id: eq(treeId) }, prefer: "return=minimal" }); },
  treeGuardians(treeId) { return rest("tree_guardians", { params: { tree_id: eq(treeId), order: "since.asc", select: "guardian_id,nickname,tree_name,since" } }); },
  // 같은 기기 기록(client_id)을 두 번 보내도 한 번만 남는다
  addActivity({ treeId, activity, clientId, dong, t }) {
    return rest("activities", { method: "POST", body: { guardian_id: userId(), tree_id: treeId, activity, client_id: clientId, dong: dong || null, t },
      params: { on_conflict: "guardian_id,client_id" }, prefer: "resolution=ignore-duplicates,return=minimal" });
  },
  treeFeed(treeId, limit = 30) { return rest("tree_activity_feed", { params: { tree_id: eq(treeId), order: "t.desc", limit, select: "id,nickname,activity,label,kind,points,kg,t" } }); },
  messages(treeId, afterId = 0, limit = 200) { return rest("tree_messages", { params: { tree_id: eq(treeId), id: `gt.${afterId}`, order: "id.asc", limit, select: "id,guardian_id,nickname,body,t" } }); },
  sendMessage(treeId, body) {
    return rest("tree_messages", { method: "POST", body: { tree_id: treeId, guardian_id: userId(), nickname: "", body }, prefer: "return=representation" });
  },
  rankings(limit = 20) { return rest("dong_rankings", { params: { order: "rank.asc", limit, select: "dong,rank,guardians,trees,activities,points,kg" } }); },
  async myScore() {
    const rows = await rest("guardian_scores", { params: { guardian_id: eq(userId()), select: "points,kg,activities,trees,dong" } });
    return rows?.[0] || null;
  },
};

// ---------- 시민 등록 나무 공유(선택, supabase/user_trees.sql) ----------
// 표·함수가 서버에 없으면 available()이 false가 되어 화면은 조용히 기기 저장만 한다.
// 읽기는 참여하지 않은 사람도 되게 공개 키만으로 부르고(user_trees_in_bbox 함수), 쓰기는 익명 계정으로 자기 행만.
async function publicRpc(name, body) {
  if (!cfg) return null;
  const r = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, { method: "POST", headers: baseHeaders(), body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) { const err = new Error(data?.message || `${name} ${r.status}`); err.status = r.status; err.code = data?.code; throw err; }
  return data;
}
export const userTreesApi = {
  // 전주 한가운데 아주 작은 범위로 한 번 불러 보고 함수가 있는지 본다
  async available() {
    if (!cfg) return false;
    try { await publicRpc("user_trees_in_bbox", { w: 127.147, s: 35.823, e: 127.148, n: 35.824, max_rows: 1 }); return true; }
    catch (err) { if (err.status !== 404 && !["PGRST202", "42883", "42P01"].includes(err.code)) console.warn("user_trees 확인 실패", err.message); return false; }
  },
  inBbox(w, s, e, n, maxRows = 500) { return publicRpc("user_trees_in_bbox", { w, s, e, n, max_rows: maxRows }); },
  // 위치·수종·지름·동만 보낸다(사진·닉네임·시각은 보내지 않음). 같은 id면 고쳐 쓴다
  share(t) {
    return rest("user_trees", { method: "POST", body: { id: t.id, species: t.species || null, species_source: t.species_source || "unknown", dbh: t.dbh || null, lon: t.lon, lat: t.lat, dong: t.dong || null },
      params: { on_conflict: "id" }, prefer: "resolution=merge-duplicates,return=minimal" });
  },
  unshare(id) { return rest("user_trees", { method: "DELETE", params: { id: eq(id) }, prefer: "return=minimal" }); },
};

// ---------- 커뮤니티(선택, supabase/community.sql) ----------
// 기간별 순위·현황 숫자·이웃 소식·다른 보호자가 돌보는 나무. 참여한 사람(익명 계정)만 부를 수 있다.
// 서버에 함수가 없으면(404) 한 번만 확인하고 이 탭이 닫힐 때까지(sessionStorage) 다시 부르지 않는다.
const COMMUNITY_MISSING = "wg-community-missing";
const MISSING_CODES = ["PGRST202", "42883", "42P01"];
let communityState = null, communityProbe = null;   // null 모름 · true 있음 · false 없음
async function communityRpc(name, body = {}) {
  if (!cfg || communityState === false) return null;
  try {
    const data = await rest(`rpc/${name}`, { method: "POST", body });
    communityState = true;
    return data;
  } catch (err) {
    if (err.status === 404 || MISSING_CODES.includes(err.code)) {
      communityState = false;
      try { sessionStorage.setItem(COMMUNITY_MISSING, cfg.url); } catch { /* 메모리에만 */ }
      return null;
    }
    throw err;
  }
}
export const communityApi = {
  // 참여 중이고 서버에 community.sql이 있으면 true. 결과는 세션 동안 기억한다
  async available() {
    if (!cfg || !signedIn() || communityState === false) return false;
    if (communityState === true) return true;
    if (!communityProbe) communityProbe = communityRpc("community_prefs").then(() => communityState === true, () => false).finally(() => { communityProbe = null; });
    return communityProbe;
  },
  known: () => communityState,
  prefs() { return communityRpc("community_prefs"); },
  setPrefs(showNickname) { return communityRpc("community_set_prefs", { p_show_nickname: Boolean(showNickname) }); },
  // period: day|week|month|year(한국 시간), target: dong|guardian|tree
  rankings(period, target, limit = 10) { return communityRpc("community_rankings", { p_period: period, p_target: target, p_limit: limit }); },
  stats() { return communityRpc("community_stats"); },
  feed(limit = 20) { return communityRpc("community_feed", { p_limit: limit }); },
  // 서버에는 나무 좌표가 없어 화면 안 나무의 관리번호로 묻는다(최대 3000개)
  treesInView(ids) { return communityRpc("community_trees_in_view", { p_ids: ids.slice(0, 3000) }); },
};
