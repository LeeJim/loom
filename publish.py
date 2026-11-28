"""Publish an explicitly enabled delivery as a draft on the configured repository."""
from base64 import b64encode
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlencode

from run_docs import REPO, ROOT, command

from github_app import REPOSITORY, api, installation_token


def github(token, endpoint, *, body=None):
    return api(token, f"/repos/{REPOSITORY}{endpoint}", body=body)


def prepare(number, data, approved_files, checkout, *, repository=REPO):
    patch = data / f"issue-{number}.patch"
    metadata = json.loads(patch.with_suffix(".json").read_text())
    if sha256(patch.read_bytes()).hexdigest() != metadata["sha256"]:
        raise ValueError("Delivery patch digest mismatch")
    command("git", "clone", "--depth", "1", "--single-branch", "--branch", "main", repository, str(checkout))
    if command("git", "rev-parse", "HEAD", cwd=checkout).strip() != metadata["base"]:
        raise ValueError("The patch base changed")
    command("git", "apply", "--index", str(patch), cwd=checkout)
    changed = set(command("git", "diff", "--cached", "--name-only", "-z", cwd=checkout).strip("\0").split("\0"))
    if not changed or not changed <= set(approved_files):
        raise ValueError("Delivery patch changed unapproved files")
    if command("git", "diff", "--cached", "--summary", cwd=checkout):
        raise ValueError("Delivery patch changed file types or modes")
    command("git", "diff", "--cached", "--check", cwd=checkout)
    env = os.environ | {
        "GIT_AUTHOR_NAME": "loom", "GIT_COMMITTER_NAME": "loom",
        "GIT_AUTHOR_EMAIL": "loom@users.noreply.github.com",
        "GIT_COMMITTER_EMAIL": "loom@users.noreply.github.com",
        "GIT_AUTHOR_DATE": metadata["created_at"], "GIT_COMMITTER_DATE": metadata["created_at"],
    }
    command("git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
            "commit", "-m", f"loom: implement issue #{number}", cwd=checkout, env=env)
    return command("git", "rev-parse", "HEAD", cwd=checkout).strip(), metadata["sha256"]


def verify_publish_label(db, number, token):
    enabled = db.execute("SELECT approved FROM publication_approvals WHERE issue_number=?", (number,)).fetchone()
    if enabled != (1,):
        raise ValueError("Issue publication authorization was revoked")
    issue = github(token, f"/issues/{number}")
    if issue["state"] != "open" or not any(label["name"] == "loom:publish" for label in issue["labels"]):
        raise ValueError("The open Issue must still carry the publishing label")


def publish(db, number, data, approved_files, app_config, *, require_label=False):
    with tempfile.TemporaryDirectory(dir=ROOT, prefix="publish-") as temp:
        checkout = Path(temp) / "checkout"
        sha, digest = prepare(number, data, approved_files, checkout)
        branch = f"codex/loom-issue-{number}-{digest[:12]}"
        token = installation_token(app_config)
        if require_label:
            verify_publish_label(db, number, token)
        basic = b64encode(f"x-access-token:{token}".encode()).decode("ascii")
        env = os.environ | {
            "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "2",
            "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": "Authorization: Basic " + basic,
            "GIT_CONFIG_KEY_1": "http.followRedirects", "GIT_CONFIG_VALUE_1": "false",
        }
        remote = command("git", "ls-remote", "origin", f"refs/heads/{branch}", cwd=checkout, env=env)
        if not remote:
            command("git", "push", f"--force-with-lease=refs/heads/{branch}:", "origin",
                    f"{sha}:refs/heads/{branch}", cwd=checkout, env=env)
        elif remote.split()[0] != sha:
            raise ValueError("The release branch already exists with different content")
        query = urlencode({"head": f"LeeJim:{branch}", "base": "main", "state": "all"})
        existing = github(token, "/pulls?" + query)
        if existing:
            pr = existing[0]
        else:
            if require_label:
                verify_publish_label(db, number, token)
            pr = github(token, "/pulls", body={
                "title": f"loom: Issue #{number}", "head": branch, "base": "main", "draft": True,
                "body": f"关联 #{number}。由 loom 沙箱生成并通过本地补丁检查。",
            })
        pr_number = pr["number"]
        url = f"https://github.com/{REPOSITORY}/pull/{pr_number}"
        if pr["head"]["sha"] != sha or pr["html_url"] != url:
            raise ValueError("Unexpected pull request response")
        with db:
            db.execute("""INSERT OR IGNORE INTO pr_deliveries(issue_number,pr_number,pr_url,head_sha)
                          VALUES (?,?,?,?)""", (number, pr_number, url, sha))
            receipt = db.execute("SELECT pr_number,pr_url,head_sha FROM pr_deliveries WHERE issue_number=?",
                                 (number,)).fetchone()
            if receipt != (pr_number, url, sha):
                raise ValueError("Existing receipt differs from the published draft")
        print(f"Issue #{number}: draft delivery {url}", flush=True)
