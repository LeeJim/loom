import { Client, WorkflowIdReusePolicy, WorkflowNotFoundError } from "@temporalio/client";
import type { CiResult, Directive, Issue } from "./contracts.js";

export function workflowId(issue: Issue): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(issue.repository) ||
      !Number.isSafeInteger(issue.number) || issue.number <= 0) {
    throw new Error("Invalid issue identity");
  }
  return `loom/${issue.repository.toLowerCase()}/${issue.number}`;
}

export function issueClient(client: Client, taskQueue: string) {
  // Call these methods only after Loom has verified and authorized the source event.
  return {
    completed: async (issue: Issue) => {
      try {
        const description = await client.workflow.getHandle(workflowId(issue)).describe();
        return description.status.name !== "RUNNING";
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return false;
        throw error;
      }
    },
    start: (issue: Issue) => client.workflow.start("issueWorkflow", {
      workflowId: workflowId(issue), taskQueue, args: [issue],
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    }),
    directive: (issue: Issue, event: Directive) =>
      client.workflow.getHandle(workflowId(issue)).signal("loom.directive", event),
    publication: (issue: Issue) => client.workflow.getHandle(workflowId(issue)).signal("loom.publication.requested"),
    ci: (issue: Issue, event: CiResult) => client.workflow.getHandle(workflowId(issue)).signal("loom.ci.completed", event),
  };
}
