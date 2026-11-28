from contextlib import closing
from email.message import Message
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "console"))
import oauth
import server
import worker_registry


class ConsoleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        database = Path(temporary.name) / "workflow.sqlite"
        with closing(sqlite3.connect(database)) as db:
            worker_registry.initialize(db)
        patcher = patch.object(server, "DB", database)
        patcher.start()
        self.addCleanup(patcher.stop)
    def request(self, method, path, *, owner=None, body=None, origin=oauth.ORIGIN):
        handler = server.Handler.__new__(server.Handler)
        handler.command = method
        handler.path = path
        handler.headers = Message()
        handler.headers["Host"] = urlsplit(oauth.ORIGIN).netloc
        handler.headers["Origin"] = origin
        if owner is not None:
            handler.headers["Cookie"] = "loom_session=" + oauth.sessions.put({"id": owner, "login": str(owner)})
        if body is not None:
            content = json.dumps(body).encode()
            handler.headers["Content-Type"] = "application/json"
            handler.headers["Content-Length"] = str(len(content))
            handler.rfile = BytesIO(content)
        result = []
        handler.send_body = lambda status, _content_type, data: result.append((status, json.loads(data)))
        (handler.do_POST if method == "POST" else handler.do_GET)()
        return result[0]

    def test_public_snapshot_needs_login(self):
        self.assertEqual(self.request("GET", "/api/snapshot")[0], 401)

    def test_workers_cannot_be_read_or_controlled_by_other_owner(self):
        _, worker = self.request("POST", "/api/workers", owner=7, body={"name": "first"})
        self.assertEqual(worker["owner_id"], 7)
        self.assertEqual(self.request("GET", "/api/workers", owner=8), (200, []))
        state = {"id": worker["id"], "state": "running"}
        self.assertEqual(self.request("POST", "/api/workers/state", owner=8, body=state)[0], 404)
        self.assertEqual(self.request("POST", "/api/workers/state", owner=7, body=state)[1]["state"], "running")
        self.assertEqual(self.request("POST", "/api/workers/state", owner=7, body=state,
                                      origin="https://unrelated.example")[0], 403)


class OAuthTests(unittest.TestCase):
    def test_login_uses_pkce_and_rejects_mismatched_browser_state(self):
        url, cookie = oauth.begin()
        fields = parse_qs(urlsplit(url).query)
        self.assertEqual(fields["code_challenge_method"], ["S256"])
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)
        with self.assertRaises(ValueError):
            oauth.finish(fields["state"][0], "unrelated-state", "unused")

    def test_state_is_single_use(self):
        store = oauth.ExpiringTokens(300)
        state = store.put("verifier")
        self.assertEqual(store.get(state, consume=True), "verifier")
        self.assertIsNone(store.get(state, consume=True))


if __name__ == "__main__":
    unittest.main()
