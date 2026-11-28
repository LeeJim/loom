import { Client, Connection } from "@temporalio/client";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { issueClient } from "./client.js";
import { verifySignature } from "./ingress.js";
import { Outbox } from "./outbox.js";
import { pilotConfig } from "./pilot-config.js";
import { pilotEvent } from "./pilot-events.js";

const config = await pilotConfig();
const secretPath = process.env.GITHUB_WEBHOOK_SECRET_FILE;
if (!secretPath) throw new Error("Set GITHUB_WEBHOOK_SECRET_FILE");
const secret = Buffer.from((await readFile(secretPath, "utf8")).trim());
if (!secret.length) throw new Error("Empty webhook secret");
await mkdir(config.data, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(config.data, "pilot.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
const outbox = new Outbox(db);
const connection = await Connection.connect({ address: config.address });
const temporal = issueClient(new Client({ connection, namespace: config.namespace }), config.taskQueue);

let activeDispatch: Promise<unknown> | undefined;
const timer = setInterval(() => {
  activeDispatch ??= outbox.dispatch(temporal)
    .catch(error => console.error("Outbox dispatch delayed", (error as Error).name))
    .finally(() => { activeDispatch = undefined; });
}, 1_000);

const server = createServer(async (req, res) => {
  function reply(status: number) { res.writeHead(status).end(); }
  if (req.method !== "POST" || req.url !== "/webhooks/github") return reply(404);
  const signature = req.headers["x-hub-signature-256"];
  const delivery = req.headers["x-github-delivery"];
  const event = req.headers["x-github-event"];
  if (typeof signature !== "string" || typeof event !== "string" || typeof delivery !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(delivery)) return reply(400);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      if ((size += chunk.length) > 1024 * 1024) return reply(413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, signature, secret)) return reply(401);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); }
    catch { return reply(400); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400);
    const verified = await pilotEvent(config.github, config.profiles, event, delivery, parsed);
    if (verified) outbox.enqueue(verified);
    reply(202);
  } catch (error) {
    console.error("Pilot webhook failed", (error as Error).name);
    reply(503);
  }
});
server.listen(Number(process.env.LOOM_TEMPORAL_PORT ?? "8788"), "127.0.0.1");

function shutdown() {
  clearInterval(timer);
  server.close(async () => {
    await activeDispatch;
    db.close();
    await connection.close();
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
