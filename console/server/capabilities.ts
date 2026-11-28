import { readFile, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

const maxBytes = 256 * 1024;
const gateway = () => process.env.LOOM_GATEWAY_STATUS_URL || "http://127.0.0.1:4000/v1";
const defaultModel = () => process.env.LOOM_AGENT_DEFAULT_MODEL || "deepseek/deepseek-v4-flash";

async function document(url: string, token?: string, body?: object) {
  const response = await fetch(url, {
    redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}) },
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok || !response.body) throw new Error("Capability probe failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBytes) throw new Error("Capability response too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text.split("\n").find(line => line.startsWith("data: "))?.slice(6) || "");
  }
  return JSON.parse(text);
}

const entries = (input: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(input)) throw new Error("Invalid capability response");
  return input.filter(item => item && typeof item === "object");
};

async function models() {
  const reply = await document(gateway().replace(/\/$/, "") + "/models", process.env.LOOM_GATEWAY_STATUS_TOKEN);
  return entries(reply.data).flatMap(row => typeof row.id === "string" ? [{ id: row.id }] : []);
}

export class ModelUnavailable extends Error {}
export class ModelCatalogUnavailable extends Error {}
export async function availableModel(model: string) {
  const list = await models().catch(() => { throw new ModelCatalogUnavailable(); });
  if (!list.some(item => item.id === model)) throw new ModelUnavailable();
}

export async function installedSkill(id: unknown, version: unknown): Promise<boolean> {
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
      typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) return false;
  try {
    const root = await realpath(resolve(process.env.LOOM_SKILLHUB_SKILLS_DIR || "/opt/loom/skills"));
    const directory = join(root, id, version);
    return await realpath(directory) === directory && (await lstat(join(directory, "SKILL.md"))).isFile();
  } catch { return false; }
}

async function section<T>(source: string | undefined, probe: (source: string) => Promise<T[]>) {
  if (!source) return { status: "unconfigured", items: [] };
  try { return { status: "available", items: await probe(source) }; }
  catch { return { status: "unavailable", items: [] }; }
}

export async function capabilities() {
  const [llm, mcp, skills] = await Promise.all([
    section(gateway(), models),
    section(process.env.LOOM_MCP_STATUS_URL, async url => {
      const data = await document(url, undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      return entries(data.result.tools).flatMap(row => typeof row.name === "string"
        ? [{ name: row.name, description: String(row.description || "").slice(0, 500) }] : []);
    }),
    section(process.env.LOOM_SKILLHUB_CATALOG, async source => {
      let data;
      if (/^https?:\/\//.test(source)) {
        data = await document(source, process.env.LOOM_SKILLHUB_TOKEN);
      } else {
        const content = await readFile(source);
        if (content.length > maxBytes) throw new Error("Catalog too large");
        data = JSON.parse(content.toString());
      }
      const list = entries(Array.isArray(data) ? data : data.skills);
      return Promise.all(list.filter(item => typeof (item.id ?? item.name) === "string" && typeof item.version === "string")
        .slice(0, 300).map(async item => {
          const id = String(item.id ?? item.name);
          const version = String(item.version);
          return { id, version, description: String(item.description || "").slice(0, 500),
            installed: await installedSkill(id, version) };
        }));
    }),
  ]);
  return { llm: { ...llm, configured_default: defaultModel() }, mcp, skills };
}
