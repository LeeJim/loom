import { executeChild, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { Artifact } from "./contracts.js";
import { comparePlanningAgents } from "./experiment-workflow.js";
import type { Candidate, RsiRecommendation } from "./rsi.js";
import { gains } from "./rsi.js";

export { comparePlanningAgents };

export interface RsiActivities {
  proposePrompts(snapshot: Artifact): Promise<{
    sourceReport: string; baselineId: string; baselinePrompt: string; candidates: Candidate[]; scope: string[];
  }>;
  pairedSnapshot(snapshot: Artifact, candidate: Candidate, holdout: boolean): Promise<Artifact>;
  saveRecommendation(recommendation: RsiRecommendation): Promise<void>;
}
const io = proxyActivities<RsiActivities>({
  startToCloseTimeout: "5 minutes", scheduleToCloseTimeout: "10 minutes", retry: { maximumAttempts: 1 },
});

export async function improvePlanningAgent(snapshot: Artifact): Promise<RsiRecommendation> {
  const id = workflowInfo().workflowId;
  const proposal = await io.proposePrompts(snapshot);
  const comparisons: string[] = [];
  const run = async (candidate: Candidate, holdout: boolean) => {
    const paired = await io.pairedSnapshot(snapshot, candidate, holdout);
    const workflowId = `${id}/${candidate.id}/${holdout ? "holdout" : "validation"}`;
    const report = await executeChild(comparePlanningAgents, { workflowId, args: [paired] });
    comparisons.push(workflowId);
    if (holdout && !report.results.filter(row => row.variant === candidate.id).every(row => row.score.passed)) {
      return null;
    }
    return gains(report, proposal.baselineId, candidate.id);
  };
  let winner: Candidate | undefined;
  let best = 0;
  for (const candidate of proposal.candidates) {
    const improvement = await run(candidate, false);
    if (improvement !== null && improvement > best) {
      best = improvement;
      winner = candidate;
    }
  }
  let recommendation: RsiRecommendation = {
    id, sourceReport: proposal.sourceReport, state: "no_improvement", reason: "validation_no_gain",
    comparisons,
  };
  if (winner) {
    const holdout = await run(winner, true);
    recommendation = holdout === null
      ? { ...recommendation, reason: "holdout_regression_or_failure" }
      : { ...recommendation, state: "pending_review", reason: "validation_gain_and_holdout_pass",
        candidate: winner, baselinePrompt: proposal.baselinePrompt, scope: proposal.scope };
  }
  await io.saveRecommendation(recommendation);
  return recommendation;
}
