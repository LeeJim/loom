import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "./artifacts.js";
import { recordActivities } from "./activity-records.js";
import { pilotActivities } from "./activity-adapter.js";
import { pilotConfig } from "./pilot-config.js";
import { runWorker } from "./worker.js";

const config = await pilotConfig();
const concurrency = Number(process.env.LOOM_MAX_PARALLEL_WORKERS ?? "2");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
  throw new Error("Invalid LOOM_MAX_PARALLEL_WORKERS");
}
await mkdir(config.workspace, { recursive: true, mode: 0o700 });
await mkdir(config.data, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(config.data, "pilot.sqlite"));
try {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS temporal_ci_receipts (
      issue_number INTEGER NOT NULL,
      run_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      PRIMARY KEY(run_id, attempt)
    );
  `);
  const activities = recordActivities(db, pilotActivities({
    ...config,
    artifacts: new ArtifactStore(join(config.data, "artifacts")),
    recordCi: async (issue, draft, ci) => {
      db.prepare("INSERT OR IGNORE INTO temporal_ci_receipts VALUES (?,?,?,?,?,?)")
        .run(issue.number, ci.runId, ci.attempt, draft.number, draft.headSha, ci.conclusion);
    },
  }));
  await runWorker(activities, { ...config, concurrency });
} finally {
  db.close();
}
