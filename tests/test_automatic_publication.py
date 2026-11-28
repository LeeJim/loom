import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

import plans
import publish
import telemetry
import worker


class AutomaticPublicationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(plans.SCHEMA)
        self.db.executescript("""
            CREATE TABLE jobs(number INTEGER PRIMARY KEY,stage TEXT,last_error TEXT,repair_count INTEGER);
            CREATE TABLE publications(issue_number INTEGER PRIMARY KEY,status TEXT,error TEXT);
            CREATE TABLE pr_deliveries(issue_number INTEGER PRIMARY KEY,pr_number INTEGER,pr_url TEXT,head_sha TEXT);
            CREATE TABLE manual_runs(issue_number INTEGER PRIMARY KEY,status TEXT);
            INSERT INTO jobs VALUES(15,'Delivery',NULL,0);
            INSERT INTO issue_plans(issue_number,plan_id,title,body,profile,base_sha,plan,state,approval_comment_id,posted_at)
            VALUES(15,'approved','Example','','["a.js"]','base','Plan','approved',123,'2026-01-01T00:00:00Z');
        """)
        telemetry.initialize(self.db)

    def test_validated_approved_delivery_is_published_without_label(self):
        with patch.object(worker, "publish") as publish_operation:
            self.assertTrue(worker.run_publication(self.db, {15: ("a.js",)}, Path("/fixture"), Path("/config")))
        publish_operation.assert_called_once_with(self.db, 15, Path("/fixture"), ("a.js",), Path("/config"))

    def test_unapproved_delivery_cannot_be_published(self):
        self.db.execute("UPDATE issue_plans SET approval_comment_id=NULL")
        with patch.object(worker, "publish") as publish_operation:
            self.assertFalse(worker.run_publication(self.db, {15: ("a.js",)}, Path("/fixture"), Path("/config")))
        publish_operation.assert_not_called()

    def test_publication_rechecks_approval_and_ignores_labels(self):
        issue = {"state": "open", "title": "Example", "body": "", "labels": []}
        with patch.object(publish, "api", return_value=issue), patch.object(
            publish, "plan_directives", return_value=[{"comment_id": 123, "feedback": "通过"}],
        ) as directives:
            publish.verify_approved_delivery(self.db, 15, "token", ("a.js",), "base")
            directives.return_value.append({"comment_id": 124, "feedback": "继续调整"})
            with self.assertRaises(publish.PublicationBlocked):
                publish.verify_approved_delivery(self.db, 15, "token", ("a.js",), "base")

    def test_publication_retry_keeps_the_existing_plan(self):
        self.db.executescript("""
            INSERT INTO publications VALUES(15,'failed','HTTPError');
            INSERT INTO manual_runs VALUES(15,'queued');
        """)
        self.assertTrue(worker.run_manual(self.db, {15: object()}))
        self.assertIsNone(self.db.execute("SELECT * FROM publications").fetchone())
        self.assertEqual(self.db.execute("SELECT plan_id,state FROM issue_plans").fetchone(),
                         ("approved", "approved"))
        self.assertEqual(self.db.execute("SELECT stage FROM jobs").fetchone(), ("Delivery",))
