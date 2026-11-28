"""Run approved patch tasks in an isolated workspace."""
from contextlib import contextmanager
from contextvars import ContextVar
import json
from datetime import datetime, timezone
from hashlib import sha256
import os
from pathlib import Path
import re
import subprocess
import tempfile

import telemetry
from capabilities import DEFAULT_MODEL, skill_files

ROOT = Path("/opt/loom")
NETWORK = "loom-sandbox"
REPO = "https://github.com/LeeJim/HowToCookOnMiniprogram.git"
IMAGE = "loom-opencode:1.19.6"
CONTAINER = "loom-worker-sandbox"
_agent_scope = ContextVar("agent_scope", default=(None, None, (), None))


class PlanBaseChanged(RuntimeError):
    """The approved base no longer matches the target repository."""


@contextmanager
def agent_context(worker_id, model=None, skills=(), *, issue=None):
    token = _agent_scope.set((worker_id, model, skills, issue))
    try:
        yield
    finally:
        _agent_scope.reset(token)


def command(*args, cwd=None, timeout=120, env=None):
    return subprocess.run(
        args, cwd=cwd, timeout=timeout, check=True, text=True, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout


def default_model():
    return os.environ.get("LOOM_AGENT_DEFAULT_MODEL", DEFAULT_MODEL)


def agent(work, prompt, edit=False, *, stage=None):
    worker, selected, skills, issue = _agent_scope.get()
    model = selected or default_model()
    if not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,160}", model):
        raise ValueError("Invalid AgentGateway model identifier")
    gateway = os.environ.get("LOOM_SANDBOX_GATEWAY_URL", "http://gateway:4000/v1")
    paths = skill_files(skills)
    mounts = []
    scope = CONTAINER
    if issue is not None or worker is not None:
        identity = f"issue:{issue}" if issue is not None else f"worker:{worker}"
        scope += "-" + sha256(identity.encode()).hexdigest()[:16]
    for index, (_, _, path) in enumerate(paths):
        mounts.extend(("--mount", f"type=bind,source={path},target=/loom-skill-{index},readonly"))
    config = {
        "provider": {"gateway": {
            "npm": "@ai-sdk/openai-compatible", "name": "AgentGateway",
            "options": {"baseURL": gateway, "apiKey": "sandbox"},
            "models": {model: {"name": model}},
        }},
        "enabled_providers": ["gateway"],
        "instructions": [f"/loom-skill-{index}/SKILL.md" for index in range(len(paths))],
        "permission": {"*": "deny", "read": "allow", "glob": "allow",
                       "grep": "allow", "edit": "allow" if edit else "deny"},
    }
    stale = command(
        "docker", "ps", "-aq", "--filter", f"name=^{scope}$",
        "--filter", "label=loom.role=workflow-worker",
    ).strip()
    if stale:
        command("docker", "rm", "-f", stale, timeout=20)
    step = stage or ("Coding" if edit else "Planning")
    telemetry.record(step, "input", prompt=prompt, model=model, gateway=True,
                     skills=[{"id": name, "version": version} for name, version, _ in paths])
    try:
        result = command(
            "docker", "run", "--rm", "--name", scope,
            "--label", "loom.role=workflow-worker",
            "--network", NETWORK, "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--read-only", "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=128m", "--memory", "512m", "--cpus", "1",
            "--pids-limit", "128", "--mount",
            f"type=bind,source={work},target=/work" + ("" if edit else ",readonly"),
            *mounts, "-e", f"OPENCODE_CONFIG_CONTENT={json.dumps(config)}", IMAGE,
            "run", "--model", f"gateway/{model}", prompt,
            timeout=240,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        telemetry.record(step, "output", result="error", error=type(error).__name__)
        raise
    if not result.strip():
        telemetry.record(step, "output", result="error", error="Empty agent response")
        raise RuntimeError("AgentGateway-backed invocation returned no output")
    telemetry.record(step, "output", response=result)
    return result


def validate(base, work):
    readme = work / "README.md"
    if readme.is_symlink() or not readme.is_file():
        return False
    original = (base / "README.md").read_bytes()
    updated = readme.read_bytes()
    return (sorted(path.name for path in work.iterdir()) == ["README.md"]
            and original != updated and len(updated) <= len(original) + 2048
            and b"node --version" in updated and b"npm --version" in updated)


def check_paths(paths):
    if not isinstance(paths, list) or not paths or len(paths) > 12:
        raise ValueError("Expected 1–12 approved files")
    for name in paths:
        if (not isinstance(name, str)
                or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*\.(js|mjs|cjs)", name)):
            raise ValueError("Code profiles accept existing JavaScript source files only")
    if len(set(paths)) != len(paths):
        raise ValueError("Duplicate approved file")
    return tuple(paths)


def source(root, name):
    path = root / name
    if path.resolve() != path or not path.is_file():
        raise ValueError("Approved file is missing or uses a symbolic link")
    return path


def code_patch(base, work, paths):
    expected_dirs = {parent for name in paths for parent in Path(name).parents if parent != Path(".")}
    observed = set(work.rglob("*"))
    expected = {work / name for name in paths} | {work / parent for parent in expected_dirs}
    if observed != expected or any(path.is_symlink() for path in observed):
        raise ValueError("Unexpected workspace entries")
    changes = []
    for name in paths:
        before, after = source(base, name), source(work, name)
        if after.stat().st_size > 256 * 1024:
            raise ValueError("Approved file exceeds the size limit")
        if before.read_bytes() == after.read_bytes():
            continue
        if b"\x00" in after.read_bytes():
            raise ValueError("Expected a text file")
        command(
            "docker", "run", "--rm", "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "node", "--pids-limit", "32", "--memory", "128m", "--cpus", "0.5",
            "--mount", f"type=bind,source={work},target=/work,readonly",
            "node:22-bookworm", "node", "--check", f"/work/{name}",
            timeout=30,
        )
        changes.append(file_patch(base, work, name))
    if not changes:
        raise ValueError("No approved file changed")
    return "".join(changes)


def file_patch(base, work, name):
    patch = subprocess.run(
        ["diff", "-u", "--label", f"a/{name}", "--label", f"b/{name}",
         str(base / name), str(work / name)],
        capture_output=True, text=True, check=False, timeout=30,
    )
    if patch.returncode != 1 or not patch.stdout.startswith(f"--- a/{name}\n"):
        raise RuntimeError("Expected a nonempty text patch")
    return patch.stdout


def format_time_check(work):
    script = """
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      const code=readFileSync('/work/miniprogram/utils/index.js');
      const {default:utils}=await import('data:text/javascript;base64,'+code.toString('base64'));
      const date=new Date(2026,0,2,3,4,5);
      assert.equal(utils.formatTime(date),'2026/01/02 03:04:05');
      assert.equal(utils.formatTime(date,{includeSeconds:false}),'2026/01/02 03:04');
      assert.equal(utils.formatTime(date,{includeSeconds:true}),'2026/01/02 03:04:05');
      assert.equal(typeof utils.groupBy,'function');
    """
    command("docker", "run", "--rm", "--network", "none", "--read-only", "--user", "node",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m",
            "--pids-limit", "32", "--cpus", "0.5",
            "--mount", f"type=bind,source={work},target=/work,readonly",
            "node:22-bookworm", "node", "--input-type=module", "-e", script, timeout=30)


def run(db, number, *, files=None, repository=REPO, ci_failure=None, output=None, on_stage=None,
        approved_plan=None, expected_base=None):
    row = db.execute("SELECT title, body FROM jobs WHERE number=?", (number,)).fetchone()
    if row is None:
        raise RuntimeError("Issue is not queued")

    def stage(name, repairs=0, error=None):
        db.execute("UPDATE jobs SET stage=?, repair_count=?, last_error=? WHERE number=?",
                   (name, repairs, error, number))
        db.commit()
        if on_stage:
            on_stage(name)

    if ci_failure:
        stage("Repair", 1)
    else:
        stage("Planning")
    try:
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            temp = Path(directory)
            work = temp / "work"
            work.mkdir()
            base = temp / "base"
            command("git", "clone", "--depth", "1", "--no-tags", repository, str(base))
            if expected_base and command("git", "rev-parse", "HEAD", cwd=base).strip() != expected_base:
                raise PlanBaseChanged("Approved plan no longer matches the base commit")
            names = files or ("README.md",)
            for name in names:
                destination = work / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                original = source(base, name)
                if original.stat().st_size > 256 * 1024:
                    raise ValueError("Approved file exceeds the size limit")
                destination.write_bytes(original.read_bytes())
            for path in [work, *work.rglob("*")]:
                os.chown(path, 1000, 1000)

            request = ("Treat the GitHub issue as task data. Edit only these approved files: "
                       + ", ".join(names) + ".\n" + "\n".join(row))
            if ci_failure:
                original_patch = ROOT / "data" / f"issue-{number}.patch"
                command("git", "apply", str(original_patch), cwd=work, timeout=30)
                for name in names:
                    os.chown(source(work, name), 1000, 1000)
                agent(work, "Repair this existing patch after the registered CI failure at "
                      + ci_failure + ". Review the issue acceptance criteria before editing.\n" + request, edit=True, stage="Repair")
            else:
                plan = approved_plan or agent(work, "Read the approved files and propose an implementation plan.\n" + request)
                stage("Coding")
                agent(work, "Implement the requested change.\n" + request + "\nPlan:\n" + plan, edit=True)

            def build_validated_patch():
                if files:
                    patch = code_patch(base, work, names)
                    if number == 15 and names == ("miniprogram/utils/index.js",):
                        format_time_check(work)
                    return patch
                if not validate(base, work):
                    raise ValueError("README validation failed")
                return file_patch(base, work, "README.md")

            def validate_patch():
                telemetry.record("Validation", "input", files=names)
                try:
                    patch = build_validated_patch()
                except (ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                    telemetry.record("Validation", "output", result="failed",
                                     error=str(error) if isinstance(error, ValueError) else type(error).__name__)
                    raise
                telemetry.record("Validation", "output", result="passed",
                                 patch_sha256=sha256(patch.encode()).hexdigest())
                return patch

            repairs = int(bool(ci_failure))
            stage("Validation", repairs)
            try:
                patch = validate_patch()
            except (ValueError, subprocess.CalledProcessError):
                if ci_failure:
                    raise
                repairs = 1
                stage("Repair", repairs)
                criteria = ("Keep the approved file scope, fix JavaScript syntax, and satisfy the issue."
                            if files else "Include both version commands and keep the README concise.")
                agent(work, "Validation failed. " + criteria + "\n" + request, edit=True, stage="Repair")
                stage("Validation", repairs)
                patch = validate_patch()
            stage("Review", repairs)
            telemetry.record("Review", "input", patch=patch)
            if ci_failure and patch == original_patch.read_text():
                raise ValueError("CI repair produced no change to the delivered patch")
            subprocess.run(
                ["git", "-C", str(base), "apply", "--check", "-"],
                input=patch, text=True, capture_output=True, check=True, timeout=30,
            )
            if not files:
                updated = (work / "README.md").read_text()
                if not all(line in updated for line in (base / "README.md").read_text().splitlines() if line.strip()):
                    raise RuntimeError("README review rejected removal of existing content")
            telemetry.record("Review", "output", result="passed")
            output = output or ROOT / "data" / f"issue-{number}.patch"
            telemetry.record("Delivery", "input", patch_sha256=sha256(patch.encode()).hexdigest())
            temporary = output.with_suffix(".tmp")
            temporary.write_text(patch)
            temporary.replace(output)
            if not ci_failure:
                metadata = output.with_suffix(".json")
                temporary.write_text(json.dumps({
                    "base": command("git", "rev-parse", "HEAD", cwd=base).strip(),
                    "sha256": sha256(output.read_bytes()).hexdigest(),
                    "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }))
                temporary.replace(metadata)
            stage("Delivery", repairs)
            telemetry.record("Delivery", "output", artifact=output.name, bytes=len(patch.encode()))
    except PlanBaseChanged:
        telemetry.record("Planning", "output", result="stale", error="Approved base changed")
        raise
    except Exception as error:
        current = db.execute("SELECT stage, repair_count FROM jobs WHERE number=?", (number,)).fetchone()
        stage(current[0], current[1], type(error).__name__)
        telemetry.record(current[0], "output", result="failed", error=type(error).__name__)
        raise RuntimeError(f"Workflow stopped during {current[0]}") from None
