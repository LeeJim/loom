import type { DatabaseSync } from "node:sqlite";
import { withDb } from "./data.js";

const idPattern = /^loom-rsi\/[a-f0-9]{20}\/[A-Za-z0-9_-]{1,40}$/;
type Preview = {
  id: string; sourceReport: string; state: string; reason: string;
  comparisons: string[]; candidate?: { id: string; prompt: string }; baselinePrompt?: string; scope?: string[];
};

export function canReviewRsi(user?: number) {
  return user !== undefined && (process.env.LOOM_RSI_REVIEWER_IDS || "").split(",")
    .some(item => item.trim() === String(user));
}

function exists(db: DatabaseSync, table: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
}

export function listRsi(store: string, database: string, actor?: number) {
  const allow = canReviewRsi(actor);
  const items = withDb(store, true, db => exists(db, "planning_rsi_recommendations")
    ? db.prepare("SELECT recommendation FROM planning_rsi_recommendations ORDER BY recorded_at DESC,id DESC LIMIT 10")
      .all().map(row => JSON.parse(String(row.recommendation)) as Preview)
    : []);
  return withDb(database, true, db => {
    const reviews = exists(db, "loom_rsi_reviews")
      ? db.prepare("SELECT decision,recorded_at FROM loom_rsi_reviews WHERE recommendation_id=?") : null;
    return items.map(item => {
      const { candidate, baselinePrompt, ...details } = item;
      return { ...details, ...(allow ? { candidate, baselinePrompt } : {}),
        canReview: allow && item.state === "pending_review", review: reviews?.get(item.id) ?? null };
    });
  });
}

export function reviewRsi(store: string, database: string, actor: number, id: unknown, decision: unknown) {
  if (typeof id !== "string" || !idPattern.test(id) || (decision !== "approved" && decision !== "rejected")) return 400;
  const raw = withDb(store, true, db => exists(db, "planning_rsi_recommendations") && db.prepare(
    "SELECT recommendation FROM planning_rsi_recommendations WHERE id=?",
  ).get(id));
  if (!raw) return 404;
  const recommendation = JSON.parse(String(raw.recommendation)) as Preview;
  if (recommendation.state !== "pending_review" || !recommendation.candidate) return 409;
  return withDb(database, false, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS loom_rsi_reviews (
      recommendation_id TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, decision TEXT NOT NULL,
      candidate TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    return db.prepare("INSERT OR IGNORE INTO loom_rsi_reviews(recommendation_id,actor_id,decision,candidate) VALUES(?,?,?,?)")
      .run(id, actor, decision, JSON.stringify(recommendation.candidate)).changes ? 201 : 409;
  });
}
