import { DatabaseSync } from 'node:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';

const repository = 'LeeJim/HowToCookOnMiniprogram';
const configuredIssues = process.env.ISSUE_NUMBERS ?? process.env.ISSUE_NUMBER ?? '';
const issueNumbers = new Set();
for (const raw of configuredIssues ? configuredIssues.split(',') : []) {
  const number = raw.trim();
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) {
    throw Error('Invalid Issue allowlist');
  }
  issueNumbers.add(Number(number));
}
const pollOrder = [...issueNumbers];
let pollCursor = 0;
const secretPath = process.env.GITHUB_WEBHOOK_SECRET_FILE;
const secret = secretPath && readFileSync(secretPath, 'utf8').trim();
if (secretPath && !secret) throw Error('Empty webhook secret');
const db = new DatabaseSync(process.env.DB_PATH ?? './workflow.sqlite');
db.exec(`
  PRAGMA busy_timeout=5000;
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS jobs (
    number INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'Planning', repair_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY, event TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pr_deliveries (
    issue_number INTEGER PRIMARY KEY REFERENCES jobs(number),
    pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL, head_sha TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ci_requests (
    workflow_head TEXT PRIMARY KEY, issue_number INTEGER NOT NULL REFERENCES pr_deliveries(issue_number),
    pr_head TEXT NOT NULL, workflow_path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ci_validations (
    run_id INTEGER PRIMARY KEY, issue_number INTEGER NOT NULL REFERENCES pr_deliveries(issue_number),
    pr_head TEXT NOT NULL, workflow_head TEXT NOT NULL, conclusion TEXT NOT NULL,
    run_url TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ci_validation_attempts (
    run_id INTEGER NOT NULL REFERENCES ci_validations(run_id), attempt INTEGER NOT NULL,
    conclusion TEXT NOT NULL, delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id),
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, attempt)
  );
  CREATE TABLE IF NOT EXISTS pending_pr_ci (
    delivery_id TEXT PRIMARY KEY REFERENCES webhook_deliveries(id),
    run_id INTEGER NOT NULL, attempt INTEGER NOT NULL, pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL, conclusion TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS publication_approvals (
    issue_number INTEGER PRIMARY KEY, approved INTEGER NOT NULL CHECK (approved IN (0, 1)),
    changed_at TEXT NOT NULL, delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id)
  );
`);

const enqueue = db.prepare('INSERT OR IGNORE INTO jobs (number, title, body) VALUES (?, ?, ?)');
const existingJob = db.prepare('SELECT 1 FROM jobs WHERE number=?');
const recordDelivery = db.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, event) VALUES (?, ?)');
const updateApproval = db.prepare(`
  INSERT INTO publication_approvals VALUES (?, ?, ?, ?)
  ON CONFLICT(issue_number) DO UPDATE SET approved=excluded.approved,
    changed_at=excluded.changed_at, delivery_id=excluded.delivery_id
  WHERE excluded.changed_at > publication_approvals.changed_at
    OR (excluded.changed_at = publication_approvals.changed_at AND excluded.approved=0)
`);
const recordValidation = db.prepare(`
  INSERT OR IGNORE INTO ci_validations (run_id, issue_number, pr_head, workflow_head, conclusion, run_url)
  SELECT ?, request.issue_number, request.pr_head, request.workflow_head, ?, ?
  FROM ci_requests AS request JOIN pr_deliveries AS pr ON pr.issue_number=request.issue_number
  WHERE request.workflow_head=? AND request.workflow_path=? AND request.pr_head=pr.head_sha
`);
const recordAttempt = db.prepare(`
  INSERT OR IGNORE INTO ci_validation_attempts (run_id, attempt, conclusion, delivery_id)
  SELECT validation.run_id, ?, ?, ?
  FROM ci_validations AS validation
  JOIN ci_requests AS request ON request.workflow_head=validation.workflow_head
  JOIN pr_deliveries AS pr ON pr.issue_number=request.issue_number
  WHERE validation.run_id=? AND request.workflow_head=? AND request.workflow_path=?
    AND validation.issue_number=request.issue_number AND request.pr_head=pr.head_sha
    AND validation.pr_head=pr.head_sha
`);
const outcomes = new Set(['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral',
  'action_required', 'stale', 'startup_failure']);
const prWorkflow = '.github/workflows/loom-pr-validation.yml';
const savePendingCi = db.prepare(`
  INSERT INTO pending_pr_ci (delivery_id, run_id, attempt, pr_number, head_sha, conclusion)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const readyCi = db.prepare(`
  SELECT pending.*, pr.issue_number FROM pending_pr_ci AS pending
  JOIN pr_deliveries AS pr ON pr.pr_number=pending.pr_number AND pr.head_sha=pending.head_sha
  ORDER BY pending.received_at LIMIT 100
`);
const registerPrCi = db.prepare(`
  INSERT OR IGNORE INTO ci_requests (workflow_head, issue_number, pr_head, workflow_path)
  VALUES (?, ?, ?, ?)
`);
const removePendingCi = db.prepare('DELETE FROM pending_pr_ci WHERE delivery_id=?');
const expirePendingCi = db.prepare("DELETE FROM pending_pr_ci WHERE received_at < datetime('now', '-7 days')");
let nextPollDelay = 120000;

function reconcilePrCi() {
  for (const row of readyCi.all()) {
    registerPrCi.run(row.head_sha, row.issue_number, row.head_sha, prWorkflow);
    recordValidation.run(row.run_id, row.conclusion, `https://github.com/${repository}/actions/runs/${row.run_id}`,
      row.head_sha, prWorkflow);
    recordAttempt.run(row.attempt, row.conclusion, row.delivery_id, row.run_id, row.head_sha, prWorkflow);
    removePendingCi.run(row.delivery_id);
  }
  expirePendingCi.run();
}

