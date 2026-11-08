"""개발용 가짜 Supabase. 연구4 RPC와 나무 SNS(익명 로그인 + 표 REST)를 supabase/*.sql과 같은 규칙으로 흉내 낸다.

  python tests/mock_supabase.py 8791
  → 연구4:  http://localhost:8790/study/?backend=http://localhost:8791&backendkey=test
  → SNS:    http://localhost:8790/?backend=http://localhost:8791&backendkey=test#sns

  GET  /__mock/rows        저장된 모든 표 보기
  POST /__mock/fail?on=1   전송 실패(503) 흉내 켜기, on=0이면 끄기
  POST /__mock/reset       SNS 표 비우기
  POST /__mock/community?on=0  community.sql을 아직 실행하지 않은 서버 흉내(커뮤니티 함수 404), on=1이면 되돌리기
                               (시작할 때 --no-community 를 붙여도 된다)

PostgREST 흉내는 이 앱이 쓰는 만큼만: select(무시), eq/gt/in 필터, order, limit, on_conflict + Prefer resolution.
"""

import json
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
PID = re.compile(r"^[A-Z2-9]{8}$")
CONDITIONS = {"text", "image", "immersive"}
ROWS: dict[str, dict] = {}
STATE = {"fail": False, "community": "--no-community" not in sys.argv}

# ---------- SNS ----------
ACT = json.loads((ROOT / "config" / "activities.json").read_text(encoding="utf-8"))
CATALOG = {a["id"]: {"id": a["id"], "kind": kind, "label": a["label"], "points": a["points"], "kg": a.get("kg")}
           for kind in ("care", "practice") for a in ACT[kind]}
DAILY_LIMIT = ACT.get("daily_limit_per_tree", 3)
USERS: dict[str, dict] = {}       # access/refresh token → uid
TABLES: dict[str, list] = {"guardians": [], "tree_follows": [], "activities": [], "tree_messages": []}
PREFS: dict[str, bool] = {}       # community.sql guardian_prefs: uid → 닉네임 공개
SEQ = {"activities": 0, "tree_messages": 0}
KST = timezone(timedelta(hours=9))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def reset_sns():
    for k in TABLES:
        TABLES[k].clear()
    PREFS.clear()
    SEQ.update(activities=0, tree_messages=0)


class Refuse(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def anon_signup():
    uid = str(uuid.uuid4())
    tok = {"access_token": f"mock-access-{uuid.uuid4().hex}", "refresh_token": f"mock-refresh-{uuid.uuid4().hex}", "expires_in": 3600,
           "token_type": "bearer", "user": {"id": uid, "is_anonymous": True}}
    USERS[tok["access_token"]] = uid
    USERS[tok["refresh_token"]] = uid
    return tok


def refresh(refresh_token):
    uid = USERS.get(refresh_token)
    if not uid:
        raise Refuse(400, "Invalid Refresh Token")
    tok = {"access_token": f"mock-access-{uuid.uuid4().hex}", "refresh_token": f"mock-refresh-{uuid.uuid4().hex}", "expires_in": 3600,
           "token_type": "bearer", "user": {"id": uid, "is_anonymous": True}}
    USERS[tok["access_token"]] = uid
    USERS[tok["refresh_token"]] = uid
    return tok


def parse_filters(query):
    filters, order, limit = [], None, None
    for key, vals in query.items():
        v = vals[0]
        if key in ("select", "on_conflict"):
            continue
        if key == "order":
            col, _, dirn = v.partition(".")
            order = (col, dirn != "desc")
        elif key == "limit":
            limit = int(v)
        else:
            op, _, val = v.partition(".")
            filters.append((key, op, val))
    return filters, order, limit


def matches(row, filters):
    for col, op, val in filters:
        x = row.get(col)
        if op == "eq" and str(x) != val:
            return False
        if op == "gt" and not (x is not None and float(x) > float(val)):
            return False
        if op == "in":
            if str(x) not in [s.strip() for s in val.strip("()").split(",")]:
                return False
    return True


def apply(rows, query):
    filters, order, limit = parse_filters(query)
    out = [r for r in rows if matches(r, filters)]
    if order:
        col, asc = order
        out.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=not asc)
    if limit is not None:
        out = out[:limit]
    return out


