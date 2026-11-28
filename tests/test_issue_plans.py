import sqlite3
import unittest
from unittest.mock import patch

import plans


STAMP = "2026-11-28T08:00:00Z"
LATER = "2026-11-28T08:00:01Z"


def comment(number, body, *, actor=42, timestamp=LATER, edited=False):
    return {
        "id": number,
        "body": body,
        "user": {"id": actor, "login": f"dev-{actor}", "type": "User"},
        "created_at": timestamp,
        "updated_at": "2026-11-28T08:00:02Z" if edited else timestamp,
    }


class IssuePlanTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(plans.SCHEMA)
        self.db.execute("CREATE TABLE jobs(number INTEGER, title TEXT, body TEXT, stage TEXT)")
        self.db.execute("INSERT INTO jobs VALUES (1,'需求','正文','AwaitingApproval')")
        self.db.execute("""INSERT INTO issue_plans
             (issue_number,plan_id,title,body,profile,base_sha,plan,comment_url,posted_at,state)
             VALUES (1,'v1','需求','正文','["README.md"]','base','原方案','https://example.org/#issuecomment-10',
                ?,'awaiting_review')""", (STAMP,))
        self.comments = []

    def github(self, token, path, *, body=None):
        if path.endswith("/permission"):
            if "dev-42" in path:
                return {"permission": "write", "user": {"id": 42}}
            return {"permission": "read", "user": {"id": 7}}
        if path.endswith("/git/ref/heads/main"):
            return {"object": {"sha": "base"}}
        if "/comments?" in path:
            return self.comments
        return {"state": "open", "title": "需求", "body": "正文"}

    def review(self):
        with patch.object(plans, "installation_token", return_value="test"), patch.object(plans, "api", self.github):
            return plans.review(self.db, 1, ("README.md",), None)

    def test_approval_checks_authorization_and_comment_boundary(self):
        self.comments = [
            comment(11, "通过"),
            comment(12, "@loom 通过", actor=7),
            comment(13, "@loom 通过", edited=True),
            comment(9, "@loom 通过", timestamp=STAMP),
        ]
        self.assertIsNone(self.review())
        self.db.execute("UPDATE issue_plans SET next_check=0")
        self.comments.append(comment(14, " @loom 通过 ", timestamp=STAMP))
        self.assertEqual(self.review(), ("base", "原方案"))
        self.assertEqual(self.db.execute("SELECT approval_comment_id FROM issue_plans").fetchone(), (14,))

    def test_feedback_supersedes_plan_even_with_approval_in_same_batch(self):
        self.comments = [comment(21, "@loom 通过"), comment(22, "@loom 增加边界测试")]
        with patch.object(plans, "draft", return_value=("base", "修订方案")) as draft:
            self.assertIsNone(self.review())
        draft.assert_called_once_with(
            "需求", "正文", ("README.md",), previous="原方案",
            feedback=[{"comment_id": 22, "actor_id": 42, "feedback": "增加边界测试"}],
        )
        revised_id, state, plan = self.db.execute("SELECT plan_id,state,plan FROM issue_plans").fetchone()
        self.assertEqual((state, plan), ("posting", "修订方案"))
        self.assertEqual(
            self.db.execute("SELECT plan_id,superseded_by FROM issue_plan_history").fetchone(), ("v1", revised_id),
        )

    def test_base_change_invalidates_approval_and_restarts_planning(self):
        self.comments = [comment(21, "@loom 通过")]
        self.db.execute("UPDATE issue_plans SET base_sha='previous-base'")
        self.assertIsNone(self.review())
        self.assertIsNone(self.db.execute("SELECT 1 FROM issue_plans").fetchone())
        self.assertEqual(self.db.execute("SELECT stage FROM jobs").fetchone(), ("Planning",))
