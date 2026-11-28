import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { snapshotQueries } from "./queries.js";
import { availableModel, installedSkill } from "./capabilities.js";

export const defaultDb = "/opt/loom/data/workflow.sqlite";

export function withDb<T>(path: string, readOnly: boolean, access: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return access(db);
  } finally {
    db.close();
  }
}

function write<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function snapshot(db: DatabaseSync) {
  db.exec("BEGIN");
  const { metrics, ...queries } = snapshotQueries;
  return { generated: new Date().toISOString(), metrics: db.prepare(metrics).get(),
    ...Object.fromEntries(Object.entries(queries).map(([key, sql]) => [key, db.prepare(sql).all()])) };
}

export function timeline(db: DatabaseSync, id: number) {
  const execution = db.prepare("SELECT * FROM workflow_executions WHERE id=?").get(id);
  if (!execution) return;
  return {
    ...execution,
    stages: db.prepare("SELECT * FROM workflow_stage_events WHERE execution_id=? ORDER BY id").all(id),
    artifacts: db.prepare("SELECT * FROM workflow_artifacts WHERE execution_id=? ORDER BY id").all(id)
      .map(row => ({ ...row, payload: JSON.parse(String(row.payload)) })),
  };
}

export function temporalActivities(path?: string) {
  if (!path) return { enabled: false, activities: [] };
  return withDb(path, true, db => ({ enabled: true, activities: db.prepare(`
    SELECT id,workflow_id,issue_number,activity,attempt,status,inputs,output,started_at,finished_at
    FROM temporal_activity_records ORDER BY id DESC LIMIT 60
  `).all().map(row => ({ ...row, inputs: JSON.parse(String(row.inputs)),
    output: row.output === null ? null : JSON.parse(String(row.output)) })) }));
}

export function audit(db: DatabaseSync) {
  const repairs = db.prepare(`
    SELECT execution_id,count(*) AS retries FROM workflow_stage_events WHERE stage='Repair'
    GROUP BY execution_id ORDER BY execution_id DESC LIMIT 30
  `).all().map(row => ({ execution_id: row.execution_id, stage: "Repair", evidence: { retries: row.retries },
    suggestion: "核对验证失败的输入和输出，检查验收条件是否需要提前明确。" }));
  const failures = db.prepare(`
    SELECT a.id AS artifact_id,a.execution_id,a.stage
    FROM workflow_artifacts a JOIN workflow_executions e ON e.id=a.execution_id
    WHERE a.direction='output' AND (json_extract(a.payload,'$.result') IN ('failed','error') OR e.status='failed')
    ORDER BY a.id DESC LIMIT 30
  `).all().map(row => ({ execution_id: row.execution_id, stage: row.stage, evidence: { artifact_id: row.artifact_id },
    suggestion: "检查失败阶段的输入、错误输出及环境依赖。" }));
  const slow = db.prepare(`
    WITH spans AS (SELECT execution_id,id,stage,recorded_at,
      lead(recorded_at) OVER (PARTITION BY execution_id ORDER BY id) AS next_at FROM workflow_stage_events)
    SELECT id,execution_id,stage,ROUND((julianday(next_at)-julianday(recorded_at))*86400) AS elapsed_seconds
    FROM spans WHERE stage IN ('Coding','Validation','Repair','Review') AND elapsed_seconds>=60
    ORDER BY elapsed_seconds DESC LIMIT 20
  `).all().map(row => ({ execution_id: row.execution_id, stage: row.stage,
    evidence: { stage_event_id: row.id, elapsed_seconds: row.elapsed_seconds },
    suggestion: "对照输入与输出，定位该阶段的耗时来源。" }));
  return [...failures, ...repairs, ...slow];
}

const workerSelect = `SELECT w.id,w.owner_id,w.name,w.issue_number,w.model,w.skills,w.state,
  c.issue_number AS active_issue,w.last_seen_at
  FROM loom_workers w LEFT JOIN loom_issue_claims c ON c.worker_id=w.id`;
const workerRow = (row: Record<string, unknown>) => ({ ...row, skills: JSON.parse(String(row.skills)) });

export function systemWorker(db: DatabaseSync) {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
  const runtime = table.get("loom_system_worker_config") && db.prepare(
    "SELECT model,pool_limit,profiles,static_publication FROM loom_system_worker_config WHERE id=1",
  ).get();
  const heartbeat = table.get("worker_heartbeat")
    ? db.prepare("SELECT checked_at FROM worker_heartbeat WHERE id=1").get()?.checked_at : null;
  const issue = table.get("loom_issue_claims")
    ? db.prepare("SELECT issue_number FROM loom_issue_claims WHERE worker_id='system'").get()?.issue_number : null;
  const personal = table.get("loom_workers") && db.prepare("SELECT 1 FROM loom_workers LIMIT 1").get();
  const profiles = runtime ? Object.entries(JSON.parse(String(runtime.profiles)))
    .map(([number, files]) => ({ issue: Number(number), files })).sort((a, b) => a.issue - b.issue)
    : table.get("worker_profiles") ? db.prepare("SELECT issue_number FROM worker_profiles ORDER BY issue_number")
      .all().map(row => ({ issue: row.issue_number, files: null })) : [];
  const fresh = typeof heartbeat === "string" &&
    Date.now() - Date.parse(heartbeat.replace(" ", "T") + "Z") < 30_000;

  return {
    model: runtime?.model ?? null,
    poolLimit: runtime?.pool_limit ?? null,
    profiles,
    staticPublication: runtime ? JSON.parse(String(runtime.static_publication)) : null,
    activeIssue: fresh ? issue ?? null : null,
    heartbeat: heartbeat ?? null,
    status: personal ? "delegated" : !profiles.length ? "unconfigured" : fresh ? "running" : "unavailable",
  };
}


