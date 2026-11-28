export type Job = {
  number: number; title: string; stage: string; last_error: string | null;
  repair_count: number; executions: number; pr_number: number | null; run_id: number | null;
  plan_comment_url: string | null; ci_conclusion: string | null; manual_allowed: number;
  manual_status: string | null; publication_status: string | null; publish_approved: number;
  plan_state: string | null; plan_error: string | null; publication_error: string | null;
};
export type Execution = {
  id: number; issue_number: number; kind: string; status: string; stage: string | null;
  started_at: string; finished_at: string | null; error: string | null;
};
export type Snapshot = {
  generated: string;
  metrics: { issues: number; delivered: number; executions: number; running: number; failed: number;
    repairs: number; ci_callbacks: number; heartbeat: string | null };
  stages: { stage: string; count: number }[];
  jobs: Job[];
  executions: Execution[];
  ci: { run_id: number; attempt: number; issue_number: number; conclusion: string; recorded_at: string }[];
  repairs: { run_id: number; issue_number: number; attempt: number; status: string; error: string | null; patch_path: string | null }[];
};
export type Skill = { id: string; version: string; description: string; installed: boolean };
export type Worker = {
  id: string; name: string; issue_number: number | null; model: string | null;
  skills: Pick<Skill, "id" | "version">[]; state: "running" | "paused" | "draining";
  active_issue: number | null; last_seen_at: string | null;
};
type Catalog<T> = { status: "unconfigured" | "unavailable" | "available"; items: T[] };
export type Capabilities = {
  llm: Catalog<{ id: string }> & { configured_default: string };
  mcp: Catalog<{ name: string; description: string }>;
  skills: Catalog<Skill>;
};
export type Session = { enabled: boolean; user: { id: number; login: string } | null };
export type Timeline = Execution & {
  stages: { id: number; stage: string; recorded_at: string }[];
  artifacts: { id: number; stage: string; direction: string; payload: unknown; recorded_at: string }[];
};
export type Finding = { execution_id: number; stage: string; evidence: unknown; suggestion: string };
export type Temporal = { enabled: boolean; activities: { id: number; issue_number: number; activity: string;
  attempt: number; status: string; inputs: unknown; output: unknown; started_at: string }[] };

export const repository = "https://github.com/LeeJim/HowToCookOnMiniprogram";
export const base = import.meta.env.BASE_URL;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(code || String(status)); }
}

export async function api<T>(path: string, options: { signal?: AbortSignal; body?: unknown } = {}): Promise<T> {
  const response = await fetch(base + "api/" + path, {
    cache: "no-store",
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    ...(options.body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => undefined);
    throw new ApiError(response.status, error?.status);
  }
  return response.json();
}
