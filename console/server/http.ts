import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilities, ModelCatalogUnavailable, ModelUnavailable } from "./capabilities.js";
import {
  audit, createWorker, defaultDb, InvalidRequest, positiveInt, queueRun, setWorkerState,
  snapshot, temporalActivities, timeline, validateWorker, withDb, workers,
} from "./data.js";
import { OAuth, OAuthError } from "./oauth.js";

const fallbackRoutes = new Set(["/", "/tasks", "/executions", "/workers", "/capabilities", "/audit"]);
const staticRoot = fileURLToPath(new URL("../web/", import.meta.url));
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

async function body(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const size = Number(req.headers["content-length"]);
  if (!positiveInt(size) || size > limit || req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new InvalidRequest();
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > limit) throw new InvalidRequest();
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new InvalidRequest(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidRequest();
  return parsed;
}

export function consoleServer({
  database = process.env.LOOM_DB || defaultDb,
  oauth = new OAuth(),
  temporalDb = process.env.LOOM_TEMPORAL_CONSOLE_DB,
} = {}) {
  const publicHost = new URL(oauth.origin).host;
  return createServer(async (req, res) => {
    function send(status: number, data: string | Buffer, type: string) {
      res.writeHead(status, { ...headers, "Content-Type": type, "Content-Length": Buffer.byteLength(data) });
      res.end(req.method === "HEAD" ? undefined : data);
    }
    function json(status: number, data: unknown) { send(status, JSON.stringify(data), "application/json; charset=utf-8"); }
    function fail(status: number, code: string) { json(status, { status: code }); }
    function redirect(url: string, cookies: string[]) {
      res.writeHead(303, { ...headers, Location: url, "Set-Cookie": cookies }).end();
    }
    const host = req.headers.host || "";
    const local = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host);
    const origin = local ? `http://${host}` : oauth.origin;
    if (!local && host !== publicHost) return fail(403, "invalid_host");
    const user = oauth.user(req.headers.cookie);
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return fail(400, "invalid_request");
    const url = new URL(req.url, origin);
    const path = url.pathname.replace(/^\/console(?=\/|$)/, "").replace(/\/$/, "") || "/";
    const get = req.method === "GET" || req.method === "HEAD";
    try {
      if (get && path === "/oauth/login" && !local && oauth.enabled && req.method === "GET") {
        const login = oauth.begin();
        return redirect(login.url, login.cookies);
      }
      if (get && path === "/oauth/callback" && !local && oauth.enabled && req.method === "GET") {
        let cookies: string[];
        try { cookies = await oauth.finish(url.searchParams.get("state"), url.searchParams.get("code"), req.headers.cookie); }
        catch (error) {
          if (error instanceof OAuthError) return fail(error.status, error.message);
          return fail(400, "github_login_failed");
        }
        return redirect("/console/", cookies);
      }
      if (get && path === "/api/session") return json(200, { enabled: oauth.enabled, user: user ?? null });
      if (path.startsWith("/api/")) {
        if (!user && (!local || path.startsWith("/api/workers"))) return fail(401, "login_required");
        if (get && path === "/api/snapshot") return json(200, withDb(database, true, snapshot));
        if (get && path === "/api/capabilities") return json(200, await capabilities());
        if (get && path === "/api/audit") return json(200, withDb(database, true, audit));
        if (get && path === "/api/temporal/activities") return json(200, temporalActivities(temporalDb));
        const id = /^\/api\/executions\/([1-9]\d{0,14})$/.exec(path);
        if (get && id) {
          const result = withDb(database, true, db => timeline(db, Number(id[1])));
          return result ? json(200, result) : fail(404, "not_found");
        }
        if (get && path === "/api/workers") return json(200, withDb(database, true, db => workers(db, user!.id)));
      }
      if (req.method === "POST" && ["/api/run", "/api/workers", "/api/workers/state", "/oauth/logout"].includes(path)) {
        if (req.headers.origin !== origin) return fail(403, "invalid_origin");
        if (path === "/oauth/logout") return redirect("/console/", [oauth.logout(req.headers.cookie)]);
        const input = await body(req, path === "/api/run" ? 128 : 4096);
        if (path === "/api/run") {
          if (!user) return fail(401, "login_required");
          if (!positiveInt(input.issue)) throw new InvalidRequest();
          const issue = input.issue;
          return withDb(database, false, db => queueRun(db, issue))
            ? fail(202, "queued") : fail(409, "not_runnable");
        }
        if (path === "/api/workers") {
          const config = await validateWorker(input);
          return json(201, withDb(database, false, db => createWorker(db, user!.id, config)));
        }
        const result = withDb(database, false, db => setWorkerState(db, user!.id, input.id, input.state));
        return result ? json(200, result) : fail(404, "not_found");
      }
      if (get && (fallbackRoutes.has(path) || /^\/executions\/[1-9]\d{0,14}$/.test(path))) {
        return send(200, await readFile(join(staticRoot, "index.html")), "text/html; charset=utf-8");
      }
      if (get && /^\/assets\/[\w.-]+\.(?:js|css)$/.test(path)) {
        const content = await readFile(join(staticRoot, path.slice(1))).catch(() => undefined);
        if (content) return send(200, content, path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
      }
      fail(404, "not_found");
    } catch (error) {
      if (error instanceof InvalidRequest) return fail(400, "invalid_request");
      if (error instanceof ModelUnavailable) return fail(400, "model_not_available");
      if (error instanceof ModelCatalogUnavailable) return fail(503, "model_catalog_unavailable");
      console.error("Console request failed", error instanceof Error ? error.name : "unknown");
      fail(503, "unavailable");
    }
  });
}
