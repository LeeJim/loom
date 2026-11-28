from contextlib import closing
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import rollout


class RolloutTests(unittest.TestCase):
    def setUp(self):
        prepare = patch.object(rollout, "prepare_console")
        prepare.start()
        self.addCleanup(prepare.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.release = self.root / "releases"
        self.release.mkdir()
        self.systemd = self.root / "systemd"
        self.source = self.root / "source"
        for name in ["worker.py", "console/server/index.ts", "console/Dockerfile", "controller.mjs", "controller.Dockerfile"]:
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
        worker = self.systemd / "loom-worker.service.d/loom-release.conf"
        console = self.systemd / "loom-console.service.d/loom-release.conf"
        self.assertIn("ExecStart=/usr/bin/python3", worker.read_text())
        self.assertIn("/console-runtime/bin/node", console.read_text())
        self.assertIn("/console-runtime/dist/server/index.js", console.read_text())
        self.assertEqual(run.call_args.args[:2], ("docker", "rm"))

    def test_failed_health_restores_existing_overrides_and_container(self):
        worker = self.systemd / "loom-worker.service.d/loom-release.conf"
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
        self.assertFalse((self.systemd / "loom-console.service.d/loom-release.conf").exists())
        cleanup.assert_called_once_with(["docker", "rm", "-f", "loom-controller"], check=False)
        run.assert_any_call("docker", "start", "loom-controller")

    def test_active_execution_does_not_stop_services(self):
        with closing(sqlite3.connect(self.root / "data/workflow.sqlite")) as db, db:
            db.execute("INSERT INTO workflow_executions VALUES ('running')")
        with patch.object(rollout, "run") as run, self.assertRaisesRegex(RuntimeError, "active"):
            rollout.rollout(self.source, "c" * 40)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[:2], ("docker", "build"))

class ConsoleRuntimeTests(unittest.TestCase):
    def test_runtime_is_validated_and_published_before_service_switch(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)

            def run(*args):
                if args[:2] == ("docker", "cp"):
                    staged = Path(args[-1])
                    (staged / "dist/web").mkdir(parents=True)
                    (staged / "dist/web/index.html").write_text("<html></html>")
                if args[-1] == "--version":
                    self.assertFalse((release / "console-runtime").exists())

            with patch.object(rollout, "run", side_effect=run) as command, patch.object(
                rollout, "output", return_value="build-container"
            ):
                rollout.prepare_console(release, "a" * 40)
                self.assertTrue((release / "console-runtime/dist/web/index.html").is_file())
                self.assertEqual(command.call_args.args, ("docker", "rm", "build-container"))
                calls = command.call_count
                rollout.prepare_console(release, "a" * 40)
                self.assertEqual(command.call_count, calls)
