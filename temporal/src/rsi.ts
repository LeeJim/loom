import { validateExperiment, type Experiment, type PlanCase, type Report } from "./experiment.js";

export type RsiManifest = {
  sourceReportId: string;
  validation: Experiment;
  holdout: PlanCase[];
};
export type Candidate = { id: string; prompt: string };
export type RsiRecommendation = {
  id: string;
  sourceReport: string;
  state: "no_improvement" | "pending_review";
  reason: string;
  comparisons: string[];
  candidate?: Candidate;
  baselinePrompt?: string;
  scope?: string[];
};

const reportId = /^loom-exp\/[a-f0-9]{20}\/[A-Za-z0-9_-]{1,40}$/;

export const caseContent = (entry: PlanCase) => JSON.stringify({
  issue: entry.issue.trim(), base: entry.base.toLowerCase(),
  files: Object.entries(entry.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
});

export function validateRsi(spec: RsiManifest) {
  if (!spec || !reportId.test(spec.sourceReportId || "")) throw new Error("Invalid source report ID");
  validateExperiment(spec.validation);
  validateExperiment({ ...spec.validation, cases: spec.holdout });
  if (spec.validation.cases.length > 4 || spec.holdout.length > 4 ||
      spec.validation.variants.some(variant => /^rsi-[12]$/.test(variant.id))) {
    throw new Error("RSI supports at most four cases per split and reserves candidate IDs");
  }
  const seenIds = new Set(spec.validation.cases.map(entry => entry.id));
  const seenContent = new Set(spec.validation.cases.map(caseContent));
  const holdoutIds = new Set(spec.holdout.map(entry => entry.id));
  const scope = new Set(spec.validation.cases.map(entry => entry.scenario));
  if (holdoutIds.size !== spec.holdout.length ||
      spec.holdout.some(entry => seenIds.has(entry.id) || seenContent.has(caseContent(entry))) ||
      [...scope].some(scenario => !spec.holdout.some(entry => entry.scenario === scenario))) {
    throw new Error("Holdout cases must be distinct and cover every validation scenario");
  }
  return spec;
}

export function parseCandidates(raw: string, baseline: string): Candidate[] {
  const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*(.*?)\s*```$/s, "$1"));
  if (!Array.isArray(result) || result.length !== 2) throw new Error("Expected exactly two prompt candidates");
  const seen = new Set([baseline.trim()]);
  return result.map((row, index) => {
    if (!row || typeof row.prompt !== "string" || Object.keys(row).length !== 1 ||
        !row.prompt.trim() || row.prompt.length > 4000 || seen.has(row.prompt.trim())) {
      throw new Error("Invalid prompt-only candidate");
    }
    const prompt = row.prompt.trim();
    seen.add(prompt);
    return { id: `rsi-${index + 1}`, prompt };
  });
}

export function gains(report: Report, baseline: string, candidate: string): number | null {
  const baseRows = report.results.filter(row => row.variant === baseline);
  const alternatives = report.results.filter(row => row.variant === candidate);
  const hard = new Set(["invalid_json", "invalid_schema", "outside_file_scope", "unverified_evidence"]);
  if (!baseRows.length || alternatives.length !== baseRows.length ||
      report.results.length !== baseRows.length + alternatives.length) return null;
  let count = 0;
  for (const row of baseRows) {
    const matching = alternatives.filter(value => value.caseId === row.caseId);
    const trial = matching[0];
    if (matching.length !== 1 || row.error || trial.error ||
        (row.score.passed && !trial.score.passed) ||
        trial.score.failures.some(item => hard.has(item))) return null;
    if (!row.score.passed && trial.score.passed) count++;
  }
  return count;
}
