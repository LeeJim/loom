from io import BytesIO
import sqlite3
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from github_app import MissingIssueWritePermission
import plan_retries as retry
import plans
import worker


def http(status, headers=None):
    error = HTTPError("https://api.github.com/", status, "fixture", headers or {}, BytesIO())
    error.close()
    return error


class RetryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(plans.SCHEMA)
        self.db.executescript(retry.SCHEMA + """
        ;
        CREATE TABLE jobs(number INTEGER PRIMARY KEY,stage TEXT,last_error TEXT,repair_count INTEGER);
        CREATE TABLE manual_runs(issue_number INTEGER PRIMARY KEY,status TEXT);
        CREATE TABLE pr_deliveries(issue_number INTEGER);
        CREATE TABLE publications(issue_number INTEGER);
        CREATE TABLE publication_approvals(issue_number INTEGER,approved INTEGER);
        INSERT INTO jobs VALUES(15,'Planning',NULL,0);
        INSERT INTO issue_plans(issue_number,plan_id,title,body,profile,base_sha,plan)
        VALUES(15,'saved','Example','','[]','fixture','Existing plan');
        """)
        jitter = patch.object(retry, "uniform", side_effect=lambda minimum, _: minimum)
        jitter.start()
        self.addCleanup(jitter.stop)

    def test_temporary_errors_back_off_then_stop(self):
        now = 1000
        for index, delay in enumerate((30, 60, 120, 240, 480), start=1):
            result = retry.record_failure(self.db, 15, http(503), now=now)
            self.assertEqual((result["attempt"], result["retry_at"]), (index, now + delay))
            self.assertFalse(retry.eligible(self.db, 15, now + delay - 1))
            self.assertTrue(retry.eligible(self.db, 15, now + delay))
            now += delay
        result = retry.record_failure(self.db, 15, http(503), now=now)
        self.assertEqual((result["attempt"], result["state"]), (6, "stopped"))
        self.assertFalse(retry.eligible(self.db, 15, now + 100))

    def test_forbidden_stops_and_manual_run_preserves_plan(self):
        result = retry.record_failure(self.db, 15, http(403, {"X-GitHub-Request-Id": "ABC:123"}), now=1000)
        self.assertEqual((result["reason"], result["state"], result["request_id"]), ("forbidden", "stopped", "ABC:123"))
        self.db.execute("INSERT INTO manual_runs VALUES(15,'queued')")
        self.assertTrue(worker.run_manual(self.db, {15: object()}))
        self.assertEqual(self.db.execute("SELECT stage,last_error FROM jobs").fetchone(), ("Planning", None))
        self.assertEqual(self.db.execute("SELECT plan_id,plan,state FROM issue_plans").fetchone(),
                         ("saved", "Existing plan", "posting"))
        self.assertTrue(retry.eligible(self.db, 15, 1001))

    def test_limit_headers_and_budget_window(self):
        decision = retry.record_failure(self.db, 15, http(403, {"Retry-After": "150"}), now=1000)
        self.assertEqual((decision["reason"], decision["retry_at"]), ("rate_limited", 1150))
        self.assertFalse(retry.eligible(self.db, 15, 2800))
        self.assertEqual(self.db.execute("SELECT state,reason FROM plan_retry_state").fetchone(),
                         ("stopped", "retry_window_expired"))

    def test_missing_issue_scope_is_permanent(self):
        result = retry.record_failure(self.db, 15, MissingIssueWritePermission(), now=1000)
        self.assertEqual((result["reason"], result["state"]), ("issues_write_required", "stopped"))
