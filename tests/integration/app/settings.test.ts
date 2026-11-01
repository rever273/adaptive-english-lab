// docs/04 §7: settings over HTTP. A change appends a settings revision (history is never rewritten), is validated, and needs CSRF.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBootstrapSchema, difficultyLevels, reviewNoticeThreshold, vocabularyNewWordsPerSession, vocabularyTaskCount } from "../../../packages/contracts/src/index.js";
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
    expect(first.revision).toBe(2);
    expect(first.values).toMatchObject({ taskCount: 18, weakRatio: 0.65, voiceTarget: 2 });
    expect(vocabularyTaskCount(first.values)).toBe(8);

    const saved = await call("POST", { taskCount: 12, voiceTarget: 1 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe(3);
    expect(saved.json().values).toMatchObject({ taskCount: 12, weakRatio: 0.65, voiceTarget: 1, difficulty: "adaptive", explanation: "compact" });

    expect((await call("POST", { taskCount: 12, voiceTarget: 1 })).json().revision).toBe(3); // no change, no new revision
    for (const bad of [{ taskCount: 4 }, { taskCount: 31 }, { weakRatio: 1.5 }, { voiceTarget: 3 }, { difficulty: "C2" }]) expect((await call("POST", bad)).statusCode).toBe(400);
    expect((await call("POST", { taskCount: 10 }, false)).statusCode).toBe(403);

    const revs = rows<{ revision: number; v: string }>(env.db, "SELECT revision, values_json AS v FROM settings_revisions ORDER BY revision");
    expect(revs.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(JSON.parse(revs[0]!.v).taskCount).toBe(18); // the first revision is untouched
    expect(JSON.parse(revs[0]!.v).vocabularyTaskCount).toBeUndefined();
    expect((await call("POST", { vocabularyTaskCount: 4 })).statusCode).toBe(400);
    expect((await call("POST", { vocabularyTaskCount: 11 })).statusCode).toBe(400);
    const vocabularySaved = await call("POST", { vocabularyTaskCount: 5 });
    expect(vocabularySaved.statusCode).toBe(200);
    expect(vocabularySaved.json().values.vocabularyTaskCount).toBe(5);
    expect((await call("POST", { vocabularyTaskCount: 10 })).json().values.vocabularyTaskCount).toBe(10);
    // TASK_020: new words per vocabulary session, optional, 1..10, default 4; older revisions do not have it
    expect(vocabularyNewWordsPerSession(first.values)).toBe(4);
    expect(JSON.parse(revs[0]!.v).vocabularyNewWordsPerSession).toBeUndefined();
    expect((await call("POST", { vocabularyNewWordsPerSession: 0 })).statusCode).toBe(400);
    expect((await call("POST", { vocabularyNewWordsPerSession: 11 })).statusCode).toBe(400);
    const newWords = await call("POST", { vocabularyNewWordsPerSession: 2 });
    expect(newWords.statusCode).toBe(200);
    expect(newWords.json().values.vocabularyNewWordsPerSession).toBe(2);
    expect(vocabularyNewWordsPerSession((await call("GET")).json().values)).toBe(2);

    // TASK_022: review notice threshold, optional, 1..50, default 5
    expect(reviewNoticeThreshold(first.values)).toBe(5);
    expect(JSON.parse(revs[0]!.v).reviewNoticeThreshold).toBeUndefined();
    expect((await call("POST", { reviewNoticeThreshold: 0 })).statusCode).toBe(400);
    expect((await call("POST", { reviewNoticeThreshold: 51 })).statusCode).toBe(400);
    expect(reviewNoticeThreshold((await call("POST", { reviewNoticeThreshold: 3 })).json().values)).toBe(3);

    // TASK_021: optional target difficulty range; absent (older revisions) means no restriction
    expect(difficultyLevels(first.values)).toEqual(["B1", "B2", "C1"]);
    expect(JSON.parse(revs[0]!.v).difficultyMin).toBeUndefined();
    expect((await call("POST", { difficultyMax: "C2" })).statusCode).toBe(200);
    expect(difficultyLevels((await call("GET")).json().values)).toEqual(["B1", "B2", "C1", "C2"]);
    expect((await call("POST", { difficultyMin: "C3" })).statusCode).toBe(400);
    const range = await call("POST", { difficultyMin: "B2", difficultyMax: "C1" });
    expect(range.statusCode).toBe(200);
    expect(difficultyLevels(range.json().values)).toEqual(["B2", "C1"]);
    expect(difficultyLevels((await call("GET")).json().values)).toEqual(["B2", "C1"]);
  });
});
