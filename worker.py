"""Supervise concurrent workers and serialize advancement of each Issue."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import fcntl
from functools import partial
import json
import os
from pathlib import Path
import signal
import sqlite3
from threading import Event
import time

from run_docs import ROOT, PlanBaseChanged, agent_context, check_paths, run
from publish import publish
from github_app import DEFAULT_CONFIG
import telemetry
import plans
import plan_retries
import worker_registry


def run_next(db, handlers, allowed_files, app_config):
    """Run a fresh or interrupted job. The caller holds an exclusive Issue claim."""
    for number, handler in handlers.items():
        row = db.execute(
            "SELECT stage, last_error FROM jobs WHERE number=?", (number,)
        ).fetchone()
        if row is None or row[0] in {"Delivery", "Stopped"} or row[1] is not None:
            continue
        pending = db.execute(
            "SELECT next_check FROM issue_plans WHERE issue_number=?", (number,)
        ).fetchone()
        if (pending and pending[0] > int(time.time())) or not plan_retries.eligible(db, number):
            continue
        review = telemetry.start(db, number, "plan_review")
        try:
            with telemetry.capture(db, review):
                approval = plans.review(db, number, allowed_files[number], app_config)
        except Exception as error:
            retry = plan_retries.record_failure(db, number, error)
            with telemetry.capture(db, review):
                telemetry.record("Planning", "output", result="failed", **retry)
            telemetry.finish(db, review, "failed", retry["reason"])
            print(f"Issue #{number}: {retry['operation']} {retry['state']} ({retry['reason']})", flush=True)
            continue
        with db:
            plan_retries.clear(db, number)
            db.execute("UPDATE issue_plans SET error=NULL WHERE issue_number=?", (number,))
            activity = db.execute("SELECT 1 FROM workflow_artifacts WHERE execution_id=?", (review,)).fetchone()
            if activity or approval is not None:
                telemetry.finish(db, review, "completed")
            else:
                db.execute("DELETE FROM workflow_executions WHERE id=?", (review,))
        if approval is None:
            continue
        base, plan = approval
        print(f"Claimed issue #{number} from {row[0]}", flush=True)
        execution = telemetry.start(db, number, "issue")
        try:
            with telemetry.capture(db, execution):
                handler(db, number, on_stage=partial(telemetry.mark, db, execution),
                        approved_plan=plan, expected_base=base)
        except PlanBaseChanged as error:
            with telemetry.capture(db, execution):
                telemetry.record("Approval", "output", invalidated="Base revision changed before coding")
            with db:
                db.execute("DELETE FROM issue_plans WHERE issue_number=?", (number,))
                db.execute("UPDATE jobs SET stage='Planning', last_error=NULL WHERE number=?", (number,))
            telemetry.finish(db, execution, "interrupted", type(error).__name__)
            return True
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
        with (closing(sqlite3.connect(":memory:")) as isolated,
              telemetry.capture(db, execution)):
            telemetry.record("CI repair", "input", run_id=run_id, run_url=url, attempt=attempt)
            isolated.execute("""CREATE TABLE jobs(number INTEGER PRIMARY KEY, title TEXT, body TEXT,
                              stage TEXT, repair_count INTEGER, last_error TEXT)""")
            isolated.execute("INSERT INTO jobs VALUES (?, ?, ?, 'Repair', 1, NULL)", (issue, title, body))
            handlers[issue](isolated, issue, ci_failure=url, output=patch,
                            on_stage=partial(telemetry.mark, db, execution))
            telemetry.record("CI repair", "output", patch=patch.name)
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
        execution = telemetry.start(db, number, "publication")
        try:
            with telemetry.capture(db, execution):
                telemetry.mark(db, execution, "Publication")
                telemetry.record("Publication", "input", issue_number=number, approved_files=paths)
                publish(db, number, data, paths, app_config, require_label=number in label_only)
                delivery = db.execute(
                    "SELECT pr_number,pr_url,head_sha FROM pr_deliveries WHERE issue_number=?", (number,)
                ).fetchone()
                telemetry.record("Publication", "output", pull_request=delivery)
        except Exception as error:
            telemetry.finish(db, execution, "failed", type(error).__name__)
            with db:
                db.execute("UPDATE publications SET status='failed', error=? WHERE issue_number=?",
                           (type(error).__name__, number))
            print(f"Issue #{number}: draft publication stopped", flush=True)
        else:
            telemetry.finish(db, execution, "completed")
            with db:
                db.execute("UPDATE publications SET status='published' WHERE issue_number=?", (number,))
        return True
    return False


def run_manual(db, handlers):
    queued = db.execute("""SELECT m.issue_number
        FROM manual_runs m JOIN jobs j ON j.number=m.issue_number
        WHERE m.status='queued' AND m.issue_number=?""", (next(iter(handlers)),)).fetchone()
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
            stopped = db.execute("SELECT stage FROM jobs WHERE number=?", (number,)).fetchone() == ("Stopped",)
            plan = db.execute("SELECT state FROM issue_plans WHERE issue_number=?", (number,)).fetchone()
            stage = "Planning"
            if stopped and plan:
                db.execute("UPDATE issue_plans SET error=NULL,next_check=0 WHERE issue_number=?", (number,))
                if plan[0] in {"awaiting_review", "approved"}:
                    stage = "AwaitingApproval"
            else:
                db.execute("DELETE FROM issue_plans WHERE issue_number=?", (number,))
            plan_retries.clear(db, number)
            db.execute("UPDATE jobs SET stage=?,last_error=NULL,repair_count=0 WHERE number=?", (stage, number))
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o027)
    data = Path(os.environ.get("LOOM_DATA", ROOT / "data"))
    approved = os.environ.get("LOOM_WORKER_ISSUE", "")
    handlers = {13: run} if approved == "13" else {}
    allowed_files = {13: ("README.md",)} if handlers else {}
    config = os.environ.get("LOOM_CODE_PROFILES")
    if config:
        profiles = json.loads(Path(config).read_text())
        if not isinstance(profiles, dict):
            parser.error("Code profiles must map Issue numbers to approved files")
        for number, paths in profiles.items():
            if not number.isascii() or not number.isdecimal() or int(number) < 1 or int(number) in handlers:
                parser.error("Invalid or duplicate Issue number in code profiles")
            allowed_files[int(number)] = check_paths(paths)
            handlers[int(number)] = partial(run, files=allowed_files[int(number)])
    policy = os.environ.get("LOOM_PUBLISH_ISSUES")
    app_config = Path(os.environ.get("LOOM_GITHUB_APP_CONFIG", DEFAULT_CONFIG))
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
            db.executescript(plans.SCHEMA)
            db.execute(plan_retries.SCHEMA)
            db.execute("""CREATE TABLE IF NOT EXISTS manual_runs (
                issue_number INTEGER PRIMARY KEY REFERENCES jobs(number),
                requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, status TEXT NOT NULL
            )""")
            db.execute("CREATE TABLE IF NOT EXISTS worker_profiles (issue_number INTEGER PRIMARY KEY)")
            with db:
                db.execute("UPDATE manual_runs SET status='interrupted' WHERE status='running'")
                db.execute("DELETE FROM worker_profiles")
                db.executemany("INSERT INTO worker_profiles VALUES (?)", ((number,) for number in handlers))
            worker_registry.initialize(db)
            worker_registry.recover_claims(db)
            parallelism = int(os.environ.get("LOOM_MAX_PARALLEL_WORKERS", "2"))
            if not 1 <= parallelism <= 16:
                parser.error("LOOM_MAX_PARALLEL_WORKERS must be between 1 and 16")
            stop = Event()
            signal.signal(signal.SIGTERM, lambda *_: stop.set())
            signal.signal(signal.SIGINT, lambda *_: stop.set())
            supervise(db, data, handlers, allowed_files, app_config, static_publish,
                      parallelism, stop, once=args.once)


def advance(data, worker, issue, handler, paths, app_config, static_publish):
    with (closing(sqlite3.connect(data / "workflow.sqlite", timeout=10)) as db,
          agent_context(worker["id"], model=worker["model"], skills=worker["skills"], issue=issue)):
        handlers = {issue: handler}
        if run_manual(db, handlers):
            return
        if run_next(db, handlers, {issue: paths}, app_config):
            return
        if run_ci_repair(db, handlers, data):
            return
        if app_config.is_file():
            approved = db.execute(
                "SELECT approved FROM publication_approvals WHERE issue_number=?", (issue,)
            ).fetchone() == (1,)
            if static_publish or approved:
                run_publication(db, {issue: paths}, data, app_config,
                                {issue} if not static_publish else set())


def supervise(db, data, handlers, allowed_files, app_config, static_publish, parallelism, stop, *, once=False):
    active = {}
    cursors = {}
    with ThreadPoolExecutor(max_workers=parallelism) as pool:
        try:
            while not stop.is_set():
                telemetry.heartbeat(db)
                for key, future in list(active.items()):
                    if future.done():
                        finish_claim(db, key, future)
                        del active[key]
                occupied = {worker_id for worker_id, _ in active}
                for worker in worker_registry.runnable_workers(db):
                    if len(active) >= parallelism or stop.is_set():
                        break
                    worker_id = worker["id"]
                    if worker_id in occupied:
                        continue
                    issues = list(handlers) if worker["issue_number"] is None else [
                        number for number in handlers if number == worker["issue_number"]
                    ]
                    for offset in range(len(issues)):
                        index = (cursors.get(worker_id, 0) + offset) % len(issues)
                        issue = issues[index]
                        if worker_registry.claim(db, worker_id, issue):
                            active[worker_id, issue] = pool.submit(
                                advance, data, worker, issue, handlers[issue], allowed_files[issue],
                                app_config, issue in static_publish,
                            )
                            cursors[worker_id] = index + 1
                            break
                if once:
                    break
                stop.wait(3)
        finally:
            for key, future in active.items():
                finish_claim(db, key, future)


def finish_claim(db, key, future):
    worker_id, issue = key
    try:
        future.result()
    except Exception as error:
        print(f"Worker {worker_id}: Issue #{issue} advance failed ({type(error).__name__})", flush=True)
    finally:
        worker_registry.release(db, worker_id, issue)


if __name__ == "__main__":
    main()
