import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { Artifact } from "./contracts.js";
import type { Experiment, Report, Result } from "./experiment.js";

export interface ExperimentActivities {
  loadExperiment(snapshot: Artifact): Promise<Pick<Experiment, "model"> & { cases: string[]; variants: string[] }>;
  evaluate(snapshot: Artifact, caseId: string, variantId: string): Promise<Result>;
  saveReport(report: Report): Promise<void>;
}
const io = proxyActivities<ExperimentActivities>({
  startToCloseTimeout: "5 minutes", scheduleToCloseTimeout: "12 minutes", retry: { maximumAttempts: 2 },
});

export async function comparePlanningAgents(snapshot: Artifact): Promise<Report> {
  const spec = await io.loadExperiment(snapshot);
  const results: Result[] = [];
  for (const caseId of spec.cases) {
    // Run the pair concurrently, keeping the overall model demand bounded.
    results.push(...await Promise.all(spec.variants.map(variant => io.evaluate(snapshot, caseId, variant))));
  }
  const report = { id: workflowInfo().workflowId, model: spec.model, snapshot: snapshot.sha256, results };
  await io.saveReport(report);
  return report;
}
