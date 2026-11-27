from contextlib import closing
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import rollout


class RolloutTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.release = self.root / "releases"
        self.release.mkdir()
        self.systemd = self.root / "systemd"
        self.source = self.root / "source"
        for name in ["worker.py", "console/server.py", "controller.mjs", "controller.Dockerfile"]:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        (self.root / "data").mkdir()
        with closing(sqlite3.connect(self.root / "data/workflow.sqlite")) as db, db:
            db.execute("CREATE TABLE workflow_executions(status)")
        for name, value in {"ROOT": self.root, "RELEASES": self.release, "SYSTEMD": self.systemd}.items():
            update = patch.object(rollout, name, value)
            update.start()
            self.addCleanup(update.stop)

    def test_success(self):
        with patch.object(rollout, "run") as run, patch.object(rollout, "healthy"):
            rollout.rollout(self.source, "a" * 40)
        self.assertTrue((self.release / ("a" * 40) / "worker.py").exists())
        self.assertIn("ExecStart=/usr/bin/python3", next(self.systemd.glob("*/loom-release.conf")).read_text())
        self.assertEqual(run.call_args.args[:2], ("docker", "rm"))

    def test_failed_health_restores_existing_overrides_and_container(self):
        worker = self.systemd / "ai-native-worker.service.d/loom-release.conf"
        worker.parent.mkdir(parents=True)
        worker.write_text("previous override")
        with (
            patch.object(rollout, "run") as run,
            patch.object(rollout, "healthy", side_effect=[None, RuntimeError("bad console")]),
            patch.object(rollout.subprocess, "run") as cleanup,
            self.assertRaisesRegex(RuntimeError, "bad console"),
        ):
            rollout.rollout(self.source, "b" * 40)
        self.assertEqual(worker.read_text(), "previous override")
        self.assertFalse((self.systemd / "ai-native-console.service.d/loom-release.conf").exists())
        cleanup.assert_called_once_with(["docker", "rm", "-f", "ai-native-controller"], check=False)
        run.assert_any_call("docker", "start", "ai-native-controller")

    def test_active_execution_does_not_stop_services(self):
        with closing(sqlite3.connect(self.root / "data/workflow.sqlite")) as db, db:
            db.execute("INSERT INTO workflow_executions VALUES ('running')")
        with patch.object(rollout, "run") as run, self.assertRaisesRegex(RuntimeError, "active"):
            rollout.rollout(self.source, "c" * 40)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[:2], ("docker", "build"))
