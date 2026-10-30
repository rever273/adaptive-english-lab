// docs/04 §7: settings over HTTP. A change appends a settings revision (history is never rewritten), is validated, and needs CSRF.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { freePort, testConfig } from "../helpers.js";
import { makeEnv, rows, type Env } from "../attempts/fixtures.js";

let env: Env | null = null;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});

describe("settings over HTTP", () => {
  it("appends a validated revision per change, keeps earlier revisions and other keys, and refuses requests without CSRF", async () => {
    env = await makeEnv();
    const port = await freePort();
    app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: { now: () => new Date(env!.clock.current), newId: randomUUID } as never });
    const host = `127.0.0.1:${port}`;
    const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
    const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
    const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
    const call = (method: "POST" | "GET", body?: unknown, ok = true) => app!.inject({ method, url: "/api/v1/settings", payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": ok ? csrf : "" } });

    const first = (await call("GET")).json();
    expect(first.revision).toBe(1);
    expect(first.values).toMatchObject({ taskCount: 18, weakRatio: 0.65, voiceTarget: 2 });

    const saved = await call("POST", { taskCount: 12, voiceTarget: 1 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe(2);
    expect(saved.json().values).toMatchObject({ taskCount: 12, weakRatio: 0.65, voiceTarget: 1, difficulty: "adaptive", explanation: "compact" });

    expect((await call("POST", { taskCount: 12, voiceTarget: 1 })).json().revision).toBe(2); // no change, no new revision
    for (const bad of [{ taskCount: 4 }, { taskCount: 31 }, { weakRatio: 1.5 }, { voiceTarget: 3 }, { difficulty: "C2" }]) expect((await call("POST", bad)).statusCode).toBe(400);
    expect((await call("POST", { taskCount: 10 }, false)).statusCode).toBe(403);

    const revs = rows<{ revision: number; v: string }>(env.db, "SELECT revision, values_json AS v FROM settings_revisions ORDER BY revision");
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
    expect(JSON.parse(revs[0]!.v).taskCount).toBe(18); // the first revision is untouched
  });
});
