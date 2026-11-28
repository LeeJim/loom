import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { ExperimentActivities } from "./experiment-workflow.js";
import { gains, parseCandidates, validateRsi, type RsiManifest, type RsiRecommendation } from "./rsi.js";
import type { RsiActivities } from "./rsi-workflow.js";

const cases = { id: "validation", scenario: "clear", base: "d".repeat(40), issue: "Example issue",
  files: { "a.ts": "const a = 1;" }, expected: "proposed" as const };
const manifest: RsiManifest = {
  sourceReportId: "loom-exp/" + "b".repeat(20) + "/source",
  validation: {
    model: "gateway/model", cases: [cases],
    variants: [
      { id: "baseline", harness: "pi", image: "registry/pi@sha256:" + "a".repeat(64), prompt: "old prompt" },
      { id: "existing", harness: "pi", image: "registry/pi@sha256:" + "a".repeat(64), prompt: "prior comparison" },
    ],
  },
  holdout: [{ ...cases, id: "holdout", issue: "A separate issue", files: { "b.ts": "const b = 2;" } }],
};

test("rejects disallowed candidate fields and reused holdout content", () => {
  assert.equal(parseCandidates('[{"prompt":"one"},{"prompt":"two"}]', "baseline").length, 2);
  assert.throws(() => parseCandidates('[{"prompt":"one","tool":"shell"},{"prompt":"two"}]', "baseline"));
  assert.throws(() => parseCandidates('[{"prompt":"one"},{"prompt":" one "}]', "baseline"));
  assert.doesNotThrow(() => validateRsi(manifest));
  assert.throws(() => validateRsi({ ...manifest, holdout: [{ ...cases, id: "different" }] }));
});

test("paired decisions reject regressions and fabricated evidence", () => {
  const row = { caseId: "validation", scenario: "clear", elapsedMs: 1 };
  const report = (before: boolean, after: boolean, failures: string[] = []) => ({
    id: "fixture", model: "gateway/model", snapshot: "fixture", results: [
      { ...row, variant: "baseline", score: { passed: before, failures: [] } },
      { ...row, variant: "rsi-1", score: { passed: after, failures } },
    ],
  });
  assert.equal(gains(report(false, true), "baseline", "rsi-1"), 1);
  assert.equal(gains(report(true, false), "baseline", "rsi-1"), null);
  assert.equal(gains(report(false, false, ["unverified_evidence"]), "baseline", "rsi-1"), null);
});

test("Temporal RSI retains only an improved candidate after independent holdout",
  { timeout: 120_000 }, async () => {
    const env = await TestWorkflowEnvironment.createLocal();
    const recommendations: RsiRecommendation[] = [];
    const trials: string[] = [];
    const activities: RsiActivities & ExperimentActivities = {
      proposePrompts: async () => ({
        sourceReport: manifest.sourceReportId, baselineId: "baseline", baselinePrompt: "old prompt", scope: ["clear"],
        candidates: [{ id: "rsi-1", prompt: "first" }, { id: "rsi-2", prompt: "second" }],
      }),
      pairedSnapshot: async (_, candidate, holdout) => {
        trials.push(`${candidate.id}:${holdout}`);
        return { ref: candidate.id, sha256: holdout ? "holdout" : "validation" };
      },
      saveRecommendation: async item => { recommendations.push(item); },
      loadExperiment: async snapshot => ({ cases: [snapshot.sha256], variants: ["baseline", snapshot.ref], model: "gateway/model" }),
      evaluate: async (_, caseId, variant) => ({
        caseId, variant, scenario: "clear", elapsedMs: 5,
        score: { passed: variant === "rsi-1" || caseId === "holdout", failures: [] },
      }),
      saveReport: async () => {},
    };
    try {
      const taskQueue = "loom-rsi-test";
      const worker = await Worker.create({
        connection: env.nativeConnection, taskQueue,
        workflowsPath: fileURLToPath(new URL("./rsi-workflow.js", import.meta.url)), activities,
      });
      const result = await worker.runUntil(env.client.workflow.execute("improvePlanningAgent", {
        workflowId: "loom-rsi/test/run", taskQueue, args: [{ ref: "fixture", sha256: "fixture" }],
      }));
      assert.deepEqual(result, recommendations[0]);
      assert.equal(recommendations[0]?.state, "pending_review");
      assert.equal(recommendations[0]?.candidate?.id, "rsi-1");
      assert.deepEqual(trials, ["rsi-1:false", "rsi-2:false", "rsi-1:true"]);
    } finally { await env.teardown(); }
  });
