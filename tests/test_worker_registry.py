from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
from threading import Barrier, Event
import unittest
from unittest.mock import patch

import telemetry
import worker
import worker_registry


class WorkerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.data = Path(directory.name)
        self.db = sqlite3.connect(self.data / "workflow.sqlite")
        self.addCleanup(self.db.close)
        worker_registry.initialize(self.db)
        self.db.execute("CREATE TABLE worker_profiles(issue_number INTEGER PRIMARY KEY)")
        self.db.executemany("INSERT INTO worker_profiles VALUES (?)", [(13,), (15,)])
        self.db.commit()
        telemetry.initialize(self.db)

    def create(self, owner, name, issue=None):
        item = worker_registry.create_worker(self.db, owner, name, issue)
        return item["id"]

    def test_reports_effective_system_worker_configuration(self):
        with self.db:
            worker_registry.report_system_config(
                self.db, model="deepseek/custom", pool_limit=3,
                profiles={15: ("src/example.js",)}, static_publication={15: ("src/example.js",)},
            )
        self.assertEqual(self.db.execute("""
            SELECT model,pool_limit,profiles,static_publication FROM loom_system_worker_config
        """).fetchone(), ("deepseek/custom", 3, '{"15": ["src/example.js"]}', "[15]"))

    def test_owner_scope_and_draining(self):
        first = self.create(1, "First", 13)
        self.create(2, "Second")
        self.assertEqual([item["id"] for item in worker_registry.list_workers(self.db, 1)], [first])
        self.assertIsNone(worker_registry.set_worker_state(self.db, 2, first, "running"))
        self.assertFalse(worker_registry.claim(self.db, first, 13))
        worker_registry.set_worker_state(self.db, 1, first, "running")
        self.assertFalse(worker_registry.claim(self.db, first, 15))
        self.assertTrue(worker_registry.claim(self.db, first, 13))
        worker_registry.set_worker_state(self.db, 1, first, "draining")
        self.assertEqual(worker_registry.list_workers(self.db, 1)[0]["state"], "draining")
        worker_registry.release(self.db, first, 13)
        self.assertEqual(worker_registry.list_workers(self.db, 1)[0]["state"], "paused")

    def test_exclusive_claim_with_restart_recovery(self):
        first = self.create(1, "First")
        second = self.create(2, "Second")
        worker_registry.set_worker_state(self.db, 1, first, "running")
        worker_registry.set_worker_state(self.db, 2, second, "running")
        self.assertTrue(worker_registry.claim(self.db, first, 13))
        with closing(sqlite3.connect(self.data / "workflow.sqlite")) as other:
            self.assertFalse(worker_registry.claim(other, second, 13))
            self.assertTrue(worker_registry.claim(other, second, 15))
        worker_registry.recover_claims(self.db)
        self.assertTrue(worker_registry.claim(self.db, second, 13))

    def test_supervisor_runs_two_issues_concurrently(self):
        for owner, issue in [(1, 13), (2, 15)]:
            item = self.create(owner, str(issue), issue)
            worker_registry.set_worker_state(self.db, owner, item, "running")
        parallel = Barrier(2, timeout=3)
        completed = []

        def run_issue(data, config, issue, *_):
            parallel.wait()
            completed.append(issue)

        with patch.object(worker, "advance", side_effect=run_issue):
            worker.supervise(self.db, self.data, {13: None, 15: None}, {13: (), 15: ()},
                             self.data / "app.json", 2, Event(), once=True)
        self.assertCountEqual(completed, [13, 15])
        self.assertEqual(self.db.execute("SELECT count(*) FROM loom_issue_claims").fetchone(), (0,))