def views(uid):
    g = {r["id"]: r for r in TABLES["guardians"]}
    cat = CATALOG
    follows_mine = {f["tree_id"] for f in TABLES["tree_follows"] if f["guardian_id"] == uid}
    tree_guardians = [{"tree_id": f["tree_id"], "guardian_id": f["guardian_id"], "nickname": g[f["guardian_id"]]["nickname"], "tree_name": f["tree_name"], "since": f["since"]}
                      for f in TABLES["tree_follows"] if f["guardian_id"] in g]
    feed = [{"id": a["id"], "tree_id": a["tree_id"], "nickname": g[a["guardian_id"]]["nickname"], "activity": a["activity"], "label": cat[a["activity"]]["label"],
             "kind": a["kind"], "points": a["points"], "kg": a["kg"], "t": a["t"]} for a in TABLES["activities"] if a["guardian_id"] in g]
    scores = []
    for gid, gr in g.items():
        mine = [a for a in TABLES["activities"] if a["guardian_id"] == gid]
        scores.append({"guardian_id": gid, "nickname": gr["nickname"], "dong": gr.get("dong"), "points": sum(a["points"] for a in mine),
                       "kg": round(sum(a["kg"] or 0 for a in mine), 3), "activities": len(mine),
                       "trees": sum(1 for f in TABLES["tree_follows"] if f["guardian_id"] == gid)})
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    by_dong = {}
    for a in TABLES["activities"]:
        if not a.get("dong") or datetime.fromisoformat(a["t"]) < cutoff:
            continue
        d = by_dong.setdefault(a["dong"], {"dong": a["dong"], "guardians": set(), "trees": set(), "activities": 0, "points": 0, "kg": 0.0})
        d["guardians"].add(a["guardian_id"]); d["trees"].add(a["tree_id"]); d["activities"] += 1; d["points"] += a["points"]; d["kg"] += a["kg"] or 0
    ranked = sorted(by_dong.values(), key=lambda d: (-d["points"], -len(d["guardians"])))
    rankings = [{"dong": d["dong"], "rank": i + 1, "guardians": len(d["guardians"]), "trees": len(d["trees"]), "activities": d["activities"],
                 "points": d["points"], "kg": round(d["kg"], 3)} for i, d in enumerate(ranked)]
    messages = [m for m in TABLES["tree_messages"] if m["tree_id"] in follows_mine]  # RLS: 내 나무 방만
    return {"tree_guardians": tree_guardians, "tree_activity_feed": feed, "guardian_scores": scores, "dong_rankings": rankings,
            "activity_catalog": list(cat.values()), "tree_messages": messages}


