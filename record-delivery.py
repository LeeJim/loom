"""Record a GitHub draft delivery that an operator has verified."""
import argparse
import re
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument("issue", type=int)
parser.add_argument("pr", type=int)
parser.add_argument("head_sha")
args = parser.parse_args()
if min(args.issue, args.pr) < 1 or not re.fullmatch(r"[0-9a-f]{40}", args.head_sha):
    parser.error("Expected positive Issue and PR numbers and a full commit SHA")
url = f"https://github.com/LeeJim/HowToCookOnMiniprogram/pull/{args.pr}"
receipt = (args.pr, url, args.head_sha)
with sqlite3.connect("file:/opt/ai-native/data/workflow.sqlite?mode=rw", uri=True) as db:
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("BEGIN IMMEDIATE")
    state = db.execute("SELECT stage FROM jobs WHERE number=?", (args.issue,)).fetchone()
    if state != ("Delivery",):
        raise SystemExit("Issue must be in Delivery")
    db.execute("""CREATE TABLE IF NOT EXISTS pr_deliveries (
        issue_number INTEGER PRIMARY KEY REFERENCES jobs(number),
        pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL, head_sha TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )""")
    db.execute("""INSERT INTO pr_deliveries(issue_number,pr_number,pr_url,head_sha)
        VALUES (?,?,?,?) ON CONFLICT(issue_number) DO NOTHING""", (args.issue, *receipt))
    saved = db.execute(
        "SELECT pr_number,pr_url,head_sha FROM pr_deliveries WHERE issue_number=?", (args.issue,)
    ).fetchone()
    if saved != receipt:
        raise SystemExit("Issue already has a different delivery receipt")
print(f"Issue #{args.issue} → PR #{args.pr} {url} {args.head_sha}")
