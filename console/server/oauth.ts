import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type User = { id: number; login: string };
const entropy = () => randomBytes(32).toString("base64url");

class Tokens<T> {
  private items = new Map<string, { value: T; expires: number }>();
  constructor(private seconds: number) {}
  put(value: T) {
    for (const [key, item] of this.items) if (item.expires <= Date.now()) this.items.delete(key);
    if (this.items.size >= 1024) this.items.delete(this.items.keys().next().value!);
    const token = entropy();
    this.items.set(token, { value, expires: Date.now() + this.seconds * 1000 });
    return token;
  }
  get(token?: string, consume = false) {
    if (!token) return;
    const item = this.items.get(token);
    if (consume) this.items.delete(token);
    if (item && item.expires > Date.now()) return item.value;
  }
}

export const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/console/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
export function cookieValue(header: string | undefined, name: string) {
  return header?.split(";").map(item => item.trim()).find(item => item.startsWith(name + "="))?.slice(name.length + 1);
}

export class OAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class OAuth {
  private states = new Tokens<string>(300);
  private sessions = new Tokens<User>(3600);
  constructor(
    readonly origin = (process.env.LOOM_CONSOLE_ORIGIN || "https://ai.anyhub.cn").replace(/\/$/, ""),
    private clientId = process.env.LOOM_GITHUB_OAUTH_CLIENT_ID,
    private secret = process.env.LOOM_GITHUB_OAUTH_CLIENT_SECRET,
    private request = fetch,
  ) {}
  get enabled() { return Boolean(this.clientId && this.secret); }
  private get callback() { return this.origin + "/console/oauth/callback"; }
  user(header?: string) { return this.sessions.get(cookieValue(header, "loom_session")); }
  logout(header?: string) {
    this.sessions.get(cookieValue(header, "loom_session"), true);
    return cookie("loom_session", "", 0);
  }
  begin() {
    const verifier = entropy();
    const state = this.states.put(verifier);
    const query = new URLSearchParams({
      client_id: this.clientId!, redirect_uri: this.callback, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    return { url: "https://github.com/login/oauth/authorize?" + query,
      cookies: [cookie("loom_oauth_state", state, 300)] };
  }
  async finish(state: string | null, code: string | null, header?: string) {
    const browser = cookieValue(header, "loom_oauth_state");
    if (!code || !state || !browser || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !/^[A-Za-z0-9_-]{43}$/.test(browser) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(browser))) throw new OAuthError(400, "github_login_failed");
    const verifier = this.states.get(state, true);
    if (!verifier) throw new OAuthError(400, "github_login_failed");
    const response = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ client_id: this.clientId!, client_secret: this.secret!,
        redirect_uri: this.callback, code, code_verifier: verifier }),
    });
    const token = response.ok ? (await response.json()).access_token : null;
    if (typeof token !== "string" || !token) throw new OAuthError(400, "github_login_failed");
    const get = async (path: string) => {
      const result = await this.request("https://api.github.com" + path, {
        redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Loom" },
      });
      if (!result.ok) throw new OAuthError(400, "github_login_failed");
      return result.json();
    };
    const [user, repo] = await Promise.all([get("/user"), get("/repos/LeeJim/HowToCookOnMiniprogram")]);
    if (user.type !== "User" || !Number.isSafeInteger(user.id) || user.id <= 0 ||
        typeof user.login !== "string" || repo.permissions?.push !== true) {
      throw new OAuthError(403, "repository_access_required");
    }
    return [cookie("loom_session", this.sessions.put({ id: user.id, login: user.login }), 3600),
      cookie("loom_oauth_state", "", 0)];
  }
}