def insert(table, body, uid, query, prefer):
    if not uid:
        raise Refuse(401, "sign in first")
    row = dict(body)
    resolution = "merge-duplicates" if "merge-duplicates" in prefer else "ignore-duplicates" if "ignore-duplicates" in prefer else None
    conflict = query.get("on_conflict", [""])[0].split(",") if query.get("on_conflict") else []
    rows = TABLES[table]
    if table == "guardians":
        if row.get("id") != uid:
            raise Refuse(403, "guardian id must be the signed-in user")
        if not 1 <= len(row.get("nickname") or "") <= 12:
            raise Refuse(400, "nickname length")
        row.setdefault("created_at", now_iso()); row["updated_at"] = now_iso()
    elif table == "tree_follows":
        if row.get("guardian_id") != uid:
            raise Refuse(403, "row-level security")
        if not 1 <= len(row.get("tree_name") or "") <= 12:
            raise Refuse(400, "tree_name length")
        row.setdefault("since", now_iso())
    elif table == "activities":
        row["guardian_id"] = uid
        c = CATALOG.get(row.get("activity"))
        if not c:
            raise Refuse(400, "unknown activity")
        follow = next((f for f in rows_of("tree_follows") if f["guardian_id"] == uid and f["tree_id"] == row.get("tree_id")), None)
        if not follow:
            raise Refuse(400, "not a guardian of this tree")
        row.update(kind=c["kind"], points=c["points"], kg=c["kg"])
        row.setdefault("dong", follow.get("dong"))
        row["t"] = row.get("t") or now_iso()
        day = datetime.fromisoformat(row["t"]).astimezone(KST).date()
        same = [a for a in rows if a["guardian_id"] == uid and a["tree_id"] == row["tree_id"] and a["activity"] == row["activity"]
                and datetime.fromisoformat(a["t"]).astimezone(KST).date() == day]
        dup = next((a for a in rows if a["guardian_id"] == uid and a.get("client_id") == row.get("client_id")), None)
        if dup:
            if resolution == "ignore-duplicates":
                return []
            raise Refuse(409, "duplicate key")
        if len(same) >= DAILY_LIMIT:
            raise Refuse(400, "daily limit reached")
        SEQ["activities"] += 1; row["id"] = SEQ["activities"]
    elif table == "tree_messages":
        row["guardian_id"] = uid
        if not any(f["guardian_id"] == uid and f["tree_id"] == row.get("tree_id") for f in rows_of("tree_follows")):
            raise Refuse(400, "not a guardian of this tree")
        g = next((x for x in rows_of("guardians") if x["id"] == uid), None)
        if not g:
            raise Refuse(400, "set a nickname first")
        if not 1 <= len(row.get("body") or "") <= 500:
            raise Refuse(400, "body length")
        row["nickname"] = g["nickname"]; row["t"] = now_iso()
        recent = [m for m in rows if m["guardian_id"] == uid and datetime.fromisoformat(m["t"]) > datetime.now(timezone.utc) - timedelta(minutes=10)]
        if len(recent) >= 30:
            raise Refuse(400, "too many messages")
        SEQ["tree_messages"] += 1; row["id"] = SEQ["tree_messages"]
    else:
        raise Refuse(404, "no table")
    if conflict:
        existing = next((r for r in rows if all(str(r.get(c)) == str(row.get(c)) for c in conflict)), None)
        if existing:
            if resolution == "merge-duplicates":
                existing.update(row); return [existing]
            if resolution == "ignore-duplicates":
                return []
            raise Refuse(409, "duplicate key")
    rows.append(row)
    return [row]


def rows_of(table):
    return TABLES[table]


def delete(table, uid, query):
    if not uid:
        raise Refuse(401, "sign in first")
    filters, _, _ = parse_filters(query)
    keep, gone = [], []
    for r in TABLES[table]:
        owned = r.get("guardian_id", r.get("id")) == uid
        (gone if matches(r, filters) and owned else keep).append(r)
    TABLES[table] = keep
    if table == "tree_follows":
        pass
    return gone


# ---------- 커뮤니티(supabase/community.sql 흉내) ----------
FEED_LIMIT, FEED_DAYS, RANK_LIMIT, IDS_LIMIT, RECENT_DAYS = 50, 7, 50, 3000, 30


def period_start(period):
    now = datetime.now(KST)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return {"day": midnight, "week": midnight - timedelta(days=now.weekday()), "month": midnight.replace(day=1),
            "year": midnight.replace(month=1, day=1)}.get(period)


def _t(row, col="t"):
    return datetime.fromisoformat(row[col])


def _upper():
    return datetime.now(timezone.utc) + timedelta(minutes=5)


def _acts_since(t0):
    return [a for a in TABLES["activities"] if t0 is not None and t0 <= _t(a) <= _upper()]


def _shown(gid, uid):
    return gid == uid or PREFS.get(gid, False)


