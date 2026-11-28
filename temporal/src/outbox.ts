import { DatabaseSync } from "node:sqlite";
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { issueClient, workflowId } from "./client.js";
import type { CiResult, Directive, Issue } from "./contracts.js";

export type VerifiedEvent =
  | { kind: "start" | "publication"; delivery: string; issue: Issue }
  | { kind: "directive"; delivery: string; issue: Issue; directive: Directive }
  | { kind: "ci"; delivery: string; issue: Issue; result: CiResult };

type Cursor = { id: number; payload: string };
export class Outbox {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_outbox (
        id INTEGER PRIMARY KEY, delivery TEXT NOT NULL UNIQUE, workflow_id TEXT NOT NULL,
        payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS temporal_outbox_pending ON temporal_outbox(sent,id);
    `);
  }

  // Insert in the transaction that records the verified GitHub delivery.
  enqueue(event: VerifiedEvent): void {
    this.db.prepare("INSERT OR IGNORE INTO temporal_outbox(delivery,workflow_id,payload) VALUES(?,?,?)")
      .run(event.delivery, workflowId(event.issue), JSON.stringify(event));
  }

  // Run one dispatcher per database. A crash between signal and acknowledgment is an at-least-once delivery.
  async dispatch(client: ReturnType<typeof issueClient>): Promise<number> {
    const events = this.db.prepare(`
      SELECT id,payload FROM temporal_outbox WHERE sent=0 AND retry_at<=unixepoch() ORDER BY id LIMIT 100
    `).all() as Cursor[];
    const acknowledge = this.db.prepare("UPDATE temporal_outbox SET sent=1 WHERE id=?");
    const defer = this.db.prepare("UPDATE temporal_outbox SET retry_at=unixepoch()+5 WHERE id=?");
    let count = 0;
    for (const row of events) {
      const event = JSON.parse(row.payload) as VerifiedEvent;
      try {
        switch (event.kind) {
          case "start": await client.start(event.issue); break;
          case "directive": await client.directive(event.issue, event.directive); break;
          case "publication": await client.publication(event.issue); break;
          case "ci": await client.ci(event.issue, event.result); break;
        }
      } catch (error) {
        if (event.kind === "start" && error instanceof WorkflowExecutionAlreadyStartedError) {
          // A prior dispatch already started this Issue.
        } else if (error instanceof WorkflowNotFoundError && event.kind !== "start") {
          if (!await client.completed(event.issue)) {
            defer.run(row.id);
            continue;
          }
        } else {
          throw error;
        }
      }
      acknowledge.run(row.id);
      count++;
    }
    return count;
  }
}
