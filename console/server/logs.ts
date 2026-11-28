import type { DatabaseSync } from "node:sqlite";
import { InvalidRequest, positiveInt, withDb } from "./data.js";

const sources = ["execution", "stage", "webhook", "worker", "console", "temporal"] as const;
type Source = typeof sources[number];
type Entry = {
  id: string; source: Source; event: string; recorded_at: string; outcome: string | null;
  issue_number: number | null; execution_id: number | null; reference: string | null;
};

export function logFilters(params: URLSearchParams) {
  const issue = params.get("issue");
  const selected = params.get("source");
  if ((issue !== null && (!/^\d+$/.test(issue) || !positiveInt(Number(issue)))) ||
      (selected !== null && !sources.includes(selected as Source))) throw new InvalidRequest();
  return { issue: issue === null ? null : Number(issue), source: selected as Source | null };
}

export function recentLogs(db: DatabaseSync, filters: ReturnType<typeof logFilters>, owner?: number, temporalDb?: string) {
  const results: Entry[] = [];
  const { issue, source } = filters;
  const scoped = (name: Source) => !source || source === name;
  function add(sql: string, ...args: (number | string | null)[]) {
    const rows = db.prepare(sql).all(...args) as unknown as Entry[];
    results.push(...rows);
  }
  if (scoped("execution")) add(`
    SELECT 'execution:'||id AS id,'execution' AS source,kind AS event,
      COALESCE(finished_at,started_at) AS recorded_at,status AS outcome,issue_number,
      id AS execution_id,NULL AS reference
    FROM workflow_executions WHERE (? IS NULL OR issue_number=?)
    ORDER BY recorded_at DESC,id DESC LIMIT 100
  `, issue, issue);
  if (scoped("stage")) add(`
    SELECT 'stage:'||s.id AS id,'stage' AS source,s.stage AS event,s.recorded_at,NULL AS outcome,
      e.issue_number,s.execution_id,NULL AS reference
    FROM workflow_stage_events s JOIN workflow_executions e ON e.id=s.execution_id
    WHERE (? IS NULL OR e.issue_number=?) ORDER BY s.recorded_at DESC,s.id DESC LIMIT 100
  `, issue, issue);
  if (scoped("webhook") && issue === null) add(`
    SELECT 'webhook:'||id AS id,'webhook' AS source,event,received_at AS recorded_at,'received' AS outcome,
      NULL AS issue_number,NULL AS execution_id,id AS reference
    FROM webhook_deliveries ORDER BY received_at DESC,id DESC LIMIT 100
  `);
  if (scoped("worker") && owner !== undefined) add(`
    SELECT 'worker:'||a.id AS id,'worker' AS source,a.action AS event,a.recorded_at,NULL AS outcome,
      w.issue_number,NULL AS execution_id,a.worker_id AS reference
    FROM loom_worker_actions a JOIN loom_workers w ON w.id=a.worker_id
    WHERE w.owner_id=? AND a.actor_id=? AND (? IS NULL OR w.issue_number=?)
    ORDER BY a.recorded_at DESC,a.id DESC LIMIT 100
  `, owner, owner, issue, issue);

  if (scoped("console") && owner !== undefined && db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='loom_console_actions'",
  ).get()) add(`
    SELECT 'console:'||id AS id,'console' AS source,action AS event,recorded_at,outcome,
      issue_number,NULL AS execution_id,NULL AS reference
    FROM loom_console_actions WHERE actor_id=? AND (? IS NULL OR issue_number=?)
    ORDER BY recorded_at DESC,id DESC LIMIT 100
  `, owner, issue, issue);

  let temporalUnavailable = false;
  if (scoped("temporal") && temporalDb) {
    try {
      const rows = withDb(temporalDb, true, store => store.prepare(`
        SELECT 'temporal:'||id AS id,'temporal' AS source,activity AS event,
          COALESCE(finished_at,started_at) AS recorded_at,status AS outcome,
          issue_number,NULL AS execution_id,workflow_id AS reference
        FROM temporal_activity_records WHERE (? IS NULL OR issue_number=?)
        ORDER BY recorded_at DESC,id DESC LIMIT 100
      `).all(issue, issue) as unknown as Entry[]);
      results.push(...rows);
    } catch {
      temporalUnavailable = true;
    }
  }
  results.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  return { entries: results.slice(0, 100), temporalUnavailable };
}
