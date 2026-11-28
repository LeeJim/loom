import type { Issue } from "./contracts.js";
import type { GitHub, GitHubComment } from "./github.js";
import { issueDirective } from "./ingress.js";
import type { VerifiedEvent } from "./outbox.js";

type Payload = {
  repository?: { full_name?: string };
  action?: string;
  sender?: GitHubComment["user"];
  issue?: { number: number; state: string; pull_request?: unknown };
  comment?: GitHubComment;
  label?: { name: string };
  workflow_run?: {
    id: number; run_attempt: number; conclusion: string; status: string; event: string;
    head_sha: string; head_branch: string; path: string;
    pull_requests?: Array<{ number: number; head?: { sha: string }; base?: { ref: string } }>;
  };
};

export async function pilotEvent(
  github: GitHub, profiles: ReadonlyMap<number, readonly string[]>,
  event: string, delivery: string, body: Payload,
): Promise<VerifiedEvent | undefined> {
  if (body.repository?.full_name?.toLowerCase() !== github.repository.toLowerCase()) return;
  const issue = body.issue;
  const identity = (number: number): Issue => ({ repository: github.repository, number });
  if (issue && issue.state === "open" && !issue.pull_request && profiles.has(issue.number)) {
    if (event === "issues" && ["opened", "reopened"].includes(body.action ?? "")) {
      return { kind: "start", issue: identity(issue.number), delivery };
    }
    if (event === "issues" && body.action === "labeled" && body.label?.name === "loom:publish" &&
        body.sender && await github.authorized(body.sender)) {
      return { kind: "publication", issue: identity(issue.number), delivery };
    }
    if (event === "issue_comment" && body.action === "created" && body.comment) {
      return issueDirective(github, identity(issue.number), body.comment, delivery);
    }
  }
  const run = body.workflow_run;
  if (event !== "workflow_run" || body.action !== "completed" || run?.status !== "completed" ||
      run.event !== "pull_request" || run.path !== ".github/workflows/loom-pr-validation.yml" ||
      !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isSafeInteger(run.id) || run.id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0 ||
      !["success", "failure", "cancelled", "timed_out", "skipped", "neutral",
        "action_required", "stale", "startup_failure"].includes(run.conclusion) ||
      run.pull_requests?.length !== 1) return;
  const pr = run.pull_requests[0];
  const number = Number(/^codex\/loom-issue-([1-9]\d*)-[a-f0-9]{16}$/.exec(run.head_branch)?.[1]);
  if (!profiles.has(number) || !Number.isSafeInteger(pr.number) || pr.number <= 0 ||
      pr.base?.ref !== "main" || pr.head?.sha !== run.head_sha) return;
  return {
    kind: "ci", issue: identity(number), delivery,
    result: { runId: run.id, attempt: run.run_attempt, pr: pr.number, headSha: run.head_sha, conclusion: run.conclusion },
  };
}
