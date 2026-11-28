import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { issueClient } from "./client.js";
import type { Activities } from "./contracts.js";
import { Outbox } from "./outbox.js";
import type { IssueStatus } from "./workflow.js";

test("two Issues resume from approval after Worker restart; stale and duplicate events are ignored",
  { timeout: 120_000 }, async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const queue = "loom-temporal-test";
    const client = issueClient(environment.client, queue);
    const first = { repository: "Test/Loom", number: 1 };
    const second = { repository: "Test/Loom", number: 2 };
    const artifact = { ref: "fixture", sha256: "a".repeat(64) };
    const deliveries: number[] = [];
    const plans: string[] = [];
    const activities: Activities = {
      draftPlan: async (_, version) => ({ version, baseSha: "base", artifact }),
      postPlan: async (issue, plan) => {
        plans.push(`${issue.number}:${plan.version}`);
        return { commentId: plan.version * 100, url: "https://example.test/issue" };
      },
      recheckApproval: async () => "valid",
      code: async (issue, plan) => {
        deliveries.push(issue.number * 10 + plan.version);
        return artifact;
      },
      validate: async () => ({ ok: true, evidence: artifact }),
      repair: async () => artifact,
      publish: async issue => ({ number: issue.number + 10, headSha: "head", url: "https://example.test/pr" }),
      recordCi: async () => {},
    };
    const create = () => Worker.create({
      connection: environment.nativeConnection,
      taskQueue: queue,
      workflowsPath: fileURLToPath(new URL("./workflow.js", import.meta.url)),
      activities,
    });
    try {
      const handles = await Promise.all([client.start(first), client.start(second)]);
      const reach = async (index: number, stage: IssueStatus["stage"], version: number) => {
        for (let attempt = 0; attempt < 150; attempt++) {
          const state = await handles[index].query<IssueStatus>("loom.status");
          if (state.stage === stage && state.version === version) return;
          await delay(25);
        }
        assert.fail(`Issue did not reach ${stage}/${version}`);
      };
      const before = await create();
      await before.runUntil(async () => {
        await Promise.all([reach(0, "approval", 1), reach(1, "approval", 1)]);
        assert.deepEqual(deliveries, []);
      });
      const after = await create();
      await after.runUntil(async () => {
        const feedback = { id: 101, actorId: 1, version: 1, kind: "feedback" as const };
        await client.directive(first, feedback);
        await client.directive(first, feedback);
        await reach(0, "approval", 2);
        await client.directive(first, { id: 102, actorId: 1, version: 1, kind: "approve" });
        await client.directive(second, { id: 101, actorId: 1, version: 1, kind: "approve" });
        await reach(1, "publication", 1);
        await client.publication(second);
        await reach(1, "ci", 1);
        assert.deepEqual(deliveries, [21]);
        await client.directive(first, { id: 201, actorId: 1, version: 2, kind: "approve" });
        await reach(0, "publication", 2);
        await client.publication(first);
        await reach(0, "ci", 2);
        const ci = { runId: 50, attempt: 1, pr: 11, headSha: "head", conclusion: "success" };
        await client.ci(first, { ...ci, headSha: "wrong" });
        await client.ci(first, ci);
        await client.ci(second, { ...ci, runId: 51, pr: 12 });
        await Promise.all(handles.map(handle => handle.result()));
        assert.deepEqual(deliveries, [21, 12]);
        assert.deepEqual(plans.sort(), ["1:1", "1:2", "2:1"]);
      });
    } finally {
      await environment.teardown();
    }
  });

test("outbox retains a delivery on transient failure and deduplicates input", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const outbox = new Outbox(db);
    const event = { kind: "start" as const, delivery: "fixture", issue: { repository: "Test/Loom", number: 1 } };
    outbox.enqueue(event);
    outbox.enqueue(event);
    let calls = 0;
    const transport = {
      start: async () => { if (++calls === 1) throw new Error("unavailable"); },
    } as unknown as ReturnType<typeof issueClient>;
    await assert.rejects(outbox.dispatch(transport), /unavailable/);
    assert.equal(await outbox.dispatch(transport), 1);
    assert.equal(await outbox.dispatch(transport), 0);
  } finally {
    db.close();
  }
});
