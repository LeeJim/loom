import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function sandboxArgs(input: {
  name: string;
  work: string;
  edit: boolean;
  model: string;
  network: string;
  image: string;
  prompt: string;
}): string[] {
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(input.model)) throw new Error("Invalid model identifier");
  if (!/^[A-Za-z0-9_.-]+$/.test(input.name) ||
      !/^[A-Za-z0-9_.-]+$/.test(input.network) || input.network.startsWith("-") ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/@-]+$/.test(input.image)) {
    throw new Error("Invalid sandbox configuration");
  }
  const provider = {
    provider: {
      gateway: {
        npm: "@ai-sdk/openai-compatible",
        name: "AgentGateway",
        options: { baseURL: "http://gateway:4000/v1", apiKey: "sandbox" },
        models: { [input.model]: { name: input.model } },
      },
    },
    enabled_providers: ["gateway"],
    permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", edit: input.edit ? "allow" : "deny" },
  };
  const work = resolve(input.work);
  if (work.includes(",") || work.includes("\n")) throw new Error("Invalid sandbox path");
  return [
    "run", "--rm", "--name", input.name, "--label", "loom.role=temporal-worker",
    "--network", input.network, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--memory", "512m", "--cpus", "1",
    "--pids-limit", "128", "--mount", `type=bind,source=${work},target=/work${input.edit ? "" : ",readonly"}`,
    "-e", `OPENCODE_CONFIG_CONTENT=${JSON.stringify(provider)}`,
    input.image, "run", "--model", `gateway/${input.model}`, "--", input.prompt,
  ];
}

export async function runOpenCode(
  input: Omit<Parameters<typeof sandboxArgs>[0], "name">,
  signal?: AbortSignal,
): Promise<string> {
  const name = `loom-temporal-${randomUUID()}`;
  const args = sandboxArgs({ ...input, name });
  // The command line can contain Issue text. Keep process exceptions outside persisted history.
  try {
    const { stdout } = await execute("docker", args, { signal, timeout: 240_000, maxBuffer: 1024 * 1024 });
    if (stdout.trim()) return stdout;
    throw new Error("Empty OpenCode output");
  } catch {
    await execute("docker", ["rm", "-f", name], { timeout: 15_000 }).catch(() => undefined);
    throw new Error("OpenCode sandbox did not produce an output");
  }
}
