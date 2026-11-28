"""Persistent worker ownership and exclusive Issue claims for the supervisor."""
from contextlib import contextmanager
import json
import re
import sqlite3

from capabilities import require_model, skill_files
from uuid import uuid4

SCHEMA = """
CREATE TABLE IF NOT EXISTS loom_workers (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, name TEXT NOT NULL,
    issue_number INTEGER, model TEXT, skills TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','paused','draining')),
    last_seen_at TEXT, UNIQUE(owner_id, name)
);
CREATE TABLE IF NOT EXISTS loom_issue_claims (
    issue_number INTEGER PRIMARY KEY, worker_id TEXT NOT NULL UNIQUE,
    claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS loom_worker_actions (
    id INTEGER PRIMARY KEY, worker_id TEXT NOT NULL, actor_id INTEGER NOT NULL,
    action TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""
SELECT_WORKERS = """
SELECT w.id, w.owner_id, w.name, w.issue_number, w.model, w.skills,
       w.state, c.issue_number AS active_issue, w.last_seen_at
FROM loom_workers w LEFT JOIN loom_issue_claims c ON c.worker_id=w.id
"""
MAX_WORKERS_PER_OWNER = 16


@contextmanager
def transaction(db):
    db.execute("BEGIN IMMEDIATE")
    with db:
        yield


def initialize(db):
    db.executescript(SCHEMA)


def worker_dict(row):
    return {
        "id": row[0], "owner_id": row[1], "name": row[2], "issue_number": row[3],
        "model": row[4], "skills": json.loads(row[5]), "state": row[6],
        "active_issue": row[7], "last_seen_at": row[8],
    }


def list_workers(db, owner_id):
    return [worker_dict(row) for row in db.execute(
        SELECT_WORKERS + " WHERE w.owner_id=? ORDER BY w.name", (owner_id,)
    )]


def create_worker(db, owner_id, name, issue_number=None, model=None, skills=()):
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64:
        raise ValueError("Worker name must contain 1–64 characters")
    if issue_number is not None and (type(issue_number) is not int or not 0 < issue_number < 2**53):
        raise ValueError("Invalid Issue number")
    if model is not None and (not isinstance(model, str) or not re.fullmatch(r"[a-zA-Z0-9._:/-]{1,128}", model)):
        raise ValueError("Invalid model identifier")
    if not isinstance(skills, (tuple, list)) or len(skills) > 16:
        raise ValueError("Invalid skill selection")
    require_model(model)
    resolved_skills = skill_files(skills)
    if len({name for name, _version, _path in resolved_skills}) != len(resolved_skills):
        raise ValueError("Select only one version per skill")
    skills = [{"id": name, "version": version} for name, version, _ in resolved_skills]
    worker_id = uuid4().hex
    try:
        with transaction(db):
            count = db.execute("SELECT count(*) FROM loom_workers WHERE owner_id=?", (owner_id,)).fetchone()[0]
            if count >= MAX_WORKERS_PER_OWNER:
                raise ValueError("Worker limit reached")
            if issue_number is not None and not db.execute(
                "SELECT 1 FROM worker_profiles WHERE issue_number=?", (issue_number,)
            ).fetchone():
                raise ValueError("Issue has no execution profile")
            db.execute("INSERT INTO loom_workers VALUES(?,?,?,?,?,?,'paused',NULL)",
                       (worker_id, owner_id, name.strip(), issue_number, model, json.dumps(skills)))
            db.execute("INSERT INTO loom_worker_actions(worker_id,actor_id,action) VALUES(?,?,'created')",
                       (worker_id, owner_id))
            return worker_dict(db.execute(SELECT_WORKERS + " WHERE w.id=?", (worker_id,)).fetchone())
    except sqlite3.IntegrityError as error:
        raise ValueError("Worker name is already in use") from error


def set_worker_state(db, owner_id, worker_id, state):
    if state not in {"running", "paused", "draining"}:
        raise ValueError("Invalid worker state")
    with transaction(db):
        updated = db.execute("UPDATE loom_workers SET state=? WHERE owner_id=? AND id=?",
                             (state, owner_id, worker_id))
        if not updated.rowcount:
            return None
        db.execute("INSERT INTO loom_worker_actions(worker_id,actor_id,action) VALUES(?,?,?)",
                   (worker_id, owner_id, state))
        if state == "draining":
            db.execute("UPDATE loom_workers SET state='paused' WHERE id=? AND NOT EXISTS "
                       "(SELECT 1 FROM loom_issue_claims WHERE worker_id=?)", (worker_id, worker_id))
        return worker_dict(db.execute(SELECT_WORKERS + " WHERE w.id=?", (worker_id,)).fetchone())


def runnable_workers(db):
    workers = [worker_dict(row) for row in db.execute(
        SELECT_WORKERS + " WHERE w.state='running' ORDER BY w.last_seen_at, w.id"
    )]
    if not workers and not db.execute("SELECT 1 FROM loom_workers").fetchone():
        return [{"id": "system", "issue_number": None, "model": None, "skills": []}]
    return workers


def recover_claims(db):
    """Called only after taking the supervisor's process lock."""
    with transaction(db):
        db.execute("DELETE FROM loom_issue_claims")
        db.execute("UPDATE loom_workers SET state='paused' WHERE state='draining'")


def claim(db, worker_id, issue):
    with transaction(db):
        if worker_id == "system":
            allowed = not db.execute(
                "SELECT 1 FROM loom_workers"
            ).fetchone()
        else:
            allowed = db.execute(
                "SELECT 1 FROM loom_workers WHERE id=? AND state='running' "
                "AND (issue_number IS NULL OR issue_number=?)", (worker_id, issue)
            ).fetchone()
        if not allowed:
            return False
        result = db.execute("INSERT OR IGNORE INTO loom_issue_claims(issue_number,worker_id) VALUES(?,?)",
                            (issue, worker_id))
        if result.rowcount:
            db.execute("UPDATE loom_workers SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?", (worker_id,))
        return bool(result.rowcount)


def release(db, worker_id, issue):
    with transaction(db):
        db.execute("DELETE FROM loom_issue_claims WHERE worker_id=? AND issue_number=?", (worker_id, issue))
        db.execute("UPDATE loom_workers SET state='paused' WHERE id=? AND state='draining'", (worker_id,))
