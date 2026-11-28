import { createSign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Issue } from "./contracts.js";

export type GitHubComment = {
  id: number; body: string; html_url: string; created_at: string; updated_at: string;
  user: { id: number; login: string; type: string };
};
export type GitHubIssue = {
  title: string; body: string | null; state: string; pull_request?: unknown;
  labels: Array<{ name: string }>;
};

export class GitHubError extends Error {
  constructor(readonly status: number) { super(`GitHub request failed with HTTP ${status}`); }
}

export class GitHub {
  private token?: { value: string; expires: number };
  constructor(readonly repository: string, private readonly config: string, readonly bot: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  }

  issuePath(issue: Issue): string {
    if (issue.repository.toLowerCase() !== this.repository.toLowerCase() ||
        !Number.isSafeInteger(issue.number) || issue.number <= 0) {
      throw new Error("Issue is outside the configured repository");
    }
    return `/issues/${issue.number}`;
  }

  private async request<T>(token: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch("https://api.github.com" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "Content-Type": "application/json", "User-Agent": "Loom-Temporal",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GitHubError(response.status);
    return await response.json() as T;
  }

  async installationToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const config = JSON.parse(await readFile(this.config, "utf8")) as { app_id: number | string; private_key_file: string };
    const key = config.private_key_file;
    if (!/^[1-9]\d*$/.test(String(config.app_id)) || !isAbsolute(key)) throw new Error("Invalid GitHub App configuration");
    const keyStat = await stat(key);
    if (!keyStat.isFile() || keyStat.mode & 0o077) throw new Error("GitHub App key must be private");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(config.app_id) })).toString("base64url");
    const input = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(input).sign(await readFile(key), "base64url");
    const jwt = `${input}.${signature}`;
    const installation = await this.request<{ id: number }>(jwt, `/repos/${this.repository}/installation`);
    const permissions = { contents: "write", pull_requests: "write" };
    const issued = await this.request<{ token: string; expires_at: string; permissions: Record<string, string> }>(
      jwt, `/app/installations/${installation.id}/access_tokens`,
      { repositories: [this.repository.split("/")[1]], permissions },
    );
    if (!/^[\w.-]+$/.test(issued.token) ||
        Object.entries(permissions).some(([name, access]) => issued.permissions[name] !== access)) {
      throw new Error("GitHub App credentials lack repository-scoped access");
    }
    this.token = { value: issued.token, expires: Date.parse(issued.expires_at) };
    return issued.token;
  }

  async repo<T>(path: string, body?: unknown): Promise<T> {
    return this.request(await this.installationToken(), `/repos/${this.repository}${path}`, body);
  }

  async *comments(issue: Issue): AsyncGenerator<GitHubComment> {
    for (let page = 1; ; page++) {
      const batch = await this.repo<GitHubComment[]>(`${this.issuePath(issue)}/comments?per_page=100&page=${page}`);
      yield* batch;
      if (batch.length < 100) return;
    }
  }

  async authorized(user: GitHubComment["user"]): Promise<boolean> {
    if (user.type !== "User" || !/^[a-zA-Z0-9-]{1,39}$/.test(user.login)) return false;
    try {
      const response = await this.repo<{ permission: string; user: { id: number } }>(
        `/collaborators/${user.login}/permission`,
      );
      return response.user.id === user.id && ["write", "admin"].includes(response.permission);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }
}
