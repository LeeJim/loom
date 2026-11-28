import { ActivityFailure, ApplicationFailure, condition, defineQuery, defineSignal, patched, proxyActivities, setHandler } from "@temporalio/workflow";
import type { Activities, Artifact, CiResult, Directive, Draft, Issue, Plan } from "./contracts.js";

export const directive = defineSignal<[Directive]>("loom.directive");
export const publicationRequested = defineSignal("loom.publication.requested");
export const ciCompleted = defineSignal<[CiResult]>("loom.ci.completed");
export const status = defineQuery<IssueStatus>("loom.status");
export type IssueStatus = {
  stage: "planning" | "approval" | "coding" | "validation" | "repair" | "publication" | "ci" | "done";
  version: number;
  commentId?: number;
  draft?: Draft;
};

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "6 minutes",
  scheduleToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});

export async function issueWorkflow(issue: Issue): Promise<{ draft: Draft; ci: CiResult }> {
  const state: IssueStatus = { stage: "planning", version: 0 };
  const directives = new Map<number, Directive>();
  const seenDirectives = new Set<number>();
  const ciResults = new Map<string, CiResult>();
  let publishGeneration = 0;
  setHandler(status, () => state);
  setHandler(directive, event => {
    if (event.version < state.version || seenDirectives.has(event.id)) return;
    seenDirectives.add(event.id);
    directives.set(event.id, event);
  });
  setHandler(publicationRequested, () => { publishGeneration++; });
  setHandler(ciCompleted, event => {
    const key = `${event.runId}:${event.attempt}:${event.pr}:${event.headSha}`;
    if (!ciResults.has(key)) ciResults.set(key, event);
  });

  let plan: Plan | undefined;
  let feedback: Directive[] = [];
  let patch: Artifact;
  for (;;) {
    state.stage = "planning";
    state.version++;
    state.commentId = undefined;
    plan = await activities.draftPlan(issue, state.version, plan, feedback);
    feedback = [];
    const published = await activities.postPlan(issue, plan);
    state.commentId = published.commentId;
    state.stage = "approval";

    const current = () => [...directives.values()]
      .filter(item => item.version === state.version && item.id > published.commentId)
      .sort((a, b) => a.id - b.id);
    for (;;) {
      await condition(() => current().length > 0);
      const candidates = current();
      feedback = candidates.filter(item => item.kind === "feedback");
      if (feedback.length) break;
      const approval = candidates[0];
      directives.delete(approval.id);
      const check = await activities.recheckApproval(issue, plan, published, approval);
      if (check === "stale") break;
      if (check !== "valid" || current().some(item => item.kind === "feedback")) continue;
      state.stage = "coding";
      break;
    }
    for (const item of directives.values()) {
      if (item.version <= state.version) directives.delete(item.id);
    }
    if (state.stage === "coding") {
      try {
        patch = await activities.code(issue, plan);
        break;
      } catch (error) {
        if (!(error instanceof ActivityFailure && error.cause instanceof ApplicationFailure &&
              error.cause.type === "PlanBaseChanged")) throw error;
      }
    }
  }

  state.stage = "validation";
  let validation = await activities.validate(issue, patch);
  if (!validation.ok) {
    state.stage = "repair";
    patch = await activities.repair(issue, plan, patch, validation.evidence);
    state.stage = "validation";
    validation = await activities.validate(issue, patch);
    if (!validation.ok) throw ApplicationFailure.nonRetryable("Patch failed validation after repair");
  }

  state.stage = "publication";
  if (patched("publish-approved-plan-by-default")) {
    const draft = await activities.publish(issue, plan, patch);
    if (!draft) throw ApplicationFailure.nonRetryable("Issue is closed; draft publication skipped");
    state.draft = draft;
  } else {
    // Preserve the recorded command order for executions started by the older workflow.
    await condition(() => publishGeneration > 0);
    for (;;) {
      const seen = publishGeneration;
      const draft = await activities.publish(issue, plan, patch);
      if (draft) {
        state.draft = draft;
        break;
      }
      await condition(() => publishGeneration !== seen);
    }
  }
  const draft = state.draft;
  state.stage = "ci";
  const matchingCi = () => [...ciResults.values()].find(item => item.pr === draft.number && item.headSha === draft.headSha);
  await condition(() => matchingCi() !== undefined);
  const ci = matchingCi()!;
  await activities.recordCi(issue, draft, ci);
  state.stage = "done";
  return { draft, ci };
}
