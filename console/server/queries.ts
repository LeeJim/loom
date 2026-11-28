// Read models shared with the existing Loom SQLite schema.
export const manualEligible = `
  pr.issue_number IS NULL AND profile.issue_number IS NOT NULL
  AND COALESCE(manual.status,'') NOT IN ('queued','running','awaiting_plan')
  AND NOT EXISTS (SELECT 1 FROM workflow_executions running
                  WHERE running.issue_number=j.number AND running.status='running')
  AND (
    (p.issue_number IS NULL AND (j.stage!='AwaitingApproval' OR plan.error IS NOT NULL))
    OR (p.status='failed' AND j.stage='Delivery' AND j.last_error IS NULL
        AND plan.state='approved' AND plan.approval_comment_id IS NOT NULL)
  )
`;

export const snapshotQueries = {
  metrics: `SELECT (SELECT COUNT(*) FROM jobs) AS issues,
                (SELECT COUNT(*) FROM jobs WHERE stage='Delivery') AS delivered,
                (SELECT COUNT(*) FROM workflow_executions) AS executions,
                (SELECT COUNT(*) FROM workflow_executions WHERE status='running') AS running,
                (SELECT COUNT(*) FROM workflow_executions WHERE status='failed') AS failed,
                (SELECT COUNT(*) FROM workflow_stage_events WHERE stage='Repair') AS repairs,
                (SELECT COUNT(*) FROM ci_validation_attempts) AS ci_callbacks,
                (SELECT checked_at FROM worker_heartbeat WHERE id=1) AS heartbeat`,
  stages: `SELECT stage, COUNT(*) AS count FROM jobs GROUP BY stage`,
  jobs: `SELECT j.number, j.title, j.stage, j.repair_count, j.last_error,
                       pr.pr_number, p.status AS publication_status, p.error AS publication_error,
                       manual.status AS manual_status, plan.comment_url AS plan_comment_url,
                       plan.state AS plan_state, plan.error AS plan_error,
                       (${manualEligible}) AS manual_allowed,
                       (SELECT COUNT(*) FROM workflow_executions e WHERE e.issue_number=j.number) AS executions,
                       ci.run_id, COALESCE(a.conclusion,ci.conclusion) AS ci_conclusion, a.attempt
                FROM jobs j LEFT JOIN pr_deliveries pr ON pr.issue_number=j.number
                LEFT JOIN publications p ON p.issue_number=j.number
                LEFT JOIN worker_profiles profile ON profile.issue_number=j.number
                LEFT JOIN manual_runs manual ON manual.issue_number=j.number
                LEFT JOIN issue_plans plan ON plan.issue_number=j.number
                LEFT JOIN ci_validations ci ON ci.run_id=(
                    SELECT MAX(run_id) FROM ci_validations WHERE issue_number=j.number)
                LEFT JOIN ci_validation_attempts a ON a.run_id=ci.run_id AND a.attempt=(
                    SELECT MAX(attempt) FROM ci_validation_attempts WHERE run_id=ci.run_id)
                ORDER BY j.number DESC LIMIT 100`,
  executions: `SELECT e.id,e.issue_number,e.kind,e.status,e.started_at,e.finished_at,e.error,
                    (SELECT s.stage FROM workflow_stage_events s WHERE s.execution_id=e.id
                     ORDER BY s.id DESC LIMIT 1) AS stage
                FROM workflow_executions e ORDER BY e.id DESC LIMIT 30`,
  events: `SELECT s.execution_id, e.issue_number,s.stage,s.recorded_at
                FROM workflow_stage_events s JOIN workflow_executions e ON e.id=s.execution_id
                ORDER BY s.id DESC LIMIT 250`,
  repairs: `SELECT r.run_id, c.issue_number, r.attempt, r.status, r.error, r.patch_path
                FROM ci_repairs r JOIN ci_validations c ON c.run_id=r.run_id
                ORDER BY r.run_id DESC LIMIT 12`,
  ci: `SELECT a.run_id, a.attempt, c.issue_number, a.conclusion, a.recorded_at
                FROM ci_validation_attempts a JOIN ci_validations c ON c.run_id=a.run_id
                ORDER BY a.recorded_at DESC, a.attempt DESC LIMIT 12`,
};
