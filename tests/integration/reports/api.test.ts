import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { freePort, testConfig } from "../helpers.js";
import { addEvent, makeEnv, makeRevision, makeSession, makeSlot, type Env } from "../attempts/fixtures.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { NullOutbox } from "../../../apps/server/src/domain/attempts/ports.js";
import { randomUUID } from "node:crypto";

let env: Env | null = null;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});

async function boot() {
  env = await makeEnv({ assessor: ClosedFormAssessor });
  const rev = makeRevision(env, { type: "choose_form", dimension: "recognition" });
  const sid = makeSession(env);
  const slot = makeSlot(env, sid, rev, 0);
  addEvent(env, sid, slot, "reveal");
  recordAttempt(env.db, { ...env.deps, assessor: ClosedFormAssessor, outbox: NullOutbox }, { slotId: slot, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
  const port = await freePort();
  app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: { now: () => new Date(env!.clock.current.getTime() + 3600_000), newId: randomUUID } as never });
  const host = `127.0.0.1:${port}`;
  const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
  const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
  const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
  return {
    get: (u: string) => app!.inject({ method: "GET", url: u, headers: { host } }),
    post: (u: string, body: unknown, csrfOk = true) => app!.inject({ method: "POST", url: u, payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": csrfOk ? csrf : "" } }),
  };
}

describe("reports API", () => {
  it("returns a saved report with its run identity, replays it by id, and lists the findings and discovery audit separately", async () => {
    const api = await boot();
    const r = (await api.get("/api/v1/analytics/report")).json() as { id: string; inputHash: string; reused: boolean; report: { metrics: { firstAttemptAccuracy: { numerator: number; denominator: number } }; cohort: { protocol: string } } };
    expect(r.report.metrics.firstAttemptAccuracy).toMatchObject({ numerator: 1, denominator: 1 });
    expect(r.report.cohort.protocol).toBe("practice");
    expect(r.reused).toBe(false);
    expect(((await api.get("/api/v1/analytics/report")).json() as { id: string; reused: boolean })).toMatchObject({ id: r.id, reused: true });
    expect(((await api.get(`/api/v1/analytics/report?reportId=${r.id}`)).json() as { inputHash: string }).inputHash).toBe(r.inputHash);
    expect(((await api.get("/api/v1/analytics/reports")).json() as { reports: unknown[] }).reports).toHaveLength(1);
    const f = (await api.get("/api/v1/analytics/findings")).json() as { findings: unknown[]; discovery: { disabledReason: string } };
    expect(f.discovery.disabledReason).toBe("Disabled: model not qualified");
    expect(Array.isArray(f.findings)).toBe(true);
    expect((await api.get("/api/v1/analytics/report?difficulty=Z9")).statusCode).toBe(400);
    expect((await api.get("/api/v1/analytics/report?timezone=Mars/Base")).statusCode).toBe(422);
    expect((await api.get("/api/v1/analytics/report?reportId=nope")).statusCode).toBe(404);
  });

  it("exports to the data root with generated names, downloads only allowlisted files, and refuses traversal", async () => {
    const api = await boot();
    expect((await api.post("/api/v1/exports", {}, false)).statusCode).toBe(403);
    const res = await api.post("/api/v1/exports", {});
    expect(res.statusCode).toBe(201);
    const out = res.json() as { dir: string; files: Array<{ name: string; bytes: number }> };
    expect(out.files).toHaveLength(7);
    const dl = await api.get(`/api/v1/exports/${out.dir}/summary.csv`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("text/csv");
    expect(dl.headers["content-disposition"]).toContain("attachment");
    expect(dl.body).toContain("first_attempt_accuracy_unaided");
    for (const bad of [`/api/v1/exports/..%2F..%2Fdb/summary.csv`, `/api/v1/exports/${out.dir}/..%2Fsecret.csv`, `/api/v1/exports/${out.dir}/notes.txt`, `/api/v1/exports/report-2026-01-01-00000000/summary.csv`]) {
      const x = await api.get(bad);
      expect(x.statusCode, bad).toBe(404);
      expect(ErrorEnvelopeSchema.safeParse(x.json()).success).toBe(true);
    }
    expect((await api.post("/api/v1/exports", { format: "pdf" })).statusCode).toBe(400);
  });
});
