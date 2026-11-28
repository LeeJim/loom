import { timingSafeEqual, createHmac } from "node:crypto";
import type { Directive, Issue } from "./contracts.js";
import type { GitHub, GitHubComment } from "./github.js";
import type { VerifiedEvent } from "./outbox.js";

export function verifySignature(raw: Buffer, header: string, secret: Buffer): boolean {
  if (secret.length === 0 || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  const digest = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(digest, Buffer.from(header.slice(7), "hex"));
}

export const planMarker = (version: number) => `<!-- loom-temporal-plan:${version} -->`;
const markerPattern = /^<!-- loom-temporal-plan:([1-9]\d*) -->\r?\n/;
const commandPattern = /^@loom\s+(\S[\s\S]*)$/;

export function planVersion(comment: GitHubComment, botId: number): number | undefined {
  if (comment.user.id !== botId || comment.user.type !== "Bot") return undefined;
  const value = Number(markerPattern.exec(comment.body)?.[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

export async function issueDirective(
  github: Pick<GitHub, "comments" | "authorized" | "botUserId">,
  issue: Issue,
  comment: GitHubComment,
  delivery: string,
): Promise<VerifiedEvent | undefined> {
  if (!Number.isSafeInteger(comment.id) || !Number.isSafeInteger(comment.user.id) ||
      comment.created_at !== comment.updated_at || !commandPattern.test(comment.body.trim()) ||
      !await github.authorized(comment.user)) return undefined;

  const botId = await github.botUserId();
  let version: number | undefined;
  let latestId = 0;
  for await (const posted of github.comments(issue)) {
    if (posted.id < comment.id && posted.id > latestId && posted.created_at <= comment.created_at) {
      const candidate = planVersion(posted, botId);
      if (candidate !== undefined) {
        latestId = posted.id;
        version = candidate;
      }
    }
  }
  if (version === undefined) return undefined;
  const directive: Directive = {
    id: comment.id, actorId: comment.user.id, version,
    kind: comment.body.trim().replace(/^@loom\s+/, "") === "通过" ? "approve" : "feedback",
  };
  return { kind: "directive", issue, delivery, directive };
}
