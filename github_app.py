"""Mint repository-scoped GitHub App tokens without persisting them."""
import argparse
from base64 import urlsafe_b64encode
from contextlib import closing
import json
from pathlib import Path
import re
import stat
import subprocess
import time
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

REPOSITORY = "LeeJim/HowToCookOnMiniprogram"
DEFAULT_CONFIG = Path("/opt/loom/secrets/github-app.json")
PERMISSIONS = {"contents": "write", "pull_requests": "write"}
ISSUE_COMMENT_PERMISSIONS = {"issues": "write"}


class MissingIssueWritePermission(ValueError):
    pass


class BotIdentityError(ValueError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(token, path, *, body=None):
    request = Request(
        "https://api.github.com" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Accept": "application/vnd.github+json", "Authorization": "Bearer " + token,
            "Content-Type": "application/json", "User-Agent": "loom-publisher",
            "X-GitHub-Api-Version": "2026-03-10",
        },
    )
    with closing(build_opener(NoRedirect).open(request, timeout=15)) as response:
        return json.load(response)


def encode(raw):
    return urlsafe_b64encode(raw).rstrip(b"=")


def app_jwt(app_id, key_path):
    mode = key_path.stat().st_mode
    if not stat.S_ISREG(mode) or mode & 0o077:
        raise ValueError("GitHub App private key must be a private regular file")
    now = int(time.time())
    header = encode(b'{"alg":"RS256","typ":"JWT"}')
    payload = encode(json.dumps({"iss": app_id, "iat": now - 60, "exp": now + 540}).encode())
    message = header + b"." + payload
    signed = subprocess.run(
        ["/usr/bin/openssl", "dgst", "-sha256", "-sign", str(key_path)],
        input=message, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=10,
    )
    return (message + b"." + encode(signed.stdout)).decode("ascii")


def configured_app_jwt(config_path):
    config = json.loads(Path(config_path).read_text())
    app_id = str(config["app_id"])
    if not re.fullmatch(r"[1-9][0-9]*", app_id):
        raise ValueError("GitHub App ID must be numeric")
    key_path = Path(config["private_key_file"])
    if not key_path.is_absolute():
        raise ValueError("GitHub App private key path must be absolute")
    return app_jwt(app_id, key_path)


def bot_user_id(config_path, token):
    app = api(configured_app_jwt(config_path), "/app")
    slug = app.get("slug")
    if not isinstance(slug, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,100}", slug):
        raise BotIdentityError("GitHub App has no valid slug")
    account = api(token, "/users/" + quote(slug + "[bot]", safe=""))
    if account.get("type") != "Bot" or type(account.get("id")) is not int or account["id"] <= 0:
        raise BotIdentityError("GitHub App bot account has no valid user ID")
    return account["id"]


def installation_token(config_path, *, permissions=PERMISSIONS):
    jwt = configured_app_jwt(config_path)
    installation = api(jwt, f"/repos/{REPOSITORY}/installation")
    if permissions == ISSUE_COMMENT_PERMISSIONS and installation.get("permissions", {}).get("issues") != "write":
        raise MissingIssueWritePermission("GitHub App installation requires Issues: write")
    installation_id = installation["id"]
    if type(installation_id) is not int or installation_id <= 0:
        raise ValueError("Invalid GitHub App installation")
    result = api(jwt, f"/app/installations/{installation_id}/access_tokens", body={
        "repositories": [REPOSITORY.split("/", 1)[1]], "permissions": permissions,
    })
    if any(result["permissions"].get(name) != access for name, access in permissions.items()):
        raise ValueError("Missing requested GitHub App permissions")
    token = result["token"]
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", token):
        raise ValueError("Unexpected GitHub installation token format")
    return token


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verify repository-scoped GitHub App authentication")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    token = installation_token(args.config)
    repo = api(token, f"/repos/{REPOSITORY}")
    if repo["full_name"].casefold() != REPOSITORY.casefold():
        raise SystemExit("GitHub installation authentication returned a different repository")
    print(f"GitHub App authenticated for {REPOSITORY}; Contents and Pull requests write permissions available.")
