"""Claim approved SQLite jobs under the same lock as manual execution."""
import argparse
import fcntl
from functools import partial
import json
import os
from pathlib import Path
import sqlite3
import time

from run_docs import ROOT, check_paths, run
from publish import publish
from github_app import DEFAULT_CONFIG
import telemetry
import plans


def run_next(db, handlers, allowed_files, app_config):
    """Run a fresh or interrupted job. The caller holds the worker lock."""
    for number, handler in handlers.items():
        row = db.execute(
            "SELECT stage, last_error FROM jobs WHERE number=?", (number,)
        ).fetchone()
        if row is None or row[0] == "Delivery" or row[1] is not None:
            continue
        try:
            approval = plans.review(db, number, allowed_files[number], app_config)
        except Exception as error:
            with db:
                status = db.execute("SELECT 1 FROM issue_plans WHERE issue_number=?", (number,)).fetchone()
                if status:
                    db.execute("UPDATE issue_plans SET error=?,next_check=? WHERE issue_number=?",
                               (type(error).__name__, int(time.time()) + 60, number))
                else:
                    db.execute("UPDATE jobs SET last_error=? WHERE number=?", (type(error).__name__, number))
                    db.execute("UPDATE manual_runs SET status='failed' WHERE issue_number=? AND status='awaiting_plan'",
                               (number,))
            print(f"Issue #{number}: plan check failed ({type(error).__name__})", flush=True)
            continue
        if approval is None:
            continue
        base, plan = approval
        print(f"Claimed issue #{number} from {row[0]}", flush=True)
        execution = telemetry.start(db, number, "issue")
        try:
            handler(db, number, on_stage=partial(telemetry.mark, db, execution),
                    approved_plan=plan, expected_base=base)
        except Exception as error:
            with db:
                db.execute(
                    "UPDATE jobs SET last_error=COALESCE(last_error, ?) WHERE number=?",
                    (type(error).__name__, number),
                )
            telemetry.finish(db, execution, "failed", type(error).__name__)
            print(f"Issue #{number} stopped. See its stored stage and error.", flush=True)
        else:
            telemetry.finish(db, execution, "completed")
        result = db.execute("SELECT stage, last_error FROM jobs WHERE number=?", (number,)).fetchone()
        with db:
            db.execute("UPDATE manual_runs SET status=? WHERE issue_number=? AND status='awaiting_plan'",
                       ("completed" if result == ("Delivery", None) else "failed", number))
        return True
    return False


def run_ci_repair(db, handlers, data):
    row = db.execute("""
        SELECT validation.run_id, validation.issue_number, validation.run_url, attempt.attempt,
               jobs.title, jobs.body
        FROM ci_validations AS validation
        JOIN ci_validation_attempts AS attempt ON attempt.run_id=validation.run_id
        JOIN pr_deliveries AS pr ON pr.issue_number=validation.issue_number
        JOIN jobs ON jobs.number=validation.issue_number
        LEFT JOIN ci_repairs AS repair ON repair.run_id=validation.run_id
        WHERE validation.pr_head=pr.head_sha AND jobs.stage='Delivery'
          AND attempt.attempt=(SELECT MAX(a.attempt) FROM ci_validation_attempts AS a
                               WHERE a.run_id=validation.run_id)
          AND attempt.conclusion='failure'
          AND (repair.run_id IS NULL OR repair.status='running')
        ORDER BY validation.run_id
    """)
    candidate = next((item for item in row if item[1] in handlers), None)
    row.close()
    if candidate is None:
        return False
    run_id, issue, url, attempt, title, body = candidate
    patch = data / f"issue-{issue}-ci-{run_id}.patch"
    with db:
        db.execute("""INSERT OR IGNORE INTO ci_repairs(run_id, attempt, status)
                      VALUES (?, ?, 'running')""", (run_id, attempt))
    status, error = 'candidate', None
    execution = telemetry.start(db, issue, 'ci_repair')
    try:
        with sqlite3.connect(':memory:') as isolated:
            isolated.execute("""CREATE TABLE jobs(number INTEGER PRIMARY KEY, title TEXT, body TEXT,
                              stage TEXT, repair_count INTEGER, last_error TEXT)""")
            isolated.execute("INSERT INTO jobs VALUES (?, ?, ?, 'Repair', 1, NULL)", (issue, title, body))
            handlers[issue](isolated, issue, ci_failure=url, output=patch,
                            on_stage=partial(telemetry.mark, db, execution))
    except Exception as failure:
        status, error = 'failed', type(failure).__name__
    with db:
        db.execute("UPDATE ci_repairs SET status=?, error=?, patch_path=? WHERE run_id=?",
                   (status, error, patch.name if status == 'candidate' else None, run_id))
    telemetry.finish(db, execution, "completed" if status == "candidate" else "failed", error)
    print(f"CI repair for issue #{issue}: {status}", flush=True)
    return True