def community_rankings(uid, period, target, limit):
    g = {r["id"]: r for r in TABLES["guardians"]}
    col = {"dong": "dong", "guardian": "guardian_id", "tree": "tree_id"}.get(target)
    groups = {}
    for a in _acts_since(period_start(period)):
        k = a.get(col) if col else None
        if k is None:
            continue
        d = groups.setdefault(k, {"gs": set(), "ts": set(), "n": 0, "pts": 0, "kg": 0.0, "dongs": set()})
        d["gs"].add(a["guardian_id"]); d["ts"].add(a["tree_id"]); d["n"] += 1; d["pts"] += a["points"]; d["kg"] += a["kg"] or 0
        if a.get("dong"):
            d["dongs"].add(a["dong"])
    my_dong = g.get(uid, {}).get("dong")
    rows = []
    for k, d in groups.items():
        r = {"name": None, "tree_id": None, "species": None, "dong": None, "guardians": len(d["gs"]), "trees": len(d["ts"]),
             "activities": d["n"], "points": d["pts"], "kg": round(d["kg"], 3)}
        if target == "dong":
            r.update(name=k, dong=k, is_me=k == my_dong)
        elif target == "guardian":
            show = _shown(k, uid) and k in g
            r.update(guardians=1, name=g[k]["nickname"] if show else None, dong=g[k].get("dong") if show else None, is_me=k == uid)
        else:
            fs = sorted([f for f in TABLES["tree_follows"] if f["tree_id"] == k], key=lambda f: f["since"])
            r.update(trees=1, name=fs[0]["tree_name"] if fs else None, tree_id=k, species=next((f["species"] for f in fs if f.get("species")), None),
                     dong=max(d["dongs"]) if d["dongs"] else None, is_me=any(f["guardian_id"] == uid for f in fs))
        rows.append(r)
    key = {"tree": lambda r: (-r["activities"], -r["points"]), "guardian": lambda r: (-r["points"], -r["activities"])}.get(target, lambda r: (-r["points"], -r["guardians"]))
    rows.sort(key=key)
    prev = None
    for i, r in enumerate(rows):   # rank(): 같은 값이면 같은 순위
        if key(r) != prev:
            rank, prev = i + 1, key(r)
        r["rank"] = rank
    n = max(1, min(int(limit or 20), RANK_LIMIT))
    out = sorted([r for r in rows if r["rank"] <= n or r["is_me"]], key=lambda r: (r["rank"], r["name"] or ""))
    return out[:RANK_LIMIT + 10]


def community_stats():
    first = {}   # 나무마다 첫 친구 맺기 시각
    for f in TABLES["tree_follows"]:
        first[f["tree_id"]] = min(first.get(f["tree_id"], _t(f, "since")), _t(f, "since"))
    out = []
    for p in ("day", "week"):
        t0 = period_start(p)
        acts = _acts_since(t0)
        out.append({"period": p, "since": t0.isoformat(),
                    "new_trees": sum(1 for s in first.values() if t0 <= s <= _upper()),
                    "active_guardians": len({a["guardian_id"] for a in acts}), "activities": len(acts),
                    "kg": round(sum(a["kg"] or 0 for a in acts), 3),
                    "total_trees": len({f["tree_id"] for f in TABLES["tree_follows"]}), "total_guardians": len(TABLES["guardians"])})
    return out


def community_feed(uid, limit):
    g = {r["id"]: r for r in TABLES["guardians"]}
    now = datetime.now(timezone.utc)
    rows = [a for a in TABLES["activities"] if now - timedelta(days=FEED_DAYS) < _t(a) <= _upper() and a["guardian_id"] in g]
    rows.sort(key=lambda a: (_t(a), a["id"]), reverse=True)
    out = []
    for a in rows[:max(1, min(int(limit or 30), FEED_LIMIT))]:
        f = next((f for f in TABLES["tree_follows"] if f["guardian_id"] == a["guardian_id"] and f["tree_id"] == a["tree_id"]), None)
        out.append({"t": _t(a).replace(second=0, microsecond=0).isoformat(), "dong": a.get("dong"), "activity": a["activity"],
                    "label": CATALOG[a["activity"]]["label"], "kind": a["kind"], "tree_name": f["tree_name"] if f else None,
                    "nickname": g[a["guardian_id"]]["nickname"] if _shown(a["guardian_id"], uid) else None, "is_me": a["guardian_id"] == uid})
    return out


