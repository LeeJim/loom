import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { consoleServer } from "./http.js";
import { OAuth } from "./oauth.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "loom-console-test-"));
  const path = join(directory, "workflow.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE jobs(number INTEGER PRIMARY KEY,title TEXT,stage TEXT,repair_count INTEGER,last_error TEXT);
    CREATE TABLE workflow_executions(id INTEGER PRIMARY KEY,issue_number INTEGER,kind TEXT,status TEXT,
        started_at TEXT,finished_at TEXT,error TEXT);
    CREATE TABLE workflow_stage_events(id INTEGER PRIMARY KEY,execution_id INTEGER,stage TEXT,recorded_at TEXT);
    CREATE TABLE workflow_artifacts(id INTEGER PRIMARY KEY,execution_id INTEGER,stage TEXT,direction TEXT,payload TEXT,recorded_at TEXT);
    CREATE TABLE worker_heartbeat(id INTEGER PRIMARY KEY,checked_at TEXT);
    CREATE TABLE pr_deliveries(issue_number INTEGER,pr_number INTEGER);
    CREATE TABLE publications(issue_number INTEGER,status TEXT,error TEXT);
    CREATE TABLE publication_approvals(issue_number INTEGER,approved INTEGER);
    CREATE TABLE worker_profiles(issue_number INTEGER PRIMARY KEY);
    CREATE TABLE manual_runs(issue_number INTEGER PRIMARY KEY,status TEXT,requested_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE issue_plans(issue_number INTEGER,comment_url TEXT,state TEXT,error TEXT);
    CREATE TABLE ci_validations(run_id INTEGER PRIMARY KEY,issue_number INTEGER,conclusion TEXT);
    CREATE TABLE ci_validation_attempts(run_id INTEGER,attempt INTEGER,conclusion TEXT,recorded_at TEXT);
    CREATE TABLE ci_repairs(run_id INTEGER,attempt INTEGER,status TEXT,error TEXT,patch_path TEXT);
    CREATE TABLE loom_workers(id TEXT PRIMARY KEY,owner_id INTEGER,name TEXT,issue_number INTEGER,model TEXT,skills TEXT,state TEXT,last_seen_at TEXT);
    CREATE TABLE loom_issue_claims(issue_number INTEGER,worker_id TEXT);
    CREATE TABLE loom_worker_actions(id INTEGER PRIMARY KEY,worker_id TEXT,actor_id INTEGER,action TEXT,recorded_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE webhook_deliveries(id TEXT PRIMARY KEY,event TEXT,received_at TEXT);
    INSERT INTO webhook_deliveries VALUES ('fixture','issues','2026-01-01 00:00:00');
    INSERT INTO worker_profiles VALUES (13);
    INSERT INTO jobs VALUES (13,'Example','Planning',0,NULL);
    INSERT INTO workflow_executions VALUES (1,13,'plan_review','completed','2026-01-01 00:00:00',NULL,NULL);
    INSERT INTO workflow_stage_events VALUES (1,1,'Planning','2026-01-01 00:00:00');
    INSERT INTO workflow_artifacts VALUES (1,1,'Planning','output','{"plan":"fixture"}','2026-01-01 00:00:00');
  `);
  db.close();
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function githubStub() {
  let authorize = true;
  const mock = (async (url: string) => {
    if (url.includes("access_token")) return Response.json({ access_token: "fixture" });
    if (url.endsWith("/user")) return Response.json({ id: 1, login: "maintainer", type: "User" });
    return Response.json({ permissions: { push: authorize } });
  }) as typeof fetch;
  return { oauth: new OAuth("https://console.test", "fixture", "secret", mock), revoke: () => { authorize = false; } };
}

async function client(database: string, oauth: OAuth) {
  const server = consoleServer({ database, oauth });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  return {
    call(path: string, options: { host?: string; method?: string; cookie?: string; origin?: string; body?: object } = {}) {
      return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
        const data = options.body === undefined ? undefined : JSON.stringify(options.body);
        const req = request({ host: "127.0.0.1", port: address.port, path, method: options.method ?? "GET",
          headers: {
            Host: options.host ?? `127.0.0.1:${address.port}`,
            ...(options.cookie ? { Cookie: options.cookie } : {}),
            ...(options.origin ? { Origin: options.origin } : {}),
            ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          },
        }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers,
            text: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        req.end(data);
      });
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("existing SQLite snapshot and execution records survive the Node rollout", async () => {
  const data = await fixture();
  const http = await client(data.path, new OAuth("https://console.test"));
  try {
    const snapshot = await http.call("/api/snapshot");
    assert.equal(snapshot.status, 200);
    assert.equal(JSON.parse(snapshot.text).jobs[0].number, 13);
    const result = await http.call("/api/executions/1");
    assert.equal(JSON.parse(result.text).artifacts[0].payload.plan, "fixture");
    assert.equal((await http.call("/api/snapshot", { host: "console.test" })).status, 401);
    assert.equal((await http.call("/api/workers")).status, 401);
    const logs = await http.call("/api/snapshot?view=logs&issue=13");
    assert.equal(logs.status, 200);
    assert.deepEqual(JSON.parse(logs.text).entries.map((row: { source: string }) => row.source).sort(),
      ["execution", "stage"]);
    assert.equal((await http.call("/api/snapshot?view=logs", { host: "console.test" })).status, 401);
    assert.equal((await http.call("/api/snapshot?view=logs&issue=invalid")).status, 400);
  } finally { await http.close(); await data.cleanup(); }
});

test("direct page loads return the React app while unknown APIs return 404", async () => {
  const http = await client("/unused.sqlite", new OAuth("https://console.test"));
  try {
    for (const path of ["/", "/tasks", "/executions/17", "/workers", "/capabilities", "/audit", "/console/tasks", "/console/executions/17", "/console/logs"]) {
      const response = await http.call(path, { host: "console.test" });
      assert.equal(response.status, 200, path);
      const asset = /src="\/console(\/assets\/[^"]+)"/.exec(response.text)?.[1];
      assert.ok(asset);
      assert.equal((await http.call(asset)).status, 200);
    }
    assert.equal((await http.call("/api/missing")).status, 404);
  } finally { await http.close(); }
});

test("OAuth binds the browser nonce, checks access, and rejects replay", async () => {
  const { oauth, revoke } = githubStub();
  const first = oauth.begin();
  const query = new URL(first.url).searchParams;
  const state = query.get("state");
  assert.equal(query.get("code_challenge_method"), "S256");
  await assert.rejects(oauth.finish(state, "code", undefined));
  const cookies = await oauth.finish(state, "code", first.cookies[0]);
  assert.equal(oauth.user(cookies[0])?.id, 1);
  assert.match(cookies[0], /Secure; HttpOnly; SameSite=Lax/);
  await assert.rejects(oauth.finish(state, "code", first.cookies[0]));
  const second = oauth.begin();
  revoke();
  await assert.rejects(oauth.finish(new URL(second.url).searchParams.get("state"), "code", second.cookies[0]),
    { message: "repository_access_required" });
});

test("Worker actions enforce same-origin and authenticated ownership", async () => {
  const data = await fixture();
  const { oauth } = githubStub();
  const login = oauth.begin();
  const state = new URL(login.url).searchParams.get("state");
  const [session] = await oauth.finish(state, "code", login.cookies[0]);
  const http = await client(data.path, oauth);
  const origin = "https://console.test";
  const headers = { host: "console.test", method: "POST", origin, cookie: session };
  try {
    const bad = await http.call("/api/workers", { ...headers, origin: "https://other.test", body: { name: "Pilot" } });
    assert.equal(bad.status, 403);
    const created = await http.call("/api/workers", { ...headers, body: { name: "Pilot", issue_number: 13 } });
    assert.equal(created.status, 201);
    const ownerWorker = JSON.parse(created.text);
    assert.equal(ownerWorker.state, "paused");
    const database = new DatabaseSync(data.path);
    const other = "f".repeat(32);
    database.prepare("INSERT INTO loom_workers VALUES(?,2,'Other',NULL,NULL,'[]','paused',NULL)").run(other);
    database.close();
    assert.deepEqual(JSON.parse((await http.call("/api/workers", { host: "console.test", cookie: session })).text)
      .map((row: { name: string }) => row.name), ["Pilot"]);
    assert.equal((await http.call("/api/workers/state", { ...headers, body: { id: other, state: "running" } })).status, 404);
    assert.equal((await http.call("/api/workers/state", { ...headers, body: { id: ownerWorker.id, state: "running" } })).status, 200);
    assert.equal((await http.call("/api/run", { ...headers, body: { issue: 13 } })).status, 202);
    assert.equal((await http.call("/api/run", { ...headers, body: { issue: 13 } })).status, 409);
    const actions = await http.call("/api/snapshot?view=logs&source=console", { host: "console.test", cookie: session });
    assert.deepEqual(JSON.parse(actions.text).entries.map((row: { outcome: string }) => row.outcome), ["rejected", "queued"]);
    const privateLogs = await http.call("/api/snapshot?view=logs&source=worker", { host: "console.test", cookie: session });
    assert.equal(JSON.parse(privateLogs.text).entries.length, 2);
    assert.equal(JSON.parse((await http.call("/api/snapshot?view=logs&source=worker")).text).entries.length, 0);
  } finally { await http.close(); await data.cleanup(); }
});

test("experiment reports are surfaced through the existing protected read endpoint", async () => {
  const data = await fixture();
  const db = new DatabaseSync(data.path);
  db.exec("CREATE TABLE planning_experiment_reports(id TEXT PRIMARY KEY,report TEXT,recorded_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  db.prepare("INSERT INTO planning_experiment_reports(id,report) VALUES(?,?)")
    .run("trial", JSON.stringify({ id: "trial", results: [] }));
  db.close();
  const previous = process.env.LOOM_EXPERIMENT_CONSOLE_DB;
  process.env.LOOM_EXPERIMENT_CONSOLE_DB = data.path;
  const http = await client(data.path, new OAuth("https://console.test"));
  try {
    const response = await http.call("/api/snapshot?view=experiments");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).reports[0].id, "trial");
    assert.equal((await http.call("/api/snapshot?view=experiments", { host: "console.test" })).status, 401);
    assert.equal((await http.call("/console/experiments")).status, 200);
  } finally {
    if (previous === undefined) delete process.env.LOOM_EXPERIMENT_CONSOLE_DB;
    else process.env.LOOM_EXPERIMENT_CONSOLE_DB = previous;
    await http.close();
    await data.cleanup();
  }
});

test("RSI recommendations require an approved reviewer and record only one decision", async () => {
  const data = await fixture();
  const id = "loom-rsi/" + "a".repeat(20) + "/review";
  const db = new DatabaseSync(data.path);
  db.exec(`CREATE TABLE planning_experiment_reports(id TEXT PRIMARY KEY,report TEXT,recorded_at TEXT);
    CREATE TABLE planning_rsi_recommendations(id TEXT PRIMARY KEY,recommendation TEXT,recorded_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare("INSERT INTO planning_rsi_recommendations(id,recommendation) VALUES(?,?)")
    .run(id, JSON.stringify({ id, state: "pending_review", candidate: { id: "rsi-1", prompt: "candidate" }, comparisons: [] }));
  db.close();
  const oldStore = process.env.LOOM_EXPERIMENT_CONSOLE_DB;
  const oldReviewers = process.env.LOOM_RSI_REVIEWER_IDS;
  process.env.LOOM_EXPERIMENT_CONSOLE_DB = data.path;
  process.env.LOOM_RSI_REVIEWER_IDS = "2";
  const { oauth } = githubStub();
  const login = oauth.begin();
  const [session] = await oauth.finish(new URL(login.url).searchParams.get("state"), "code", login.cookies[0]);
  const http = await client(data.path, oauth);
  const request = { host: "console.test", method: "POST", origin: "https://console.test", cookie: session,
    body: { id, decision: "approved" } };
  try {
    assert.equal((await http.call("/api/experiments/review", request)).status, 403);
    const hidden = await http.call("/api/snapshot?view=experiments", { host: "console.test", cookie: session });
    assert.equal(JSON.parse(hidden.text).recommendations[0].candidate, undefined);
    process.env.LOOM_RSI_REVIEWER_IDS = "1";
    assert.equal((await http.call("/api/experiments/review", request)).status, 201);
    assert.equal((await http.call("/api/experiments/review", request)).status, 409);
    const visible = await http.call("/api/snapshot?view=experiments", { host: "console.test", cookie: session });
    assert.equal(JSON.parse(visible.text).recommendations[0].review.decision, "approved");
  } finally {
    if (oldStore === undefined) delete process.env.LOOM_EXPERIMENT_CONSOLE_DB;
    else process.env.LOOM_EXPERIMENT_CONSOLE_DB = oldStore;
    if (oldReviewers === undefined) delete process.env.LOOM_RSI_REVIEWER_IDS;
    else process.env.LOOM_RSI_REVIEWER_IDS = oldReviewers;
    await http.close();
    await data.cleanup();
  }
});

test("shows default Worker config on the existing read path, including old database fallback", async () => {
  const data = await fixture();
  const http = await client(data.path, new OAuth("https://console.test"));
  const url = "/api/snapshot?view=default-worker";
  try {
    const prior = await http.call(url);
    assert.equal(prior.status, 200);
    assert.equal(JSON.parse(prior.text).model, null);
    assert.deepEqual(JSON.parse(prior.text).profiles, [{ issue: 13, files: null }]);
    assert.equal((await http.call(url, { host: "console.test" })).status, 401);
    const db = new DatabaseSync(data.path);
    db.exec(`CREATE TABLE loom_system_worker_config(id INTEGER PRIMARY KEY,model TEXT,pool_limit INTEGER,
      profiles TEXT,static_publication TEXT);
      INSERT INTO loom_system_worker_config VALUES (1,'deepseek/custom',3,'{"13":["README.md"]}','[13]');
      INSERT INTO worker_heartbeat VALUES (1,CURRENT_TIMESTAMP)`);
    db.close();
    const result = JSON.parse((await http.call(url)).text);
    assert.equal(result.status, "running");
    assert.equal(result.model, "deepseek/custom");
    assert.equal(result.poolLimit, 3);
    assert.deepEqual(result.profiles, [{ issue: 13, files: ["README.md"] }]);
    assert.deepEqual(result.staticPublication, [13]);
  } finally { await http.close(); await data.cleanup(); }
});
