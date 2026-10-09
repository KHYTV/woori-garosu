"""개발용 가짜 Supabase(RPC만). supabase/study_schema.sql의 두 함수와 같은 규칙으로 동작한다.

  python tests/mock_supabase.py 8791
  → http://localhost:8790/study/?backend=http://localhost:8791&backendkey=test

  GET  /__mock/rows        저장된 응답 보기
  POST /__mock/fail?on=1   전송 실패(503) 흉내 켜기, on=0이면 끄기
"""

import json
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PID = re.compile(r"^[A-Z2-9]{8}$")
CONDITIONS = {"text", "image", "immersive"}
ROWS: dict[str, dict] = {}
STATE = {"fail": False}


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
    now = datetime.now(timezone.utc).isoformat()
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
        self.send_header("Access-Control-Allow-Headers", "apikey, authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        if urlparse(self.path).path == "/__mock/rows":
            return self._send(200, list(ROWS.values()))
        self._send(404, {"message": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if url.path == "/__mock/fail":
            STATE["fail"] = parse_qs(url.query).get("on", ["1"])[0] == "1"
            return self._send(200, STATE)
        if not url.path.startswith("/rest/v1/rpc/"):
            return self._send(404, {"message": "not found"})
        if not self.headers.get("apikey"):
            return self._send(401, {"message": "No API key found in request"})
        if STATE["fail"]:
            return self._send(503, {"message": "mock failure"})
        name = url.path.rsplit("/", 1)[-1]
        try:
            if name == "submit_study_record":
                return self._send(200, submit(body.get("p_pid"), body.get("p_record") or {}))
            if name == "study_counts":
                return self._send(200, counts(body.get("p_study_id")))
        except ValueError as err:
            return self._send(400, {"code": "P0001", "message": str(err)})
        self._send(404, {"message": f"function {name} not found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("mock-supabase " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    print(f"mock supabase on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