async function poll() {
  // Each tick makes at most one request, and the webhook remains the fast path.
  let issueNumber;
  for (let checked = 0; checked < pollOrder.length; checked++) {
    const candidate = pollOrder[pollCursor];
    pollCursor = (pollCursor + 1) % pollOrder.length;
    if (!existingJob.get(candidate)) {
      issueNumber = candidate;
      break;
    }
  }
  if (issueNumber === undefined) return;
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, {
    headers, signal: AbortSignal.timeout(10000)
  });
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    nextPollDelay = Math.max(nextPollDelay, retryAfter, resetAt - Date.now() + 1000);
  }
  if (!response.ok) throw Error(`GitHub Issues API returned ${response.status}`);
  const issue = await response.json();
  if (issue.state !== 'open' || issue.pull_request || issue.number !== issueNumber) return;
  enqueue.run(issue.number, issue.title, issue.body ?? '');
}

const app = new Hono();
app.get('/healthz', (c) => c.json({ status: 'ok', polling: pollOrder.length > 0 }));
app.get('/jobs', (c) => c.json(db.prepare('SELECT number, stage, repair_count, last_error FROM jobs').all()));
app.get('/ci-validations', (c) => c.json(db.prepare(`
  SELECT validation.run_id, issue_number, pr_head,
    COALESCE(attempt.conclusion, validation.conclusion) AS conclusion, run_url,
    attempt.attempt, attempt.recorded_at AS webhook_recorded_at
  FROM ci_validations AS validation
  LEFT JOIN ci_validation_attempts AS attempt ON attempt.run_id=validation.run_id
    AND attempt.attempt=(SELECT MAX(a.attempt) FROM ci_validation_attempts AS a
                         WHERE a.run_id=validation.run_id)
  ORDER BY validation.run_id DESC LIMIT 50
`).all()));
app.post('/webhooks/github', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
  if (!secret) return c.text('Webhook unavailable', 503);
  const signature = c.req.header('x-hub-signature-256') ?? '';
  const delivery = c.req.header('x-github-delivery') ?? '';
  const event = c.req.header('x-github-event');
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return c.text('Invalid signature', 401);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(delivery) || !event) return c.text('Invalid event headers', 400);
  const raw = Buffer.from(await c.req.arrayBuffer());
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), expected)) {
    return c.text('Invalid signature', 401);
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return c.text('Invalid JSON', 400);
  }
  const repoName = payload?.repository?.full_name;
  if (typeof repoName !== 'string' || repoName.toLowerCase() !== repository.toLowerCase()) {
    return c.text('Repository rejected', 403);
  }
  const issue = payload.issue;
  const knownIssue = event === 'issues' && issueNumbers.has(issue?.number) && !issue.pull_request;
  const eligible = knownIssue && ['opened', 'reopened', 'labeled'].includes(payload.action)
    && issue.state === 'open' && typeof issue.title === 'string'
    && (issue.body == null || typeof issue.body === 'string');
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = recordDelivery.run(delivery, event).changes === 0;
    const queued = Boolean(!duplicate && eligible
      && enqueue.run(issue.number, issue.title, issue.body ?? '').changes);
    const label = payload.label?.name === 'loom:publish';
    if (!duplicate && knownIssue && typeof issue.updated_at === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(issue.updated_at)) {
      if ((label && payload.action === 'unlabeled') || payload.action === 'closed') {
        updateApproval.run(issue.number, 0, issue.updated_at, delivery);
      } else if (label && payload.action === 'labeled' && issue.state === 'open'
        && payload.sender?.id === 7017290 && payload.sender?.type === 'User') {
        updateApproval.run(issue.number, 1, issue.updated_at, delivery);
      }
    }
    const run = payload.workflow_run;
    if (!duplicate && event === 'workflow_run' && payload.action === 'completed'
      && run?.status === 'completed' && Number.isSafeInteger(run.id) && run.id > 0
      && outcomes.has(run.conclusion) && typeof run.head_sha === 'string' && typeof run.path === 'string') {
      recordValidation.run(run.id, run.conclusion, `https://github.com/${repository}/actions/runs/${run.id}`,
        run.head_sha, run.path);
      if (Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0) {
        recordAttempt.run(run.run_attempt, run.conclusion, delivery, run.id, run.head_sha, run.path);
        const pulls = run.pull_requests;
        if (run.path === prWorkflow && run.event === 'pull_request'
          && /^[a-f0-9]{40}$/.test(run.head_sha) && Array.isArray(pulls) && pulls.length === 1
          && Number.isSafeInteger(pulls[0]?.number) && pulls[0].number > 0
          && pulls[0].head?.sha === run.head_sha && pulls[0].base?.ref === 'main') {
          savePendingCi.run(delivery, run.id, run.run_attempt, pulls[0].number, run.head_sha, run.conclusion);
          reconcilePrCi();
        }
      }
    }
    db.exec('COMMIT');
    return c.json({ duplicate, queued }, 202);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});
serve({ fetch: app.fetch, hostname: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8787) });

async function tick() {
  nextPollDelay = 120000;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      reconcilePrCi();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    await poll();
  } catch (error) {
    console.error(error.message);
  } finally {
    setTimeout(tick, nextPollDelay);
  }
}

void tick();