export function workers(db: DatabaseSync, owner: number) {
  return db.prepare(workerSelect + " WHERE w.owner_id=? ORDER BY w.name").all(owner).map(workerRow);
}

export class InvalidRequest extends Error {}
export const positiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export async function validateWorker(body: Record<string, unknown>) {
  const { name, issue_number: issue = null, model = null, skills = [] } = body;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 64 ||
      (issue !== null && !positiveInt(issue)) ||
      (model !== null && (typeof model !== "string" || !/^[\w.:/-]{1,128}$/.test(model))) ||
      !Array.isArray(skills) || skills.length > 16) throw new InvalidRequest();
  const seen = new Set<string>();
  const selected: { id: string; version: string }[] = [];
  for (const skill of skills) {
    if (!skill || !(await installedSkill(skill.id, skill.version)) || seen.has(skill.id)) throw new InvalidRequest();
    seen.add(skill.id);
    selected.push({ id: skill.id, version: skill.version });
  }
  if (model !== null) await availableModel(model);
  return { name: name.trim(), issue, model, selected };
}

export function createWorker(db: DatabaseSync, owner: number, config: Awaited<ReturnType<typeof validateWorker>>) {
  const id = randomUUID().replaceAll("-", "");
  return write(db, () => {
    const { name, issue, model, selected } = config;
    if (Number(db.prepare("SELECT count(*) AS n FROM loom_workers WHERE owner_id=?").get(owner)?.n) >= 16 ||
        db.prepare("SELECT 1 FROM loom_workers WHERE owner_id=? AND name=?").get(owner, name) ||
        (issue !== null && !db.prepare("SELECT 1 FROM worker_profiles WHERE issue_number=?").get(issue))) {
      throw new InvalidRequest();
    }
    db.prepare("INSERT INTO loom_workers VALUES(?,?,?,?,?,?,'paused',NULL)")
      .run(id, owner, name, issue, model, JSON.stringify(selected));
    db.prepare("INSERT INTO loom_worker_actions(worker_id,actor_id,action) VALUES(?,?,'created')").run(id, owner);
    return workerRow(db.prepare(workerSelect + " WHERE w.id=?").get(id)!);
  });
}

export function setWorkerState(db: DatabaseSync, owner: number, id: unknown, state: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) ||
      typeof state !== "string" || !["running", "paused", "draining"].includes(state)) throw new InvalidRequest();
  return write(db, () => {
    if (!db.prepare("UPDATE loom_workers SET state=? WHERE id=? AND owner_id=?").run(state, id, owner).changes) return;
    db.prepare("INSERT INTO loom_worker_actions(worker_id,actor_id,action) VALUES(?,?,?)").run(id, owner, state);
    if (state === "draining") db.prepare(`UPDATE loom_workers SET state='paused' WHERE id=? AND NOT EXISTS
      (SELECT 1 FROM loom_issue_claims WHERE worker_id=?)`).run(id, id);
    return workerRow(db.prepare(workerSelect + " WHERE w.id=?").get(id)!);
  });
}

export function queueRun(db: DatabaseSync, issue: number, actor: number) {
  return write(db, () => {
    const queued = db.prepare(`
    INSERT INTO manual_runs(issue_number,status)
    SELECT j.number,'queued' FROM jobs j JOIN worker_profiles p ON p.issue_number=j.number
    WHERE j.number=? AND NOT EXISTS (SELECT 1 FROM pr_deliveries WHERE issue_number=j.number)
      AND NOT EXISTS (SELECT 1 FROM publications WHERE issue_number=j.number)
      AND NOT EXISTS (SELECT 1 FROM publication_approvals WHERE issue_number=j.number AND approved=1)
      AND (j.stage!='AwaitingApproval' OR EXISTS
        (SELECT 1 FROM issue_plans WHERE issue_number=j.number AND error IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM workflow_executions WHERE issue_number=j.number AND status='running')
      AND NOT EXISTS (SELECT 1 FROM loom_issue_claims WHERE issue_number=j.number)
    ON CONFLICT(issue_number) DO UPDATE SET status='queued',requested_at=CURRENT_TIMESTAMP
      WHERE manual_runs.status NOT IN ('queued','running','awaiting_plan')
    `).run(issue).changes > 0;
    db.exec(`CREATE TABLE IF NOT EXISTS loom_console_actions (
      id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL, issue_number INTEGER NOT NULL,
      action TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.prepare(`INSERT INTO loom_console_actions(actor_id,issue_number,action,outcome)
      VALUES (?,?,'run_request',?)`).run(actor, issue, queued ? "queued" : "rejected");
    return queued;
  });
}
