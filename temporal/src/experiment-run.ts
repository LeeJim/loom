import { Client, Connection, WorkflowIdReusePolicy } from "@temporalio/client";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ArtifactStore } from "./artifacts.js";
import { validateExperiment, type Experiment } from "./experiment.js";
import { experimentActivities } from "./experiment-activities.js";
import type { comparePlanningAgents } from "./experiment-workflow.js";

const [manifest, runKey] = process.argv.slice(2);
if (!manifest || !runKey || !/^[A-Za-z0-9_-]{1,40}$/.test(runKey)) {
  throw new Error("Usage: npm run experiment -- <manifest.json> <run-key>");
}
const data = process.env.LOOM_EXPERIMENT_DATA;
const workspace = process.env.LOOM_EXPERIMENT_WORKSPACE;
if (!data || !workspace || !isAbsolute(data) || !isAbsolute(workspace) || data === workspace) {
  throw new Error("Set separate absolute experiment data and workspace paths");
}
const address = process.env.TEMPORAL_ADDRESS || "127.0.0.1:7233";
const namespace = process.env.TEMPORAL_NAMESPACE || "default";
const network = process.env.LOOM_EXPERIMENT_NETWORK || "loom-experiments";
const spec = validateExperiment(JSON.parse(await readFile(manifest, "utf8")) as Experiment);
await mkdir(data, { recursive: true, mode: 0o700 });
await mkdir(workspace, { recursive: true, mode: 0o700 });
const store = new ArtifactStore(join(data, "artifacts"));
const snapshot = await store.put(JSON.stringify(spec));
const dbPath = join(data, "experiments.sqlite");
const db = new DatabaseSync(dbPath);
await chmod(dbPath, 0o600);

const connection = await Connection.connect({ address });
const native = await NativeConnection.connect({ address });
try {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  const taskQueue = `loom-planning-experiments-${createHash("sha256").update(data).digest("hex").slice(0, 16)}`;
  const worker = await Worker.create({
    connection: native, namespace, taskQueue, maxConcurrentActivityTaskExecutions: 2,
    workflowsPath: fileURLToPath(new URL("./experiment-workflow.js", import.meta.url)),
    activities: experimentActivities({ data, work: workspace, network, db }),
  });
  const client = new Client({ connection, namespace });
  const workflowId = `loom-exp/${snapshot.sha256.slice(0, 20)}/${runKey}`;
  const report = await worker.runUntil(async () => {
    try {
      const run = await client.workflow.start<typeof comparePlanningAgents>("comparePlanningAgents", {
        workflowId, taskQueue, args: [snapshot], workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
      return run.result();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "WorkflowExecutionAlreadyStartedError") throw error;
      return client.workflow.getHandle<typeof comparePlanningAgents>(workflowId).result();
    }
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
  await Promise.all([native.close(), connection.close()]);
}
