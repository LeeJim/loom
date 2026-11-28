"""Roll out a verified Loom revision on the existing loom host."""
from contextlib import closing
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

ROOT = Path("/opt/loom")
RELEASES = ROOT / "loom-releases"
SERVICES = {"loom-worker": "worker.py", "loom-console": "console/server.py"}
CONTROLLER = "loom-controller"
SYSTEMD = Path("/etc/systemd/system")


def run(*args):
    subprocess.run(args, check=True)


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def healthy(url, check):
    for _ in range(15):
        try:
            with urlopen(url, timeout=2) as reply:
                if check(json.load(reply)):
                    return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f"Health check failed for {url}")


def replace_file(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        stream.write(content)
        staged = Path(stream.name)
    staged.chmod(0o644)
    staged.replace(path)


def mount_args(release):
    return [
        "--restart", "unless-stopped", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", "192m", "--cpus", "0.5",
        "--env-file", str(ROOT / "secrets/controller.env"), "-e", "HOST=0.0.0.0",
        "-e", "DB_PATH=/data/workflow.sqlite", "-e", "GITHUB_WEBHOOK_SECRET_FILE=/run/github-webhook",
        "-v", f"{ROOT}/secrets/github-webhook:/run/github-webhook:ro",
        "-v", f"{ROOT}/data:/data", "-p", "127.0.0.1:8787:8787",
        f"loom-controller:{release}",
    ]


def rollout(source, revision):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Expected a full Git revision")
    release = RELEASES / revision
    if not release.exists():
        # Move a complete tree into place, excluding the checkout metadata.
        with tempfile.TemporaryDirectory(dir=RELEASES, prefix=".source-") as folder:
            prepared = Path(folder) / "tree"
            shutil.copytree(source, prepared, ignore=shutil.ignore_patterns(".git"), symlinks=True)
            prepared.chmod(0o755)
            prepared.rename(release)
    for module in ("worker.py", "console/server.py", "controller.mjs"):
        if not (release / module).is_file():
            raise RuntimeError(f"Release is missing {module}")
    run("docker", "build", "-f", str(release / "controller.Dockerfile"),
        "-t", f"loom-controller:{revision}", str(release))

    with closing(sqlite3.connect((ROOT / "data/workflow.sqlite").as_uri() + "?mode=ro", uri=True)) as db:
        active = db.execute("SELECT 1 FROM workflow_executions WHERE status='running' LIMIT 1").fetchone()
    if active:
        raise RuntimeError("An execution is active; rerun this deployment when it finishes")

    # Keep the previous container and overrides until the new release is healthy.
    backup_name = CONTROLLER + "-loom-backup-" + str(time.time_ns())
    backup = {}
    replaced = False
    previous_stopped = False
    try:
        run("systemctl", "stop", "loom-worker")
        run("docker", "stop", CONTROLLER)
        previous_stopped = True
        run("docker", "rename", CONTROLLER, backup_name)
        replaced = True
        run("docker", "run", "-d", "--name", CONTROLLER, *mount_args(revision))
        healthy("http://127.0.0.1:8787/healthz", lambda body: body["status"] == "ok")
        for unit, module in SERVICES.items():
            target = SYSTEMD / f"{unit}.service.d/loom-release.conf"
            target.parent.mkdir(parents=True, exist_ok=True)
            backup[target] = target.read_bytes() if target.exists() else None
            config = f"[Service]\nWorkingDirectory={release}\nExecStart=\nExecStart=/usr/bin/python3 {release / module}\n"
            replace_file(target, config.encode())
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", "loom-worker", "loom-console")
        healthy("http://127.0.0.1:8790/api/snapshot", lambda body: "jobs" in body and "metrics" in body)
        run("systemctl", "is-active", "loom-worker", "loom-console")
    except Exception:
        if replaced:
            subprocess.run(["docker", "rm", "-f", CONTROLLER], check=False)
            run("docker", "rename", backup_name, CONTROLLER)
        if previous_stopped:
            run("docker", "start", CONTROLLER)
        for target, previous in backup.items():
            if previous is None:
                target.unlink(missing_ok=True)
            else:
                replace_file(target, previous)
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", "loom-worker", "loom-console")
        raise
    # The previous revision can still be inspected by immutable release SHA.
    run("docker", "rm", backup_name)
    print(f"Deployed Loom revision {revision}", flush=True)


if __name__ == "__main__":
    rollout(Path(sys.argv[1]), sys.argv[2])
