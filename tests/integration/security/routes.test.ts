// TASK_018 / A16: the local-service guard is checked on EVERY route the source registers (found by scanning, so a new route cannot be forgotten),
// plus injection / traversal inputs on the routes that take ids, queries or files, and the backup API.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { freePort, projectRoot, testConfig } from "../helpers.js";
import { makeEnv, one, type Env } from "../attempts/fixtures.js";

interface Route {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
}
const ZERO = "00000000-0000-4000-8000-000000000000";

function registeredRoutes(): Route[] {
  const src = path.join(projectRoot, "apps", "server", "src");
  const files = [path.join(src, "app.ts"), ...readdirSync(path.join(src, "routes")).map((f) => path.join(src, "routes", f))];
  const out: Route[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/app\.(get|post|patch|put|delete)(?:<[^>]*>)?\(\s*"(\/[^"]*)"/g)) {
      out.push({ method: m[1]!.toUpperCase() as Route["method"], url: m[2]!.replace(/:[A-Za-z]+/g, ZERO) });
    }
  }
  return out;
}

let env: Env;
let app: FastifyInstance;
let host: string;
let csrf: string;
let cookie: string;
let routes: Route[];

beforeAll(async () => {
  env = await makeEnv();
  const port = await freePort();
  host = `127.0.0.1:${port}`;
  app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 7), attempts: { now: () => new Date(env.clock.current), newId: randomUUID } as never });
  const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
  csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
  cookie = String(b.headers["set-cookie"]).split(";")[0]!;
  routes = registeredRoutes().filter((r) => r.url.startsWith("/api/v1/") && r.url !== "/api/v1/session");
});
afterAll(async () => {
  await app?.close();
  env?.cleanup();
});

const call = (method: Route["method"], url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method, url, headers: { host, ...headers }, payload: payload as object });

describe("every registered API route is behind the guard", () => {
  it("finds the routes (a sanity floor so the scan cannot silently find nothing)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(50);
    expect(routes.some((r) => r.method === "POST" && r.url === "/api/v1/tutor")).toBe(true);
    expect(routes.some((r) => r.method === "POST" && r.url === "/api/v1/backups")).toBe(true);
  });

  it("a mutation without the CSRF token is refused (403) on every POST/PATCH/PUT/DELETE route", async () => {
    const mutating = routes.filter((r) => r.method !== "GET");
    expect(mutating.length).toBeGreaterThanOrEqual(25);
    for (const r of mutating) {
      const res = await call(r.method, r.url, { origin: `http://${host}`, cookie }, {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });

  it("a DNS-rebinding Host or a foreign Origin is refused (403) on every route, reads included", async () => {
    for (const r of routes) {
      const evilHost = await app.inject({ method: r.method, url: r.url, headers: { host: "evil.example:80", cookie, "x-csrf-token": csrf }, payload: r.method === "GET" ? undefined : {} });
      expect(evilHost.statusCode, `${r.method} ${r.url} host`).toBe(403);
      const evilOrigin = await call(r.method, r.url, { origin: "https://evil.example", cookie, "x-csrf-token": csrf }, r.method === "GET" ? undefined : {});
      expect(evilOrigin.statusCode, `${r.method} ${r.url} origin`).toBe(403);
    }
  });

  it("a cross-site Fetch Metadata request is refused on every route", async () => {
    for (const r of routes) {
      const res = await call(r.method, r.url, { "sec-fetch-site": "cross-site", cookie, "x-csrf-token": csrf }, r.method === "GET" ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });
});

describe("hostile input never reaches SQL, the filesystem or the shell", () => {
  const ok = { origin: "", cookie: "", "x-csrf-token": "" };
  const headers = () => ({ origin: `http://${host}`, cookie, "x-csrf-token": csrf });
  void ok;

  it("SQL-looking ids and queries are refused or matched as plain text, and no table is touched", async () => {
    const evil = ["'; DROP TABLE attempts; --", "1 OR 1=1", "%27%20OR%20%271%27%3D%271", "x'); DELETE FROM sessions; --"];
    const before = one<{ n: number }>(env.db, "SELECT (SELECT COUNT(*) FROM attempts) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM session_events) AS n").n;
    for (const e of evil) {
      const enc = encodeURIComponent(e);
      for (const url of [`/api/v1/vocabulary?q=${enc}`, `/api/v1/vocabulary/lookup?word=${enc}`, `/api/v1/tutor/threads/${enc}`, `/api/v1/tutor/agent-task?kind=session&id=${enc}`, `/api/v1/content/revisions/${enc}`, `/api/v1/sessions/${enc}`, `/api/v1/jobs?state=${enc}`]) {
        const res = await call("GET", url, headers());
        expect([200, 400, 404, 422], `${url} -> ${res.statusCode}`).toContain(res.statusCode);
      }
    }
    expect(one<{ n: number }>(env.db, "SELECT (SELECT COUNT(*) FROM attempts) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM session_events) AS n").n).toBe(before);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('attempts','sessions','session_events')").n).toBe(3);
  });

  it("export file names are an allowlist: traversal, device names and absolute paths are never opened", async () => {
    for (const [dir, file] of [["..", "x.json"], ["..%2F..", "report.json"], ["a", "..%5C..%5Cwin.ini"], ["CON", "report.json"], ["C%3A", "x"], ["a", "..%2F..%2Fetc%2Fpasswd"]]) {
      const res = await call("GET", `/api/v1/exports/${dir}/${file}`, headers());
      expect([400, 404], `${dir}/${file}`).toContain(res.statusCode);
    }
  });
});

describe("backups over HTTP", () => {
  it("creates a verified manual backup, lists it, and validates a restore without changing anything", async () => {
    const created = await call("POST", "/api/v1/backups", { origin: `http://${host}`, cookie, "x-csrf-token": csrf }, {});
    expect(created.statusCode).toBe(201);
    const b = created.json() as { id: string; verified: boolean; sha256: string };
    expect(b.verified).toBe(true);
    expect(b.id).toMatch(/^manual-\d{8}T\d{6}Z-[0-9a-f]{6}\.sqlite$/);
    const list = (await call("GET", "/api/v1/backups", { origin: `http://${host}`, cookie })).json() as { backups: Array<{ id: string }> };
    expect(list.backups.map((x) => x.id)).toContain(b.id);
    const v = await call("POST", "/api/v1/restore/validate", { origin: `http://${host}`, cookie, "x-csrf-token": csrf }, { backupId: b.id });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ valid: true, backupId: b.id, willMigrateOnStart: false });
    expect(JSON.stringify(v.json())).toContain("npm run restore"); // the restore itself is a maintenance command, not an HTTP call
  });

  it("restore validation refuses paths and unknown ids; there is no HTTP route that restores", async () => {
    const h = { origin: `http://${host}`, cookie, "x-csrf-token": csrf };
    expect((await call("POST", "/api/v1/restore/validate", h, { backupId: "../../db/english-lab.sqlite" })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/restore/validate", h, { backupId: "manual-20261030T010203Z-ab12cd.sqlite" })).statusCode).toBe(404);
    expect((await call("POST", "/api/v1/restore/validate", h, { backupId: "x", extra: 1 })).statusCode).toBe(400);
    for (const url of ["/api/v1/restore", "/api/v1/restore/apply", "/api/v1/backups/restore", "/api/v1/sql", "/api/v1/shell"]) {
      expect((await call("POST", url, h, {})).statusCode, url).toBe(404);
    }
  });
});
