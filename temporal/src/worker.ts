import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { Activities } from "./contracts.js";

export async function runWorker(
  activities: Activities,
  options: { address: string; namespace: string; taskQueue: string; concurrency: number },
): Promise<void> {
  const connection = await NativeConnection.connect({ address: options.address });
  try {
    const worker = await Worker.create({
      connection,
      namespace: options.namespace,
      taskQueue: options.taskQueue,
      maxConcurrentActivityTaskExecutions: options.concurrency,
      workflowsPath: fileURLToPath(new URL("./workflow.js", import.meta.url)),
      activities,
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}
