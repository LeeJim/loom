"""Persistent workflow execution history."""
from contextlib import contextmanager
from contextvars import ContextVar
import json
import re

_context = ContextVar("workflow_telemetry", default=None)
_sensitive_key = re.compile(r"(?i)(token|secret|password|authorization|api[_ -]?key|private[_ -]?key)")
_secret = re.compile(
    r"(?i)bearer\s+[^\s,;]+|gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+"
    r"|sk-[a-z0-9_-]{12,}|-----BEGIN [^-]+ PRIVATE KEY-----.*?-----END [^-]+ PRIVATE KEY-----"
    r"""|(?:authorization|token|secret|password|api[_ -]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)""",
    re.DOTALL,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS workflow_executions (
    id INTEGER PRIMARY KEY, issue_number INTEGER NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS workflow_stage_events (
    id INTEGER PRIMARY KEY, execution_id INTEGER NOT NULL REFERENCES workflow_executions(id),
    stage TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS workflow_executions_issue ON workflow_executions(issue_number, id);
CREATE INDEX IF NOT EXISTS workflow_stage_execution ON workflow_stage_events(execution_id, id);
CREATE TABLE IF NOT EXISTS workflow_artifacts (
    id INTEGER PRIMARY KEY,
    execution_id INTEGER NOT NULL REFERENCES workflow_executions(id),
    stage TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('input','output')),
    payload TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS workflow_artifacts_execution ON workflow_artifacts(execution_id,id);
CREATE TABLE IF NOT EXISTS worker_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id=1), checked_at TEXT NOT NULL
);
"""


def initialize(db):
    db.executescript(SCHEMA)
    with db:
        db.execute("""UPDATE workflow_executions SET status='interrupted',
                      finished_at=CURRENT_TIMESTAMP WHERE status='running'""")


def heartbeat(db):
    with db:
        db.execute("""INSERT INTO worker_heartbeat VALUES(1,CURRENT_TIMESTAMP)
                      ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at""")


def start(db, issue, kind):
    with db:
        return db.execute("INSERT INTO workflow_executions(issue_number,kind) VALUES(?,?)",
                          (issue, kind)).lastrowid


def mark(db, execution, stage):
    with db:
        db.execute("INSERT INTO workflow_stage_events(execution_id,stage) VALUES(?,?)", (execution, stage))


def finish(db, execution, status, error=None):
    with db:
        db.execute("""UPDATE workflow_executions SET status=?, error=?,
                      finished_at=CURRENT_TIMESTAMP WHERE id=?""", (status, _sanitize(error), execution))


def _sanitize(value, depth=0):
    if depth >= 8:
        return "[omitted]"
    if isinstance(value, dict):
        return {
            str(key)[:100]: "[redacted]" if _sensitive_key.search(str(key)) else _sanitize(item, depth + 1)
            for key, item in list(value.items())[:80]
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize(item, depth + 1) for item in value[:80]]
    if not isinstance(value, str):
        return value
    cleaned = _secret.sub("[redacted]", value)
    return cleaned[:8192] + (" [truncated]" if len(cleaned) > 8192 else "")


@contextmanager
def capture(db, execution):
    token = _context.set((db, execution))
    try:
        yield
    finally:
        _context.reset(token)


def record(stage, direction, **payload):
    context = _context.get()
    if context is None:
        return
    db, execution = context
    detail = json.dumps(_sanitize(payload), ensure_ascii=False)
    if len(detail) > 32768:
        detail = json.dumps({"preview": detail[:8192], "truncated": True}, ensure_ascii=False)
    db.execute("INSERT INTO workflow_artifacts(execution_id,stage,direction,payload) VALUES(?,?,?,?)",
               (execution, stage, direction, detail))
    db.commit()


def timeline(db, execution):
    rows = db.execute("""SELECT e.id,e.issue_number,e.kind,e.status,e.started_at,e.finished_at,
                                e.error
                         FROM workflow_executions e WHERE e.id=?""", (execution,)).fetchone()
    if rows is None:
        return None
    fields = ("id", "issue_number", "kind", "status", "started_at", "finished_at", "error")
    result = dict(zip(fields, rows))
    result["stages"] = [
        {"id": ident, "stage": stage, "recorded_at": timestamp}
        for ident, stage, timestamp in db.execute(
            "SELECT id,stage,recorded_at FROM workflow_stage_events WHERE execution_id=? ORDER BY id", (execution,))
    ]
    result["artifacts"] = [
        {"id": ident, "stage": stage, "direction": direction, "payload": json.loads(payload),
         "recorded_at": timestamp}
        for ident, stage, direction, payload, timestamp in db.execute(
            """SELECT id,stage,direction,payload,recorded_at FROM workflow_artifacts
               WHERE execution_id=? ORDER BY id""", (execution,))
    ]
    return result


def audit(db, execution=None):
    """Derive review suggestions from recorded evidence."""
    findings = []
    repairs = db.execute("""
        SELECT execution_id, count(*) FROM workflow_stage_events
        WHERE stage='Repair' AND (? IS NULL OR execution_id=?)
        GROUP BY execution_id ORDER BY execution_id DESC LIMIT 30
    """, (execution, execution))
    for ident, count in repairs:
        findings.append({"execution_id": ident, "stage": "Repair", "evidence": {"retries": count},
                         "suggestion": "Review the validation failures and clarify acceptance criteria before coding."})
    slow_stages = db.execute("""
        WITH spans AS (
            SELECT execution_id,id,stage, recorded_at,
                   lead(recorded_at) OVER (PARTITION BY execution_id ORDER BY id) AS next_at
            FROM workflow_stage_events WHERE (? IS NULL OR execution_id=?)
        )
        SELECT execution_id,id,stage,
               CAST(ROUND((julianday(next_at)-julianday(recorded_at))*86400) AS INTEGER) AS seconds
        FROM spans WHERE next_at IS NOT NULL AND stage IN ('Coding','Validation','Repair','Review')
        AND seconds >= 60 ORDER BY seconds DESC LIMIT 20
    """, (execution, execution))
    for ident, event, stage, seconds in slow_stages:
        findings.append({"execution_id": ident, "stage": stage,
                         "evidence": {"stage_event_id": event, "elapsed_seconds": seconds},
                         "suggestion": "Inspect the stage inputs and outputs to identify what consumed the execution time."})
    failures = db.execute("""
        SELECT a.execution_id,a.id,a.stage,a.payload FROM workflow_artifacts a
        WHERE a.direction='output' AND json_extract(a.payload,'$.result') IN ('failed','error')
          AND (? IS NULL OR a.execution_id=?)
        ORDER BY a.id DESC LIMIT 20
    """, (execution, execution))
    for ident, artifact, stage, payload in failures:
        evidence = {"artifact_id": artifact, "error": json.loads(payload).get("error")}
        findings.append({"execution_id": ident, "stage": stage, "evidence": evidence,
                         "suggestion": "Inspect the recorded failure and check whether an earlier validation could catch it."})
    return findings