def community_trees_in_view(uid, ids):
    want = set((ids or [])[:IDS_LIMIT])
    now = datetime.now(timezone.utc)
    by = {}
    for f in TABLES["tree_follows"]:
        if f["tree_id"] in want:
            by.setdefault(f["tree_id"], []).append(f)
    out = []
    for tid, fs in by.items():
        others = sum(1 for f in fs if f["guardian_id"] != uid)
        if not others:
            continue
        acts = [a for a in TABLES["activities"] if a["tree_id"] == tid and _t(a) <= _upper()]
        last = max((_t(a).astimezone(KST).date() for a in acts), default=None)
        out.append({"tree_id": tid, "guardians": len(fs), "others": others, "last_day": last.isoformat() if last else None,
                    "recent": sum(1 for a in acts if _t(a) > now - timedelta(days=RECENT_DAYS)), "is_mine": any(f["guardian_id"] == uid for f in fs)})
    return out


def community_rpc(name, body, uid):
    if not STATE["community"]:
        raise Refuse(404, f"Could not find the function public.{name}")
    if not uid:
        raise Refuse(401, f"permission denied for function {name}")
    if name == "community_prefs":
        return PREFS.get(uid, False)
    if name == "community_set_prefs":
        if not any(g["id"] == uid for g in TABLES["guardians"]):
            raise Refuse(400, "join first")
        PREFS[uid] = bool(body.get("p_show_nickname"))
        return PREFS[uid]
    if name == "community_rankings":
        return community_rankings(uid, body.get("p_period", "week"), body.get("p_target", "dong"), body.get("p_limit", 20))
    if name == "community_stats":
        return community_stats()
    if name == "community_feed":
        return community_feed(uid, body.get("p_limit", 30))
    if name == "community_trees_in_view":
        return community_trees_in_view(uid, body.get("p_ids"))
    raise Refuse(404, f"Could not find the function public.{name}")


# ---------- 연구4 ----------
def submit(pid, record):
    if not pid or not PID.match(pid):
        raise ValueError("invalid pid")
    if record.get("pid") != pid:
        raise ValueError("pid mismatch")
    if not str(record.get("study_id", "")).startswith("research4-"):
        raise ValueError("unknown study")
    if record.get("condition") not in CONDITIONS:
        raise ValueError("invalid condition")
    if len(json.dumps(record)) > 65536:
        raise ValueError("record too large")
    status = record.get("status") or "started"
    now = now_iso()
    row = ROWS.get(pid)
    if row is None:
        ROWS[pid] = {"pid": pid, "study_id": record["study_id"], "condition": record["condition"], "status": status,
                     "record": record, "created_at": now, "updated_at": now,
                     "completed_at": now if status == "complete" else None}
    elif row["status"] != "complete":  # 완료된 응답은 덮어쓰지 않는다
        row.update(record=record, status=status, updated_at=now,
                   completed_at=row["completed_at"] or (now if status == "complete" else None))
    return "ok"


