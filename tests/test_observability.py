import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import capabilities
import run_docs
import telemetry


class ObservabilityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        telemetry.initialize(self.db)
        self.execution = telemetry.start(self.db, 13, "execution")

    def test_timeline_redacts_and_audit_links_repair(self):
        telemetry.mark(self.db, self.execution, "Repair")
        with telemetry.capture(self.db, self.execution):
            telemetry.record("Repair", "input", token="private", prompt="Bearer secret")
            telemetry.record("Repair", "output", status="passed")
        row = telemetry.timeline(self.db, self.execution)
        self.assertEqual(row["artifacts"][0]["payload"], {"token": "[redacted]", "prompt": "[redacted]"})
        self.assertEqual(len(row["artifacts"]), 2)
        self.assertEqual(telemetry.audit(self.db, self.execution)[0]["execution_id"], self.execution)

    def test_agent_uses_gateway_only_and_per_issue_containers(self):
        with telemetry.capture(self.db, self.execution), patch.object(run_docs, "command", side_effect=["", "proposal", "", "edited"]) as command:
            with run_docs.agent_context("alpha", model="deepseek/test", issue=13):
                run_docs.agent(Path("/work-one"), "draft")
            with run_docs.agent_context("beta", model="deepseek/test", issue=14):
                run_docs.agent(Path("/work-two"), "change", edit=True)
        first = command.call_args_list[1].args
        second = command.call_args_list[3].args
        self.assertNotEqual(first[first.index("--name") + 1], second[second.index("--name") + 1])
        config = json.loads(next(arg.split("=", 1)[1] for arg in first if arg.startswith("OPENCODE_CONFIG_CONTENT=")))
        self.assertEqual(config["enabled_providers"], ["gateway"])
        self.assertIn("gateway/deepseek/test", first)
        self.assertEqual(telemetry.timeline(self.db, self.execution)["artifacts"][0]["payload"]["model"], "deepseek/test")

    def test_skillhub_lists_installed_version_and_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            skill = root / "format-review" / "2"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("Check formatting.")
            manifest = root / "catalog.json"
            manifest.write_text('{"skills":[{"name":"format-review","version":"2"},{"id":"format-review","version":"3"}]}')
            with patch.dict("os.environ", {"LOOM_SKILLHUB_SKILLS_DIR": path}):
                self.assertEqual([row["installed"] for row in capabilities.skills(str(manifest))], [True, False])
                with self.assertRaises(ValueError):
                    capabilities.skill_files([{"id": "../format-review", "version": "2"}])


if __name__ == "__main__":
    unittest.main()
