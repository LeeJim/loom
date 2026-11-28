"""Persist and bound failures in the legacy plan review loop."""
from datetime import timezone
from email.utils import parsedate_to_datetime
from random import uniform
import re
import time
from urllib.error import HTTPError, URLError

from github_app import MissingIssueWritePermission

SCHEMA = """
CREATE TABLE IF NOT EXISTS plan_retry_state (
    issue_number INTEGER PRIMARY KEY,
    version TEXT NOT NULL, operation TEXT NOT NULL,
    attempts INTEGER NOT NULL, started_at INTEGER NOT NULL,
    retry_at INTEGER, reason TEXT NOT NULL, http_status INTEGER,
    request_id TEXT, state TEXT NOT NULL CHECK(state IN ('retrying','stopped'))
)
"""
MAX_ATTEMPTS = 6
MAX_WINDOW = 30 * 60


def _seconds(value):
    if value and re.fullmatch(r"[0-9]{1,12}", value):
        return int(value)
    return None


def _server_time(headers, now):
    after = headers.get("Retry-After")
    delay = _seconds(after)
    eligible = now + delay if delay is not None else None
    if after and eligible is None:
        try:
            parsed = parsedate_to_datetime(after)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            eligible = int(parsed.timestamp())
        except (ValueError, TypeError, OverflowError):
            pass
    if headers.get("X-RateLimit-Remaining") == "0":
        reset = _seconds(headers.get("X-RateLimit-Reset"))
        if reset is not None:
            eligible = max(eligible or now, reset)
    return eligible


def classify(error, now):
    """Return a safe reason, status, request ID, and earliest server retry time."""
    if isinstance(error, HTTPError):
        status = error.code
        headers = error.headers or {}
        server_time = _server_time(headers, now)
        raw_id = headers.get("X-GitHub-Request-Id", "")
        request_id = raw_id if re.fullmatch(r"[A-Za-z0-9:-]{1,100}", raw_id) else None
        if status == 429 or (status == 403 and server_time is not None):
            reason = "rate_limited"
        elif status == 401:
            reason = "authentication"
        elif status == 403:
            reason = "forbidden"
        elif status in {408, 425} or 500 <= status <= 599:
            reason = "temporary_http"
        else:
            reason = "http_rejected"
        return reason, status, request_id, server_time
    if isinstance(error, (URLError, TimeoutError, ConnectionError)):
        return "network", None, None, None
    if isinstance(error, MissingIssueWritePermission):
        return "issues_write_required", None, None, None
    return "operation_error", None, None, None


def current_plan(db, issue):
    row = db.execute("SELECT plan_id,state FROM issue_plans WHERE issue_number=?", (issue,)).fetchone()
    if row is None:
        return "", "prepare_plan"
    return row[0], "post_plan" if row[1] == "posting" else "review_plan"


def eligible(db, issue, now=None):
    now = int(time.time()) if now is None else now
    row = db.execute("SELECT version,operation,state,retry_at,started_at FROM plan_retry_state WHERE issue_number=?",
                     (issue,)).fetchone()
    if row is None or row[:2] != current_plan(db, issue):
        return True
    if row[2] == "stopped":
        return False
    if now >= row[4] + MAX_WINDOW:
        with db:
            db.execute("UPDATE plan_retry_state SET state='stopped',retry_at=NULL,reason='retry_window_expired' WHERE issue_number=?",
                       (issue,))
            stop(db, issue, f"{row[1]}: retry_window_expired")
        print(f"Issue #{issue}: {row[1]} stopped (retry_window_expired)", flush=True)
        return False
    return row[3] <= now


def stop(db, issue, summary):
    db.execute("UPDATE jobs SET stage='Stopped',last_error=? WHERE number=?", (summary, issue))
    db.execute("UPDATE manual_runs SET status='failed' WHERE issue_number=? AND status='awaiting_plan'", (issue,))


def clear(db, issue):
    db.execute("DELETE FROM plan_retry_state WHERE issue_number=?", (issue,))


def record_failure(db, issue, error, *, now=None):
    now = int(time.time()) if now is None else now
    version, operation = current_plan(db, issue)
    reason, status, request_id, server_time = classify(error, now)
    previous = db.execute("""
        SELECT attempts,started_at FROM plan_retry_state
        WHERE issue_number=? AND version=? AND operation=?
    """, (issue, version, operation)).fetchone()
    attempts, started = previous or (0, now)
    attempts += 1
    allow = reason in {"network", "rate_limited", "temporary_http"} or (reason == "authentication" and attempts == 1)
    # The authentication retry mints a fresh token on the next review.
    delay = min(900, 30 * 2 ** min(attempts - 1, 5))
    next_time = max(server_time or now, now + round(uniform(delay, min(900, delay * 1.2))))
    retry_at = next_time if allow and attempts < MAX_ATTEMPTS and next_time < started + MAX_WINDOW else None
    state = "retrying" if retry_at is not None else "stopped"
    summary = f"{operation}: {reason}" + (f" (HTTP {status})" if status is not None else "")
    with db:
        db.execute("""
            INSERT INTO plan_retry_state(issue_number,version,operation,attempts,started_at,retry_at,reason,http_status,request_id,state)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(issue_number) DO UPDATE SET version=excluded.version,operation=excluded.operation,
              attempts=excluded.attempts,started_at=excluded.started_at,retry_at=excluded.retry_at,reason=excluded.reason,
              http_status=excluded.http_status,request_id=excluded.request_id,state=excluded.state
        """, (issue, version, operation, attempts, started, retry_at, reason, status, request_id, state))
        db.execute("UPDATE issue_plans SET error=?,next_check=? WHERE issue_number=?",
                   (summary, retry_at or 0, issue))
        if state == "stopped":
            stop(db, issue, summary)
    return {"operation": operation, "attempt": attempts, "state": state, "retry_at": retry_at,
            "reason": reason, "http_status": status, "request_id": request_id}
