"""Loopback operations console, also served through authenticated Caddy."""
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit

ASSETS = Path(__file__).resolve().parent
DB = Path(os.environ.get("AI_NATIVE_DB", "/opt/ai-native/data/workflow.sqlite"))


def snapshot():
    with closing(sqlite3.connect(DB.resolve().as_uri() + "?mode=ro", uri=True, timeout=3)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")

        def rows(sql):
            return [dict(row) for row in db.execute(sql)]

        return {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "metrics": rows("""SELECT (SELECT COUNT(*) FROM jobs) AS issues,
                (SELECT COUNT(*) FROM jobs WHERE stage='Delivery') AS delivered,
                (SELECT COUNT(*) FROM workflow_executions) AS executions,
                (SELECT COUNT(*) FROM workflow_executions WHERE status='running') AS running,
                (SELECT COUNT(*) FROM workflow_executions WHERE status='failed') AS failed,
                (SELECT COUNT(*) FROM workflow_stage_events WHERE stage='Repair') AS repairs,
                (SELECT COUNT(*) FROM ci_validation_attempts) AS ci_callbacks,
                (SELECT checked_at FROM worker_heartbeat WHERE id=1) AS heartbeat""")[0],
            "stages": rows("SELECT stage, COUNT(*) AS count FROM jobs GROUP BY stage"),
            "jobs": rows("""
                SELECT j.number, j.title, j.stage, j.repair_count, j.last_error,
                       pr.pr_number, p.status AS publication_status, p.error AS publication_error,
                       COALESCE(pa.approved,0) AS publish_approved, manual.status AS manual_status,
                       plan.comment_url AS plan_comment_url, plan.state AS plan_state, plan.error AS plan_error,
                       (profile.issue_number IS NOT NULL AND pr.pr_number IS NULL
                        AND p.issue_number IS NULL AND COALESCE(pa.approved,0)=0
                        AND COALESCE(manual.status,'') NOT IN ('queued','running','awaiting_plan')
                        AND (j.stage!='AwaitingApproval' OR plan.error IS NOT NULL)
                        AND NOT EXISTS (SELECT 1 FROM workflow_executions e
                                       WHERE e.issue_number=j.number AND e.status='running')) AS manual_allowed,
                       (SELECT COUNT(*) FROM workflow_executions e WHERE e.issue_number=j.number) AS executions,
                       ci.run_id, COALESCE(a.conclusion,ci.conclusion) AS ci_conclusion, a.attempt
                FROM jobs j LEFT JOIN pr_deliveries pr ON pr.issue_number=j.number
                LEFT JOIN publications p ON p.issue_number=j.number
                LEFT JOIN publication_approvals pa ON pa.issue_number=j.number
                LEFT JOIN worker_profiles profile ON profile.issue_number=j.number
                LEFT JOIN manual_runs manual ON manual.issue_number=j.number
                LEFT JOIN issue_plans plan ON plan.issue_number=j.number
                LEFT JOIN ci_validations ci ON ci.run_id=(
                    SELECT MAX(run_id) FROM ci_validations WHERE issue_number=j.number)
                LEFT JOIN ci_validation_attempts a ON a.run_id=ci.run_id AND a.attempt=(
                    SELECT MAX(attempt) FROM ci_validation_attempts WHERE run_id=ci.run_id)
                ORDER BY j.number DESC LIMIT 100
            """),
            "executions": rows("""
                SELECT e.id,e.issue_number,e.kind,e.status,e.started_at,e.finished_at,e.error,
                    (SELECT s.stage FROM workflow_stage_events s WHERE s.execution_id=e.id
                     ORDER BY s.id DESC LIMIT 1) AS stage
                FROM workflow_executions e ORDER BY e.id DESC LIMIT 30
            """),
            "events": rows("""
                SELECT s.execution_id, e.issue_number,s.stage,s.recorded_at
                FROM workflow_stage_events s JOIN workflow_executions e ON e.id=s.execution_id
                ORDER BY s.id DESC LIMIT 250
            """),
            "repairs": rows("""
                SELECT r.run_id, c.issue_number, r.attempt, r.status, r.error, r.patch_path
                FROM ci_repairs r JOIN ci_validations c ON c.run_id=r.run_id
                ORDER BY r.run_id DESC LIMIT 12
            """),
            "ci": rows("""
                SELECT a.run_id, a.attempt, c.issue_number, a.conclusion, a.recorded_at
                FROM ci_validation_attempts a JOIN ci_validations c ON c.run_id=a.run_id
                ORDER BY a.recorded_at DESC, a.attempt DESC LIMIT 12
            """),
        }


class Handler(BaseHTTPRequestHandler):
    def expected_origin(self):
        host = self.headers.get("Host", "")
        hostname = host.partition(":")[0]
        if hostname in {"127.0.0.1", "localhost"}:
            return f"http://{host}"
        if host == "ai.anyhub.cn":
            return f"https://{host}"
        return None

    def send_body(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
                         "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self.expected_origin() is None:
            self.send_body(403, "text/plain; charset=utf-8", b"Forbidden")
            return
        path = urlsplit(self.path).path
        if path == "/api/snapshot":
            try:
                body = json.dumps(snapshot(), ensure_ascii=False).encode()
            except sqlite3.Error:
                self.send_body(503, "application/json", b'{"error":"Workflow database unavailable"}')
                return
            self.send_body(200, "application/json; charset=utf-8", body)
            return
        asset = {
            "/": ("index.html", "text/html"),
            "/app.js": ("app.js", "text/javascript"),
            "/style.css": ("style.css", "text/css"),
        }.get(path)
        if asset is None:
            self.send_body(404, "text/plain; charset=utf-8", b"Not found")
            return
        self.send_body(200, asset[1] + "; charset=utf-8", (ASSETS / asset[0]).read_bytes())

    do_HEAD = do_GET

    def do_POST(self):
        if urlsplit(self.path).path != "/api/run":
            self.respond(404, "not_found")
            return
        origin = self.expected_origin()
        if origin is None or self.headers.get("Origin") != origin:
            self.respond(403, "invalid_origin")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 128 or self.headers.get_content_type() != "application/json":
                raise ValueError("Invalid request")
            body = json.loads(self.rfile.read(length))
            number = body.get("issue") if isinstance(body, dict) else None
            if type(number) is not int or not 0 < number < 2**53:
                raise ValueError("Invalid Issue number")
        except (UnicodeError, ValueError):
            self.respond(400, "invalid_request")
            return
        try:
            with closing(sqlite3.connect(DB.resolve().as_uri() + "?mode=rw", uri=True, timeout=3)) as db, db:
                db.execute("BEGIN IMMEDIATE")
                changes = db.execute("""
                    INSERT INTO manual_runs(issue_number,status)
                    SELECT j.number,'queued' FROM jobs j
                    JOIN worker_profiles profile ON profile.issue_number=j.number
                    WHERE j.number=?
                      AND NOT EXISTS (SELECT 1 FROM pr_deliveries WHERE issue_number=j.number)
                      AND NOT EXISTS (SELECT 1 FROM publications WHERE issue_number=j.number)
                      AND NOT EXISTS (SELECT 1 FROM publication_approvals
                                      WHERE issue_number=j.number AND approved=1)
                      AND (j.stage!='AwaitingApproval' OR EXISTS (
                           SELECT 1 FROM issue_plans WHERE issue_number=j.number AND error IS NOT NULL))
                      AND NOT EXISTS (SELECT 1 FROM workflow_executions
                                      WHERE issue_number=j.number AND status='running')
                    ON CONFLICT(issue_number) DO UPDATE SET status='queued', requested_at=CURRENT_TIMESTAMP
                    WHERE manual_runs.status NOT IN ('queued','running','awaiting_plan')
                """, (number,)).rowcount
        except sqlite3.Error:
            self.respond(503, "unavailable")
            return
        if changes:
            self.respond(202, "queued")
        else:
            self.respond(409, "not_runnable")

    def respond(self, status, code):
        self.send_body(status, "application/json", json.dumps({"status": code}).encode())


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("AI_NATIVE_CONSOLE_PORT", "8790"))), Handler).serve_forever()
