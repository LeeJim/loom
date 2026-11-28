"""Store a verified GitHub Actions result against an existing PR delivery."""
import argparse
import re
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument("issue", type=int)
parser.add_argument("pr_head")
parser.add_argument("run", type=int)
parser.add_argument("workflow_head")
parser.add_argument("conclusion", choices=("success", "failure", "cancelled", "timed_out"))
args = parser.parse_args()
if min(args.issue, args.run) < 1 or any(
    not re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (args.pr_head, args.workflow_head)
):
    parser.error("Expected positive IDs and full commit SHAs")

url = f"https://github.com/LeeJim/HowToCookOnMiniprogram/actions/runs/{args.run}"
receipt = (args.run, args.issue, args.pr_head, args.workflow_head, args.conclusion, url)
with sqlite3.connect("file:/opt/loom/data/workflow.sqlite?mode=rw", uri=True) as db:
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("BEGIN IMMEDIATE")
    head = db.execute(
        "SELECT head_sha FROM pr_deliveries WHERE issue_number=?", (args.issue,)
    ).fetchone()
    if head != (args.pr_head,):
        raise SystemExit("CI result does not match the recorded PR head")
    db.execute("""CREATE TABLE IF NOT EXISTS ci_validations (
        run_id INTEGER PRIMARY KEY,
        issue_number INTEGER NOT NULL REFERENCES pr_deliveries(issue_number),
        pr_head TEXT NOT NULL, workflow_head TEXT NOT NULL, conclusion TEXT NOT NULL,
        run_url TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    db.execute("""INSERT INTO ci_validations
        (run_id,issue_number,pr_head,workflow_head,conclusion,run_url)
        VALUES (?,?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING""", receipt)
    saved = db.execute("""SELECT run_id,issue_number,pr_head,workflow_head,conclusion,run_url
        FROM ci_validations WHERE run_id=?""", (args.run,)).fetchone()
    if saved != receipt:
        raise SystemExit("Run ID already has a different validation record")
print(f"Issue #{args.issue}: {args.conclusion} {url}")
