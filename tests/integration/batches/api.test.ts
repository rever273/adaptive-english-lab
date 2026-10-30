import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { getBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { planRelease } from "../../../apps/server/src/domain/content/repository.js";
import { freePort, testConfig } from "../helpers.js";
import { batchJobsSettled, batchRevisions, closeRigs, drive, makeRig, manifest, type Rig } from "./fixtures.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  closeRigs();
});

async function boot(): Promise<{ r: Rig; get: (u: string) => ReturnType<FastifyInstance["inject"]>; post: (u: string, body: unknown, h?: Record<string, string>) => ReturnType<FastifyInstance["inject"]> }> {
  const r = await makeRig();
  const port = await freePort();
  app = await buildApp({ config: testConfig(r.env.scratch.root, port), db: r.env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: r.deps, scheduler: r.sched });
  const boot = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: `127.0.0.1:${port}` } });
  const csrf = SessionBootstrapSchema.parse(boot.json()).csrfToken;
  const cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
  const host = `127.0.0.1:${port}`;
  return {
    r,
    get: (u) => app!.inject({ method: "GET", url: u, headers: { host } }),
    post: (u, body, h = {}) => app!.inject({ method: "POST", url: u, payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": csrf, ...h } }),
  };
}

describe("content batch API", () => {
  it("POST /content/batches returns 202 with real counts, is CSRF-protected and validates its body", async () => {
    const { r, get, post } = await boot();
    expect((await post("/api/v1/content/batches", { count: 24, mode: "balanced", trial: true }, { "x-csrf-token": "" })).statusCode).toBe(403);
    for (const bad of [{ count: 0, mode: "balanced" }, { count: 501, mode: "balanced" }, { count: 5, mode: "auto" }, { count: 24, mode: "balanced", trial: true, extra: 1 }, {}]) {
      expect((await post("/api/v1/content/batches", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const res = await post("/api/v1/content/batches", { count: 24, mode: "balanced", trial: true });
    expect(res.statusCode).toBe(202);
    const created = res.json() as { batchId: string; items: number; units: number };
    expect(created).toMatchObject({ items: 24, units: 14 });

    const view = (await get(`/api/v1/content/batches/${created.batchId}`)).json() as { counts: Record<string, number>; requestedCount: number; generationDone: boolean; trialGate: { passed: boolean } };
    expect(view).toMatchObject({ requestedCount: 24, generationDone: false, trialGate: { passed: false } });
    // the creating call kicked the dispatcher, so a first unit may already be done: the counts are real rows and always sum to the request
    expect(Object.values(view.counts).reduce((a, n) => a + n, 0)).toBe(24);

    // the larger batch is refused with a precise reason until the trial is reviewed
    const early = await post("/api/v1/content/batches", { count: 50, mode: "balanced" });
    expect(early.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(early.json()).error.code).toBe("TRIAL_REQUIRED");
    expect((await get(`/api/v1/content/batches/not-a-batch`)).statusCode).toBe(404);

    await drive(r, () => batchJobsSettled(r, created.batchId));
    const done = (await get(`/api/v1/content/batches/${created.batchId}`)).json() as { counts: Record<string, number>; generationDone: boolean };
    expect(done).toMatchObject({ generationDone: true });
    expect(done.counts.ready_for_review).toBe(24);
    expect(((await get("/api/v1/content/batches")).json() as { batches: unknown[] }).batches).toHaveLength(1);
  });

  it("review-import, release preview and release run end-to-end over HTTP; stale input answers 409", async () => {
    const { r, get, post } = await boot();
    const { batchId } = (await post("/api/v1/content/batches", { count: 24, mode: "balanced", trial: true })).json() as { batchId: string };
    await drive(r, () => batchJobsSettled(r, batchId));
    const revs = batchRevisions(r, batchId);

    const stale = manifest(revs.slice(0, 3).map((rev) => ({ rev, verdict: "approved" as const })));
    stale.items[1]!.content_hash = "a".repeat(64);
    const refused = await post(`/api/v1/content/batches/${batchId}/review-import`, stale);
    expect(refused.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(refused.json()).error.code).toBe("REVIEW_IMPORT_REFUSED");
    expect(getBatch(r.env.db, batchId).reviewedItems).toBe(0);

    const ok = await post(`/api/v1/content/batches/${batchId}/review-import`, manifest(revs.slice(0, 6).map((rev) => ({ rev, verdict: "approved" as const }))));
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ recorded: 6, approved: 6 });

    const ids = revs.slice(0, 4).map((x) => x.revisionId);
    const preview = (await post("/api/v1/content/releases/preview", { revisionIds: ids })).json() as { manifestHash: string; items: unknown[] };
    expect(preview.items).toHaveLength(4);
    expect(preview.manifestHash).toBe(planRelease(r.env.db, ids).manifestHash);

    const wrong = await post("/api/v1/content/releases", { revisionIds: ids, reviewer: "agent:test-reviewer@1", manifestHash: "b".repeat(64) });
    expect(wrong.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(wrong.json()).error.code).toBe("MANIFEST_MISMATCH");

    const rel = await post("/api/v1/content/releases", { revisionIds: ids, reviewer: "agent:test-reviewer@1", manifestHash: preview.manifestHash });
    expect(rel.statusCode).toBe(201);
    expect(rel.json()).toMatchObject({ released: 4, replayed: false });
    expect((await post("/api/v1/content/releases", { revisionIds: ids, reviewer: "agent:test-reviewer@1", manifestHash: preview.manifestHash })).statusCode).toBe(200);

    const unapproved = revs.slice(10, 12).map((x) => x.revisionId);
    expect((await post("/api/v1/content/releases", { revisionIds: unapproved, reviewer: "agent:test-reviewer@1", manifestHash: "c".repeat(64) })).statusCode).toBe(422);

    const cov = (await get("/api/v1/content/coverage")).json() as { totals: { releasedExercises: number }; targetPerSkill: number };
    expect(cov.totals.releasedExercises).toBe(4);
    expect(cov.targetPerSkill).toBe(12);
    const b = (await get(`/api/v1/content/batches/${batchId}`)).json() as { counts: Record<string, number> };
    expect(b.counts).toMatchObject({ released: 4, approved: 2, ready_for_review: 18 });
  });
});