def run_publication(db, files, data, app_config, label_only):
    for number, paths in files.items():
        row = db.execute("""
            SELECT jobs.stage, pr.pr_number, publication.status FROM jobs
            LEFT JOIN pr_deliveries AS pr ON pr.issue_number=jobs.number
            LEFT JOIN publications AS publication ON publication.issue_number=jobs.number
            WHERE jobs.number=?
        """, (number,)).fetchone()
        if row is None or row[0] != "Delivery" or row[1] is not None or row[2] == "failed":
            continue
        with db:
            db.execute("INSERT OR IGNORE INTO publications VALUES (?, 'running', NULL)", (number,))
        try:
            publish(db, number, data, paths, app_config, require_label=number in label_only)
        except Exception as error:
            with db:
                db.execute("UPDATE publications SET status='failed', error=? WHERE issue_number=?",
                           (type(error).__name__, number))
            print(f"Issue #{number}: draft publication stopped", flush=True)
        else:
            with db:
                db.execute("UPDATE publications SET status='published' WHERE issue_number=?", (number,))
        return True
    return False


def run_manual(db, handlers):
    queued = db.execute("""SELECT m.issue_number
        FROM manual_runs m JOIN jobs j ON j.number=m.issue_number
        WHERE m.status='queued' ORDER BY m.requested_at, m.issue_number LIMIT 1""").fetchone()
    if queued is None:
        return False
    number = queued[0]
    blocked = db.execute("""SELECT EXISTS(SELECT 1 FROM pr_deliveries WHERE issue_number=?)
        OR EXISTS(SELECT 1 FROM publications WHERE issue_number=?)
        OR EXISTS(SELECT 1 FROM publication_approvals WHERE issue_number=? AND approved=1)""",
        (number, number, number)).fetchone()[0]
    with db:
        accepted = number in handlers and not blocked
        db.execute("UPDATE manual_runs SET status=? WHERE issue_number=?",
                   ("awaiting_plan" if accepted else "rejected", number))
        if accepted:
            db.execute("DELETE FROM issue_plans WHERE issue_number=?", (number,))
            db.execute("UPDATE jobs SET stage='Planning', last_error=NULL, repair_count=0 WHERE number=?", (number,))
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o027)
    data = Path(os.environ.get("AI_NATIVE_DATA", ROOT / "data"))
    approved = os.environ.get("AI_NATIVE_WORKER_ISSUE", "")
    handlers = {13: run} if approved == "13" else {}
    allowed_files = {13: ("README.md",)} if handlers else {}
    config = os.environ.get("AI_NATIVE_CODE_PROFILES")
    if config:
        profiles = json.loads(Path(config).read_text())
        if not isinstance(profiles, dict):
            parser.error("Code profiles must map Issue numbers to approved files")
        for number, paths in profiles.items():
            if not number.isascii() or not number.isdecimal() or int(number) < 1 or int(number) in handlers:
                parser.error("Invalid or duplicate Issue number in code profiles")
            allowed_files[int(number)] = check_paths(paths)
            handlers[int(number)] = partial(run, files=allowed_files[int(number)])
    if not handlers:
        parser.error("AI_NATIVE_WORKER_ISSUE must select a configured execution profile")
    policy = os.environ.get("AI_NATIVE_PUBLISH_ISSUES")
    app_config = Path(os.environ.get("AI_NATIVE_GITHUB_APP_CONFIG", DEFAULT_CONFIG))
    static_publish = {}
    if policy:
        for number in policy.split(","):
            if not number.isascii() or not number.isdecimal() or int(number) not in allowed_files:
                parser.error("Publishing policy must select configured Issue numbers")
            static_publish[int(number)] = allowed_files[int(number)]

    with (data / "worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(data / "workflow.sqlite", timeout=5) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS ci_repairs (
                run_id INTEGER PRIMARY KEY, attempt INTEGER NOT NULL, status TEXT NOT NULL,
                error TEXT, patch_path TEXT
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS publications (
                issue_number INTEGER PRIMARY KEY, status TEXT NOT NULL, error TEXT
            )""")
            telemetry.initialize(db)
            db.execute(plans.SCHEMA)
            db.execute("""CREATE TABLE IF NOT EXISTS manual_runs (
                issue_number INTEGER PRIMARY KEY REFERENCES jobs(number),
                requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL
            )""")
            db.execute("CREATE TABLE IF NOT EXISTS worker_profiles (issue_number INTEGER PRIMARY KEY)")
            with db:
                db.execute("UPDATE manual_runs SET status='interrupted' WHERE status='running'")
                db.execute("DELETE FROM worker_profiles")
                db.executemany("INSERT INTO worker_profiles VALUES (?)", ((number,) for number in handlers))
            while True:
                telemetry.heartbeat(db)
                claimed = run_manual(db, handlers)
                if not claimed:
                    claimed = run_next(db, handlers, allowed_files, app_config)
                if not claimed:
                    claimed = run_ci_repair(db, handlers, data)
                if not claimed and app_config.is_file():
                    approvals = db.execute("SELECT issue_number FROM publication_approvals WHERE approved=1")
                    label_only = {number for (number,) in approvals if number in allowed_files and number not in static_publish}
                    publish_files = static_publish | {number: allowed_files[number] for number in label_only}
                    claimed = run_publication(db, publish_files, data, app_config, label_only)
                if args.once:
                    return
                if not claimed:
                    time.sleep(5)


if __name__ == "__main__":
    main()
