import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "./contracts.js";

const digest = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

export class ArtifactStore {
  constructor(private readonly directory: string) {}

  async put(content: Buffer | string): Promise<Artifact> {
    const sha256 = digest(content);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${randomUUID()}`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      try {
        await link(temporary, join(this.directory, sha256));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return { sha256, ref: sha256 };
  }

  async read(artifact: Artifact): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.ref !== artifact.sha256) {
      throw new Error("Invalid artifact reference");
    }
    const content = await readFile(join(this.directory, artifact.ref));
    if (digest(content) !== artifact.sha256) throw new Error("Artifact digest mismatch");
    return content;
  }
}
