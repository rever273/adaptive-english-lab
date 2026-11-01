import type { FastifyInstance } from "fastify";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CapabilitiesSchema, ErrorEnvelopeSchema, HealthSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot, testConfig } from "../helpers.js";

const PORT = 4318;
let scratch: ReturnType<typeof makeScratchRoot>;
let db: Db;
let app: FastifyInstance;
const onShutdown = vi.fn();
const HOST = `127.0.0.1:${PORT}`;

beforeAll(async () => {
  scratch = makeScratchRoot();
  const config = testConfig(path.join(scratch.root, "data"), PORT);
  db = openDatabase(config.dbPath);
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  app = await buildApp({ config, db, instanceId: "inst-1", startedAt: "2026-01-01T00:00:00.000Z", shutdownToken: "secret-token", onShutdown });
});
afterAll(async () => {
  await app.close();
  db.close();
  scratch.cleanup();
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { host: HOST, ...headers } });

describe("GET /api/v1/health and /capabilities", () => {
  it("returns the contract with actual driver values", async () => {
    const res = await get("/api/v1/health");
    expect(res.statusCode).toBe(200);
    const h = HealthSchema.parse(res.json());
    expect(h.db).toMatchObject({ ready: true, schemaVersion: 21, driver: "better-sqlite3", jsonSupport: true });
    expect(h.db.pragmas).toEqual({ journal_mode: "wal", foreign_keys: 1, busy_timeout: 5000, synchronous: 2 });
    expect(h.instanceId).toBe("inst-1");
    expect(h.node.version).toBe(process.version);
  });

  it("states honestly that AI and STT are not implemented", async () => {
    const c = CapabilitiesSchema.parse((await get("/api/v1/capabilities")).json());
    expect(c.ai).toEqual({ ollama: "not_implemented", model: "not_implemented", modelTag: "gemma4:12b", modelState: "unloaded" });
    expect(c.stt.status).toBe("not_implemented");
    expect(c.versions.schema).toBe(21);
    expect(JSON.stringify(c)).not.toMatch(/token|secret|[A-Z]:\\/i); // no secrets, no paths
  });

  it("counts the open pages of the tab link (npm start reuses an open tab instead of opening another)", async () => {
    expect((await get("/api/v1/ui/clients")).json()).toEqual({ open: 0 });
  });

  it("sets hardening headers and no-store on API responses", async () => {
    const res = await get("/api/v1/health");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("media-src 'self' blob:");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("error envelope", () => {
  it("wraps unknown API routes", async () => {
    const res = await get("/api/v1/nope");
    expect(res.statusCode).toBe(404);
    const env = ErrorEnvelopeSchema.parse(res.json());
    expect(env.error.code).toBe("NOT_FOUND");
    expect(env.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("wraps malformed JSON bodies as 400", async () => {
    const res = await app.inject({ method: "POST", url: "/internal/shutdown", headers: { host: HOST, "content-type": "application/json" }, payload: "{bad" });
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("BAD_REQUEST");
  });
});

describe("local service guard", () => {
  it.each([
    ["https://evil.example", "GET"],
    ["http://evil.example:4318", "GET"],
    ["http://127.0.0.1:9999", "GET"],
    ["null", "GET"],
    ["https://evil.example", "POST"],
  ])("rejects foreign Origin %s on %s", async (origin, method) => {
    const res = await app.inject({ method: method as "GET" | "POST", url: method === "GET" ? "/api/v1/health" : "/internal/shutdown", headers: { host: HOST, origin } });
    expect(res.statusCode).toBe(403);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("accepts the exact same origin (127.0.0.1 and localhost)", async () => {
    expect((await get("/api/v1/health", { origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` } })).statusCode).toBe(200);
  });

  it("rejects DNS-rebinding Host headers", async () => {
    for (const host of ["evil.example", `evil.example:${PORT}`, "127.0.0.1", "0.0.0.0:4318", `[::1]:${PORT}`]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/health", headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("FORBIDDEN_HOST");
    }
  });

  it("rejects cross-site Fetch Metadata", async () => {
    const res = await get("/api/v1/health", { "sec-fetch-site": "cross-site" });
    expect(res.statusCode).toBe(403);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("FORBIDDEN_FETCH_SITE");
  });
});

describe("POST /internal/shutdown", () => {
  it("rejects a wrong or missing token without shutting down", async () => {
    for (const headers of [{}, { "x-shutdown-token": "wrong" }, { "x-shutdown-token": "secret-tokeX" }]) {
      const res = await app.inject({ method: "POST", url: "/internal/shutdown", headers: { host: HOST, ...headers } });
      expect(res.statusCode).toBe(403);
    }
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it("accepts the right token with 202 and then signals shutdown once", async () => {
    const res = await app.inject({ method: "POST", url: "/internal/shutdown", headers: { host: HOST, "x-shutdown-token": "secret-token" } });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
  });
});
