"""Read the model gateway, MCP and SkillHub capability catalogs."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
from pathlib import Path
from urllib.request import Request, urlopen

DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
_MAX_RESPONSE_BYTES = 256 * 1024


def _load(handle):
    data = handle.read(_MAX_RESPONSE_BYTES + 1)
    if len(data) > _MAX_RESPONSE_BYTES:
        raise ValueError("Capability response exceeds size limit")
    return json.loads(data)


def _request(url, payload=None, bearer=None):
    headers = {"Accept": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    if payload is not None:
        headers.update({"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    request = Request(url, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    with urlopen(request, timeout=3) as response:
        if response.headers.get_content_type() == "text/event-stream":
            data = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(data) > _MAX_RESPONSE_BYTES:
                raise ValueError("Capability response exceeds size limit")
            return next(json.loads(line[6:]) for line in data.splitlines() if line.startswith(b"data: "))
        return _load(response)


def _models(url):
    payload = _request(url.rstrip("/") + "/models", bearer=os.environ.get("LOOM_GATEWAY_STATUS_TOKEN"))
    return [{"id": row["id"]} for row in payload["data"] if isinstance(row.get("id"), str)]


def _mcp(url):
    payload = _request(url, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    return [{"name": row["name"], "description": str(row.get("description", ""))[:500]}
            for row in payload["result"]["tools"] if isinstance(row.get("name"), str)]


def skills(source):
    if source.startswith(("https://", "http://")):
        payload = _request(source, bearer=os.environ.get("LOOM_SKILLHUB_TOKEN"))
    else:
        with Path(source).open("rb") as handle:
            payload = _load(handle)
    entries = payload if isinstance(payload, list) else payload["skills"]
    result = []
    for row in entries:
        if not isinstance(row, dict):
            continue
        name, version = row.get("id", row.get("name")), row.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            continue
        selection = {"id": name, "version": version}
        try:
            skill_files([selection])
        except ValueError:
            installed = False
        else:
            installed = True
        result.append({**selection, "installed": installed, "description": str(row.get("description", ""))[:500]})
    return result


def _section(probe, source):
    if not source:
        return {"status": "unconfigured", "items": []}
    try:
        return {"status": "available", "items": probe(source)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, StopIteration):
        return {"status": "unavailable", "items": []}


def snapshot():
    sections = {
        "llm": (_models, os.environ.get("LOOM_GATEWAY_STATUS_URL", "http://127.0.0.1:4000/v1")),
        "mcp": (_mcp, os.environ.get("LOOM_MCP_STATUS_URL")),
        "skills": (skills, os.environ.get("LOOM_SKILLHUB_CATALOG")),
    }
    with ThreadPoolExecutor(max_workers=len(sections)) as executor:
        results = {name: executor.submit(_section, probe, source) for name, (probe, source) in sections.items()}
        result = {name: future.result() for name, future in results.items()}
    result["llm"]["configured_default"] = os.environ.get("LOOM_AGENT_DEFAULT_MODEL", DEFAULT_MODEL)
    return result


def skill_files(selected):
    """Resolve version-pinned, operator-installed skills for a sandbox."""
    paths = []
    root = Path(os.environ.get("LOOM_SKILLHUB_SKILLS_DIR", "/opt/loom/skills")).resolve()
    for item in selected:
        if not isinstance(item, dict):
            raise ValueError("Expected SkillHub skill ID and version")
        name, version = item.get("id"), item.get("version")
        if (not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name)
                or not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}", version)):
            raise ValueError("Invalid SkillHub skill ID or version")
        skill = root / name / version
        if skill.resolve() != skill or not (skill / "SKILL.md").is_file() or (skill / "SKILL.md").is_symlink():
            raise ValueError(f"SkillHub skill is not installed: {name}@{version}")
        paths.append((name, version, skill))
    return paths



class ModelCatalogUnavailable(ValueError):
    pass


class ModelUnavailable(ValueError):
    pass

def require_model(model):
    """Check an explicit selection against the operator's active gateway catalog."""
    if model is None:
        return
    url = os.environ.get("LOOM_GATEWAY_STATUS_URL", "http://127.0.0.1:4000/v1")
    result = _section(_models, url)
    if result["status"] != "available":
        raise ModelCatalogUnavailable("AgentGateway model catalog is unavailable")
    if not any(row["id"] == model for row in result["items"]):
        raise ModelUnavailable("Model is not supported by AgentGateway")
