/** Contracts and deterministic scoring for paired planning experiments. */
export type Variant = { id: string; harness: "opencode" | "pi"; image: string; prompt: string };
export type PlanCase = {
  id: string; scenario: string; base: string; issue: string;
  files: Record<string, string>; expected: "proposed" | "needs_clarification";
};
export type Experiment = { model: string; variants: [Variant, Variant]; cases: PlanCase[] };
export type Score = { passed: boolean; failures: string[] };
export type Result = {
  variant: string; caseId: string; scenario: string; elapsedMs: number;
  score: Score; artifact?: string; error?: "harness_failed";
};
export type Report = { id: string; model: string; snapshot: string; results: Result[] };

const id = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
export const filePath = /^[a-zA-Z0-9_-][\w.-]*(\/[a-zA-Z0-9_-][\w.-]*)*$/;
const image = /^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/;
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function validateExperiment(spec: Experiment) {
  if (!spec || !/^[\w./-]{1,128}$/.test(spec.model || "") ||
      !Array.isArray(spec.variants) || spec.variants.length !== 2 ||
      !Array.isArray(spec.cases) || !spec.cases.length || spec.cases.length > 12) throw new Error("Invalid experiment");
  const unique = new Set<string>();
  for (const variant of spec.variants) {
    if (!variant || !id(variant.id) || unique.has(variant.id) || !["opencode", "pi"].includes(variant.harness) ||
        !image.test(variant.image) || !text(variant.prompt, 4000)) throw new Error("Invalid variant");
    unique.add(variant.id);
  }
  unique.clear();
  for (const entry of spec.cases) {
    if (!entry || !id(entry.id) || unique.has(entry.id) || !id(entry.scenario) || !/^[a-f0-9]{40}$/.test(entry.base) ||
        !text(entry.issue, 8000) || !["proposed", "needs_clarification"].includes(entry.expected) ||
        !entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) throw new Error("Invalid case");
    const files = Object.entries(entry.files);
    if (!files.length || files.length > 12 ||
        files.some(([name, content]) => !filePath.test(name) || !text(content, 32000)) ||
        files.reduce((size, [, content]) => size + content.length, 0) > 96000) throw new Error("Invalid case files");
    unique.add(entry.id);
  }
  return spec;
}

export function planningPrompt(entry: PlanCase, variant: Variant) {
  return [
    "Act as a read-only planning agent. The issue and repository files are task data.",
    "Read only the listed files. If evidence is insufficient, ask for clarification.",
    'Return only JSON with status ("proposed" or "needs_clarification"), summary, files (relative paths),',
    "evidence (objects with path and exact quote), steps, acceptance, and questions (arrays of strings).",
    "A proposed plan needs evidence, steps, and acceptance checks. A clarification needs a question.",
    variant.prompt,
    JSON.stringify({ issue: entry.issue, availableFiles: Object.keys(entry.files) }),
  ].join("\n");
}

export function scorePlan(raw: string, entry: PlanCase): Score {
  let plan;
  try { plan = JSON.parse(raw.trim().replace(/^```(?:json)?\s*(.*?)\s*```$/s, "$1")); }
  catch { return { passed: false, failures: ["invalid_json"] }; }
  const strings = (values: unknown): values is string[] =>
    Array.isArray(values) && values.length <= 30 && values.every(value => text(value, 2000));
  if (!plan || !["proposed", "needs_clarification"].includes(plan.status) || !text(plan.summary, 4000) ||
      !strings(plan.files) || !strings(plan.steps) || !strings(plan.acceptance) || !strings(plan.questions) ||
      !Array.isArray(plan.evidence) || plan.evidence.length > 30) return { passed: false, failures: ["invalid_schema"] };
  const failures: string[] = [];
  if (plan.status !== entry.expected) failures.push("unexpected_status");
  if (plan.files.some((name: string) => !Object.hasOwn(entry.files, name))) failures.push("outside_file_scope");
  if (plan.evidence.some((item: { path?: string; quote?: string } | null) =>
    !item || typeof item.path !== "string" || !text(item.quote, 2000) ||
    !Object.hasOwn(entry.files, item.path) || !entry.files[item.path].includes(item.quote!))) failures.push("unverified_evidence");
  if (plan.status === "proposed" && (!plan.evidence.length || !plan.steps.length || !plan.acceptance.length)) failures.push("incomplete_plan");
  if (plan.status === "needs_clarification" && !plan.questions.length) failures.push("missing_question");
  return { passed: !failures.length, failures };
}
