import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pilotActivities } from "./activity-adapter.js";
import { ArtifactStore } from "./artifacts.js";
import type { GitHub, GitHubComment } from "./github.js";
import { issueDirective, planMarker, verifySignature } from "./ingress.js";
import { sandboxArgs } from "./opencode.js";

test("only authenticated deliveries can be parsed as GitHub events", () => {
  const raw = Buffer.from('{"action":"created"}');
  const key = Buffer.from("test-secret");
  const signature = "sha256=" + createHmac("sha256", key).update(raw).digest("hex");
  assert(verifySignature(raw, signature, key));
  assert(!verifySignature(Buffer.from("changed"), signature, key));
  assert(!verifySignature(raw, signature, Buffer.alloc(0)));
});

test("approval binds to the most recent bot plan older than the comment", async () => {
  const draft = (id: number, version: number): GitHubComment => ({
    id, body: planMarker(version) + "\nplan", html_url: "https://example.test/",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    user: { id: 10, login: "previous-loom[bot]", type: "Bot" },
  });
  const approved = { ...draft(20, 1), body: "@loom 通过", user: { id: 50, login: "maintainer", type: "User" } };
  const github = {
    botUserId: async () => 10,
    async *comments() { yield draft(30, 2); yield draft(10, 1); },
    authorized: async (user: GitHubComment["user"]) => user.id === 50,
  };
  const issue = { repository: "owner/repo", number: 1 };
  assert.deepEqual(await issueDirective(github, issue, approved, "test"), {
    kind: "directive", issue, delivery: "test",
    directive: { id: 20, version: 1, actorId: 50, kind: "approve" },
  });
  assert.equal(await issueDirective(github, issue, { ...approved, body: "通过" }, "test"), undefined);
  assert.equal(await issueDirective(github, issue, { ...approved, user: draft(10, 1).user }, "test"), undefined);
});

test("artifact writes are stable across retries and verify contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-artifacts-test-"));
  try {
    const store = new ArtifactStore(directory);
    const [ref, repeated] = await Promise.all([store.put("fixture"), store.put("fixture")]);
    assert.deepEqual(ref, repeated);
    assert.equal((await store.read(ref)).toString(), "fixture");
    await assert.rejects(store.read({ ...ref, ref: "../secret" }), /Invalid artifact/);
    await writeFile(join(directory, ref.ref), "tampered");
    await assert.rejects(store.read(ref), /digest mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenCode sandbox planning uses gateway only and a read-only mount", () => {
  const args = sandboxArgs({
    name: "fixture", work: "/tmp/fixture", edit: false, model: "deepseek/test",
    network: "loom-sandbox", image: "loom-opencode:1.19.6", prompt: "fixture",
  });
  const config = JSON.parse(args.find(value => value.startsWith("OPENCODE_CONFIG_CONTENT="))!.split("=", 2)[1]);
  assert.deepEqual(config.enabled_providers, ["gateway"]);
  assert.equal(config.provider.gateway.options.baseURL, "http://gateway:4000/v1");
  assert.equal(config.permission.edit, "deny");
  assert(args.includes("gateway/deepseek/test"));
  assert(args.some(value => value.endsWith("target=/work,readonly")));
});

test("plan comment retry finds the existing Bot-authored receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-comment-test-"));
  const recorded: GitHubComment[] = [];
  const github = {
    botUserId: async () => 42,
    issuePath: () => "/issues/1",
    async *comments() { yield* recorded; },
    async postIssueComment(_issue: unknown, body: string): Promise<GitHubComment> {
      const comment = {
        id: 100, body, html_url: "https://example.test/issuecomment-100",
        created_at: "", updated_at: "", user: { id: 42, type: "Bot", login: "loom[bot]" },
      };
      recorded.push(comment);
      // Simulate GitHub accepting the write before the client receives the response.
      throw new Error("Lost response");
    },
  } as unknown as GitHub;
  try {
    const artifacts = new ArtifactStore(directory);
    const activities = pilotActivities({
      github, workspace: directory, artifacts, profiles: new Map([[1, ["README.md"]]]),
      model: "deepseek/test", network: "loom-sandbox", image: "loom-opencode:1.19.6",
      recordCi: async () => {},
    });
    const issue = { repository: "owner/repo", number: 1 };
    const plan = { baseSha: "a".repeat(40), version: 1, artifact: await artifacts.put("fixture") };
    await assert.rejects(activities.postPlan(issue, plan), /Lost response/);
    assert.equal((await activities.postPlan(issue, plan)).commentId, 100);
    assert.equal(recorded.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
