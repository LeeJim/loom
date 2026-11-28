import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { GitHub } from "./github.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

export async function pilotConfig() {
  const profilePath = required("LOOM_TEMPORAL_PROFILES");
  const workspace = required("LOOM_TEMPORAL_WORKSPACE");
  const data = required("LOOM_TEMPORAL_DATA");
  const key = required("LOOM_GITHUB_APP_CONFIG");
  if (![profilePath, workspace, data, key].every(isAbsolute)) throw new Error("Pilot paths must be absolute");
  const github = new GitHub(required("LOOM_TEMPORAL_REPOSITORY"), key, required("LOOM_TEMPORAL_GITHUB_BOT"));
  const profiles = new Map<number, readonly string[]>();
  for (const [number, paths] of Object.entries(JSON.parse(await readFile(profilePath, "utf8")))) {
    if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number)) ||
        !Array.isArray(paths) || !paths.every(path => typeof path === "string")) throw new Error("Invalid pilot profile");
    profiles.set(Number(number), paths as string[]);
  }
  return {
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: process.env.LOOM_TEMPORAL_QUEUE ?? "loom-pilot",
    github, profiles, workspace, data,
    model: process.env.LOOM_AGENT_DEFAULT_MODEL ?? "deepseek/deepseek-v4-flash",
    network: process.env.LOOM_TEMPORAL_NETWORK ?? "loom-sandbox",
    image: process.env.LOOM_TEMPORAL_IMAGE ?? "loom-opencode:1.19.6",
  };
}
