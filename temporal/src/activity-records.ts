import { Context } from "@temporalio/activity";
import { DatabaseSync } from "node:sqlite";
import type { Activities, Issue } from "./contracts.js";

export function recordActivities(db: DatabaseSync, activities: Activities): Activities {
  db.exec(`
    CREATE TABLE IF NOT EXISTS temporal_activity_records (
      id INTEGER PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      activity_id TEXT NOT NULL,
      activity TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      inputs TEXT NOT NULL,
      output TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      UNIQUE(run_id, activity_id, attempt)
    );
  `);
  const start = db.prepare(`
    INSERT OR IGNORE INTO temporal_activity_records
      (workflow_id,run_id,issue_number,activity_id,activity,attempt,status,inputs)
    VALUES (?,?,?,?,?,?,'running',?)
  `);
  const finish = db.prepare(`
    UPDATE temporal_activity_records SET status=?,output=?,finished_at=CURRENT_TIMESTAMP
    WHERE run_id=? AND activity_id=? AND attempt=?
  `);

  function wrap<A extends [Issue, ...unknown[]], R>(name: string, next: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      const { workflowExecution, activityId, attempt } = Context.current().info;
      const { workflowId, runId } = workflowExecution!;
      start.run(workflowId, runId, args[0].number, activityId, name, attempt, JSON.stringify(args));
      try {
        const outcome = await next(...args);
        finish.run("completed", JSON.stringify(outcome ?? null), runId, activityId, attempt);
        return outcome;
      } catch (error) {
        // Internal command failures can contain credentials or repository content.
        finish.run("failed", JSON.stringify({ error: (error as Error).name }), runId, activityId, attempt);
        throw error;
      }
    };
  }

  return {
    draftPlan: wrap("Planning", activities.draftPlan),
    postPlan: wrap("Plan comment", activities.postPlan),
    recheckApproval: wrap("Approval", activities.recheckApproval),
    code: wrap("Coding", activities.code),
    validate: wrap("Validation", activities.validate),
    repair: wrap("Repair", activities.repair),
    publish: wrap("Publication", activities.publish),
    recordCi: wrap("CI", activities.recordCi),
  };
}
