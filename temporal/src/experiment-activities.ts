import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "./artifacts.js";
import type { Artifact } from "./contracts.js";
import { planningPrompt, scorePlan, validateExperiment, type Experiment, type Result, type Variant } from "./experiment.js";
import type { ExperimentActivities } from "./experiment-workflow.js";
import { runOpenCode } from "./opencode.js";

const execute = promisify(execFile);

export function piOutput(output: string): string {
  const events = output.trim().split("\n").map(line => JSON.parse(line));
  const assistant = events.filter(event => event.type === "message_end" && event.message?.role === "assistant").at(-1);
  if (!assistant || ["error", "aborted"].includes(assistant.message.stopReason)) throw new Error("Pi returned no plan");
  return assistant.message.content.filter((item: { type: string }) => item.type === "text")
    .map((item: { text: string }) => item.text).join("\n");
}

async function pi(work: string, config: string, network: string, image: string, model: string, prompt: string) {
  const name = `loom-pi-plan-${randomUUID()}`;
  await writeFile(config, JSON.stringify({ providers: { loom: {
    baseUrl: "http://gateway:4000/v1", api: "openai-completions", apiKey: "sandbox", models: [{ id: model }],
  } } }), { mode: 0o644 });
  try {
    const { stdout } = await execute("docker", [
      "run", "--rm", "--name", name, "--network", network, "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--workdir", "/work",
      "--mount", `type=bind,source=${work},target=/work,readonly`,
      "--mount", `type=bind,source=${config},target=/loom-pi/models.json,readonly`,
      "--user", "1000:1000", "-e", "PI_CODING_AGENT_DIR=/tmp/pi", "-e", "HOME=/tmp",
      "--entrypoint", "/bin/sh", image, "-c",
      'mkdir -p /tmp/pi && cp /loom-pi/models.json /tmp/pi/models.json && exec pi "$@"', "pi",
      "--offline", "--mode", "json", "--no-session", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "read",
      "--provider", "loom", "--model", model, "--", prompt,
    ], { timeout: 240_000, maxBuffer: 2 * 1024 * 1024 });
    return piOutput(stdout);
  } finally {
    await execute("docker", ["rm", "-f", name], { timeout: 10_000 }).catch(() => {});
  }
}

export type SandboxOptions = { work: string; network: string };

export async function readOnlyTrial(options: SandboxOptions, variant: Variant, model: string,
                                    files: Record<string, string>, prompt: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.network)) throw new Error("Invalid experiment network");
  const inspected = await execute("docker", ["network", "inspect", "--format", "{{.Internal}}", options.network]);
  if (inspected.stdout.trim() !== "true") throw new Error("An internal experiment network is required");
  const temp = await mkdtemp(join(await realpath(options.work), "planning-"));
  try {
    if (temp.includes(",")) throw new Error("Invalid work path");
    const work = join(temp, "work");
    for (const [path, content] of Object.entries(files)) {
      const file = join(work, path);
      await mkdir(dirname(file), { recursive: true, mode: 0o755 });
      await writeFile(file, content, { mode: 0o644, flag: "wx" });
    }
    return variant.harness === "opencode"
      ? await runOpenCode({ work, edit: false, model, network: options.network, image: variant.image, prompt })
      : await pi(work, join(temp, "models.json"), options.network, variant.image, model, prompt);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function experimentActivities(options: { data: string; work: string; network: string; db: DatabaseSync }): ExperimentActivities {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(options.network)) throw new Error("Invalid experiment network");
  const artifacts = new ArtifactStore(join(options.data, "artifacts"));
  options.db.exec(`CREATE TABLE IF NOT EXISTS planning_experiment_reports (
    id TEXT PRIMARY KEY, report TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  async function load(snapshot: Artifact) {
    return validateExperiment(JSON.parse((await artifacts.read(snapshot)).toString()) as Experiment);
  }
  return {
    async loadExperiment(snapshot) {
      const spec = await load(snapshot);
      return { model: spec.model, cases: spec.cases.map(row => row.id), variants: spec.variants.map(row => row.id) };
    },
    async evaluate(snapshot, caseId, variantId) {
      const spec = await load(snapshot);
      const entry = spec.cases.find(row => row.id === caseId);
      const variant = spec.variants.find(row => row.id === variantId);
      if (!entry || !variant) throw new Error("Unknown experiment trial");
      const result = { variant: variant.id, caseId, scenario: entry.scenario };
      const start = Date.now();
      let output;
      try {
        output = await readOnlyTrial(options, variant, spec.model, entry.files, planningPrompt(entry, variant));
      } catch {
        return { ...result, elapsedMs: Date.now() - start, score: { passed: false, failures: [] },
          error: "harness_failed" } satisfies Result;
      }
      const artifact = await artifacts.put(output);
      return { ...result, elapsedMs: Date.now() - start, score: scorePlan(output, entry), artifact: artifact.ref };
    },
    async saveReport(report) {
      options.db.prepare("INSERT OR IGNORE INTO planning_experiment_reports(id,report) VALUES (?,?)")
        .run(report.id, JSON.stringify(report));
    },
  };
}
