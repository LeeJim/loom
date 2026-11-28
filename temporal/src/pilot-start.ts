import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GitHubIssue } from "./github.js";
import { Outbox } from "./outbox.js";
import { pilotConfig } from "./pilot-config.js";

const config = await pilotConfig();
const number = Number(process.argv[2]);
if (!Number.isSafeInteger(number) || !config.profiles.has(number)) {
  throw new Error("Usage: npm run pilot:start -- <configured Issue number>");
}
const issue = { repository: config.github.repository, number };
const current = await config.github.repo<GitHubIssue>(config.github.issuePath(issue));
if (current.state !== "open" || current.pull_request) throw new Error("Issue is not open");
await mkdir(config.data, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(config.data, "pilot.sqlite"));
try {
  db.exec("PRAGMA busy_timeout=5000");
  new Outbox(db).enqueue({ kind: "start", issue, delivery: `pilot-start:${issue.repository}:${number}` });
  console.log("Pilot start queued", issue.repository, number);
} finally {
  db.close();
}