def counts(study_id):
    groups = {}
    for r in ROWS.values():
        if r["study_id"] != study_id:
            continue
        status = r["status"] if r["status"] in ("complete", "handoff") else "in_progress"
        g = groups.setdefault((r["condition"], status), {"n": 0, "att": 0, "exp": []})
        g["n"] += 1
        g["att"] += 1 if r["record"].get("attention_ok") is True else 0
        if r["record"].get("stimulus_ms") is not None:
            g["exp"].append(r["record"]["stimulus_ms"])
    return [{"condition": c, "status": s, "n": g["n"], "attention_ok": g["att"],
             "avg_exposure_sec": round(sum(g["exp"]) / len(g["exp"]) / 1000, 1) if g["exp"] else None}
            for (c, s), g in sorted(groups.items())]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "apikey, authorization, content-type, prefer")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _uid(self):
        auth = self.headers.get("Authorization") or ""
        return USERS.get(auth.replace("Bearer ", "").strip())

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/__mock/rows":
            return self._send(200, {"study": list(ROWS.values()), **TABLES})
        if url.path.startswith("/rest/v1/"):
            return self._rest("GET", url)
        self._send(404, {"message": "not found"})

    def do_PATCH(self):
        self._rest("PATCH", urlparse(self.path))

    def do_DELETE(self):
        self._rest("DELETE", urlparse(self.path))

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/__mock/fail":
            STATE["fail"] = parse_qs(url.query).get("on", ["1"])[0] == "1"
            return self._send(200, STATE)
        if url.path == "/__mock/community":
            STATE["community"] = parse_qs(url.query).get("on", ["1"])[0] == "1"
            return self._send(200, STATE)
        if url.path == "/__mock/reset":
            reset_sns(); ROWS.clear()
            return self._send(200, {"ok": True})
        if not self.headers.get("apikey"):
            return self._send(401, {"message": "No API key found in request"})
        if STATE["fail"]:
            return self._send(503, {"message": "mock failure"})
        if url.path.startswith("/auth/v1/"):
            body = self._body()
            try:
                if url.path == "/auth/v1/signup":
                    return self._send(200, anon_signup())
                if url.path == "/auth/v1/token" and parse_qs(url.query).get("grant_type") == ["refresh_token"]:
                    return self._send(200, refresh(body.get("refresh_token")))
            except Refuse as err:
                return self._send(err.status, {"error": "invalid_grant", "error_description": str(err)})
            return self._send(404, {"message": "auth route not found"})
        if url.path.startswith("/rest/v1/rpc/"):
            body = self._body()
            name = url.path.rsplit("/", 1)[-1]
            if name.startswith("community_"):
                try:
                    return self._send(200, community_rpc(name, body, self._uid()))
                except Refuse as err:
                    code = {404: "PGRST202", 401: "42501"}.get(err.status, "P0001")
                    return self._send(err.status, {"code": code, "message": str(err)})
            try:
                if name == "submit_study_record":
                    return self._send(200, submit(body.get("p_pid"), body.get("p_record") or {}))
                if name == "study_counts":
                    return self._send(200, counts(body.get("p_study_id")))
            except ValueError as err:
                return self._send(400, {"code": "P0001", "message": str(err)})
            return self._send(404, {"message": f"function {name} not found"})
        if url.path.startswith("/rest/v1/"):
            return self._rest("POST", url)
        self._send(404, {"message": "not found"})

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _rest(self, method, url):
        if not self.headers.get("apikey"):
            return self._send(401, {"message": "No API key found in request"})
        if STATE["fail"]:
            return self._send(503, {"message": "mock failure"})
        table = url.path[len("/rest/v1/"):]
        query = parse_qs(url.query)
        uid = self._uid()
        prefer = self.headers.get("Prefer") or ""
        try:
            if method == "GET":
                v = views(uid)
                if table in v:
                    rows = v[table]
                elif table in TABLES:
                    if not uid:
                        raise Refuse(401, "sign in first")
                    rows = TABLES[table]
                else:
                    raise Refuse(404, f"relation {table} does not exist")
                return self._send(200, apply(rows, query))
            if method == "POST":
                if table not in TABLES:
                    raise Refuse(404, f"relation {table} does not exist")
                out = insert(table, self._body(), uid, query, prefer)
                return self._send(201, out if "return=representation" in prefer else None)
            if method == "DELETE":
                if table not in TABLES:
                    raise Refuse(404, f"relation {table} does not exist")
                out = delete(table, uid, query)
                return self._send(200 if "return=representation" in prefer else 204, out if "return=representation" in prefer else None)
            raise Refuse(405, "method not supported by mock")
        except Refuse as err:
            return self._send(err.status, {"code": "P0001", "message": str(err)})

    def log_message(self, fmt, *args):
        sys.stderr.write("mock-supabase " + fmt % args + "\n")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(args[0]) if args else 8791
    print(f"mock supabase on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
