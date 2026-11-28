"""GitHub OAuth login for the repository's authorized operators."""
from base64 import urlsafe_b64encode
import hashlib
from http.cookies import CookieError, SimpleCookie
import json
import os
import secrets
from threading import Lock
from time import monotonic
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from github_app import NoRedirect, REPOSITORY, api

CLIENT_ID = os.environ.get("LOOM_GITHUB_OAUTH_CLIENT_ID")
CLIENT_SECRET = os.environ.get("LOOM_GITHUB_OAUTH_CLIENT_SECRET")
ORIGIN = os.environ.get("LOOM_CONSOLE_ORIGIN", "https://ai.anyhub.cn").rstrip("/")
REDIRECT = ORIGIN + "/console/oauth/callback"
ENABLED = bool(CLIENT_ID and CLIENT_SECRET)


class ExpiringTokens:
    def __init__(self, lifetime):
        self.lifetime = lifetime
        self.tokens = {}
        self.lock = Lock()

    def put(self, value):
        token = secrets.token_urlsafe(32)
        now = monotonic()
        with self.lock:
            self.tokens = {key: entry for key, entry in self.tokens.items() if entry[0] > now}
            if len(self.tokens) >= 1024:
                self.tokens.pop(next(iter(self.tokens)))
            self.tokens[token] = (now + self.lifetime, value)
        return token

    def get(self, token, *, consume=False):
        with self.lock:
            expires, value = self.tokens.pop(token, (0, None)) if consume else self.tokens.get(token, (0, None))
        return value if expires > monotonic() else None


states = ExpiringTokens(300)
sessions = ExpiringTokens(3600)


def cookie(name, value, max_age):
    return f"{name}={value}; Path=/console/; Max-Age={max_age}; Secure; HttpOnly; SameSite=Lax"


def cookie_value(raw, name):
    cookies = SimpleCookie()
    try:
        cookies.load(raw)
    except CookieError:
        return None
    return cookies[name].value if name in cookies else None


def begin():
    verifier = secrets.token_urlsafe(48)
    state = states.put(verifier)
    challenge = urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    url = "https://github.com/login/oauth/authorize?" + urlencode({
        "client_id": CLIENT_ID, "redirect_uri": REDIRECT, "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    return url, cookie("loom_oauth_state", state, 300)


def finish(state, browser_state, code):
    if not state or not browser_state or not state.isascii() or not browser_state.isascii():
        raise ValueError("Invalid OAuth state")
    if not secrets.compare_digest(state, browser_state):
        raise ValueError("OAuth state mismatch")
    verifier = states.get(state, consume=True)
    if not verifier or not code:
        raise ValueError("Expired or incomplete OAuth login")
    request = Request("https://github.com/login/oauth/access_token", headers={
        "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded",
    }, data=urlencode({
        "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "redirect_uri": REDIRECT,
        "code": code, "code_verifier": verifier,
    }).encode())
    with build_opener(NoRedirect).open(request, timeout=10) as response:
        token = json.load(response).get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("GitHub rejected OAuth login")
    user = api(token, "/user")
    repo = api(token, f"/repos/{REPOSITORY}")
    if type(user.get("id")) is not int or not isinstance(user.get("login"), str):
        raise ValueError("Invalid GitHub account")
    if user.get("type") != "User" or repo.get("permissions", {}).get("push") is not True:
        raise PermissionError("GitHub repository write access is required")
    session = sessions.put({"id": user["id"], "login": user["login"]})
    return cookie("loom_session", session, 3600), cookie("loom_oauth_state", "", 0)
