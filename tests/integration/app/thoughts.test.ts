// TASK_026 stage 1: saving the learner's own Russian thoughts. Migration 024 adds tables only; nothing else changes.
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

describe("personal thoughts over HTTP", () => {
  it("saves a Russian thought once, ignores a duplicate, rejects empty/non-Russian text and keeps analyses append-only", async () => {
    env = await makeEnv();
    const port = await freePort();
    app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 1), attempts: { newId: randomUUID } } as never);
    const host = `127.0.0.1:${port}`;
    const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
    const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
    const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
    const post = (text: unknown) => app!.inject({ method: "POST", url: "/api/v1/thoughts", payload: { text } as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": csrf } });

    const first = await post("Вот было бы здорово завтра пойти покататься на коньках.");
    expect(first.statusCode).toBe(201);
    expect(first.json().thought).toMatchObject({ status: "pending", englishDraft: null });
    const again = await post("  вот было бы здорово завтра пойти покататься на коньках  ");
    expect(again.statusCode).toBe(200);
    expect(again.json().thought.id).toBe(first.json().thought.id);
    expect((await post("   ")).statusCode).toBe(422);
    expect((await post("Let's go skating tomorrow")).json().error.code).toBe("THOUGHT_NOT_RUSSIAN");
    expect((await post("я".repeat(501))).json().error.code).toBe("THOUGHT_TOO_LONG");

    const list = await app.inject({ method: "GET", url: "/api/v1/thoughts", headers: { host } });
    expect(list.json().thoughts).toHaveLength(1);
    expect(rows(env.db, "SELECT COUNT(*) AS n FROM thought_analyses")[0]).toMatchObject({ n: 1 });
    // exercises, revisions and attempts are untouched
    expect(rows(env.db, "SELECT COUNT(*) AS n FROM exercise_revisions")[0]).toMatchObject({ n: 0 });
  });
});
