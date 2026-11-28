import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { piOutput } from "./experiment-activities.js";
import { scorePlan, validateExperiment, type Experiment, type PlanCase, type Report } from "./experiment.js";
import type { ExperimentActivities } from "./experiment-workflow.js";

const entry: PlanCase = {
  id: "one", scenario: "clear", base: "a".repeat(40),
  issue: "Change the counter", files: { "counter.ts": "const value = 1;" }, expected: "proposed",
};
const spec: Experiment = {
  model: "deepseek/model", cases: [entry],
  variants: [
    { id: "baseline", harness: "opencode", image: "test/open@sha256:" + "a".repeat(64), prompt: "Plan" },
    { id: "candidate", harness: "pi", image: "test/pi@sha256:" + "b".repeat(64), prompt: "Plan" },
  ],
};

test("manifests require digest-pinned images and safe file paths", () => {
  assert.equal(validateExperiment(spec), spec);
  assert.throws(() => validateExperiment({ ...spec, cases: [{ ...entry, files: { "../key": "fixture" } }] }));
  assert.throws(() => validateExperiment({ ...spec, variants: [{ ...spec.variants[0], image: "test/open:latest" }, spec.variants[1]] }));
});

test("accepts verified evidence and rejects claims beyond the supplied files", () => {
  const plan = {
    status: "proposed", summary: "Update counter", files: ["counter.ts"],
    evidence: [{ path: "counter.ts", quote: "const value = 1;" }], steps: ["Update the constant"],
    acceptance: ["Test the counter"], questions: [],
  };
  assert.deepEqual(scorePlan(JSON.stringify(plan), entry), { passed: true, failures: [] });
  const fabricated = { ...plan, files: ["private.ts"], evidence: [{ path: "counter.ts", quote: "not in source" }] };
  assert.deepEqual(scorePlan(JSON.stringify(fabricated), entry).failures, ["outside_file_scope", "unverified_evidence"]);
});

test("Pi adapter consumes final assistant text rather than tool output", () => {
  const line = (role: string, text: string) => JSON.stringify({
    type: "message_end", message: { role, content: [{ type: "text", text }] },
  });
  assert.equal(piOutput([line("assistant", "draft"), line("toolResult", "ignore"), line("assistant", "final")].join("\n")), "final");
  assert.throws(() => piOutput(line("toolResult", "ignore")));
});

test("Temporal runs the baseline and candidate as a pair and persists their report",
  { timeout: 120_000 }, async () => {
    const env = await TestWorkflowEnvironment.createLocal();
    let save: Report | undefined;
    const activities: ExperimentActivities = {
      loadExperiment: async () => ({ model: spec.model, cases: ["one"], variants: ["baseline", "candidate"] }),
      evaluate: async (_, caseId, variant) => ({ caseId, variant, scenario: "clear", elapsedMs: 10,
        score: { passed: variant === "baseline", failures: variant === "baseline" ? [] : ["invalid_schema"] } }),
      saveReport: async report => { save = report; },
    };
    try {
      const queue = "loom-plan-tests";
      const worker = await Worker.create({
        connection: env.nativeConnection, taskQueue: queue,
        workflowsPath: fileURLToPath(new URL("./experiment-workflow.js", import.meta.url)), activities,
      });
      const report = await worker.runUntil(env.client.workflow.execute("comparePlanningAgents", {
        taskQueue: queue, workflowId: "loom-exp/test/pair", args: [{ ref: "a", sha256: "a" }],
      }));
      assert.deepEqual(report, save);
      assert.deepEqual(save?.results.map(row => [row.variant, row.score.passed]), [["baseline", true], ["candidate", false]]);
    } finally { await env.teardown(); }
  });
