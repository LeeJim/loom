export type Issue = { repository: string; number: number };
export type Artifact = { ref: string; sha256: string };
export type Plan = { version: number; baseSha: string; artifact: Artifact };
export type PublishedPlan = { commentId: number; url: string };
export type Directive = {
  id: number;
  actorId: number;
  version: number;
  kind: "approve" | "feedback";
};
export type Validation = { ok: true; evidence: Artifact } | { ok: false; evidence: Artifact };
export type Draft = { number: number; headSha: string; url: string };
export type CiResult = { runId: number; attempt: number; pr: number; headSha: string; conclusion: string };

export interface Activities {
  draftPlan(issue: Issue, version: number, previous?: Plan, feedback?: Directive[]): Promise<Plan>;
  postPlan(issue: Issue, plan: Plan): Promise<PublishedPlan>;
  recheckApproval(issue: Issue, plan: Plan, published: PublishedPlan, approval: Directive):
    Promise<"valid" | "stale" | "revoked">;
  code(issue: Issue, plan: Plan): Promise<Artifact>;
  validate(issue: Issue, patch: Artifact): Promise<Validation>;
  repair(issue: Issue, plan: Plan, patch: Artifact, evidence: Artifact): Promise<Artifact>;
  publish(issue: Issue, plan: Plan, patch: Artifact): Promise<Draft | null>;
  recordCi(issue: Issue, draft: Draft, result: CiResult): Promise<void>;
}
