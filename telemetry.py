"""Persistent workflow execution history."""
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
                      finished_at=CURRENT_TIMESTAMP WHERE id=?""", (status, error, execution))
