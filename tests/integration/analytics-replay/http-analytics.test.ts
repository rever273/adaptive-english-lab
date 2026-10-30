import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SkillAnalyticsResponseSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { TARGET, exactSetAssessor, makeEnv, revealedSlot, testConfigFor, type Env } from "../attempts/fixtures.js";

const PORT = 4318;
const HOST = `127.0.0.1:${PORT}`;
let env: Env;
let app: FastifyInstance;

beforeAll(async () => {
  env = await makeEnv({ assessor: exactSetAssessor() });
  app = await buildApp({
    config: testConfigFor(env, PORT),
    db: env.db,
    instanceId: "i",
    startedAt: "2026-01-01T00:00:00Z",
    shutdownToken: "t",
    onShutdown: () => {},
    attempts: { assessor: exactSetAssessor(), now: env.deps.now, newId: randomUUID },
  });
  for (let i = 0; i < 5; i++) {
    const { slotId } = revealedSlot(env);
    recordAttempt(env.db, env.deps, { slotId, submissionId: randomUUID(), answer: [i === 0 ? "b" : "a"], inputMode: "text" });
  }
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

const get = (qs: string) => app.inject({ method: "GET", url: `/api/v1/analytics/skills?${qs}`, headers: { host: HOST } });

describe("GET /api/v1/analytics/skills", () => {
  it("returns values with their denominators and the saved run; a repeat reuses the run", async () => {
    const q = "criterionVersion=rubric-v1&difficulty=B2";
    const first = await get(q);
    expect(first.statusCode).toBe(200);
    const a = SkillAnalyticsResponseSchema.parse(first.json());
    const skill = a.skills.find((s) => s.skillId === TARGET)!;
    expect(skill.dimensions.recognition).toMatchObject({ n: 5, successes: 4, status: "insufficient" });
    expect(skill.dimensions.recognition!.score).toBeCloseTo(10 * (0.7 * (1 + 4) / (2 + 5) + 0.3 * (1 + 4) / (2 + 5)), 12);
    expect(skill.dimensions.recognition!.display).toBe(Math.round((skill.dimensions.recognition!.score as number) * 10) / 10);
    expect(skill.summary).toMatchObject({ score: null, reason: "insufficient_dimensions" });
    expect(a.run).toMatchObject({ algorithmId: "mastery-v1", reused: false, cohort: { criterionVersion: "rubric-v1", difficulty: "B2" } });

    const again = SkillAnalyticsResponseSchema.parse((await get(q)).json());
    expect(again.run).toMatchObject({ id: a.run.id, inputHash: a.run.inputHash, reused: true });
    expect(again.skills).toEqual(a.skills);
  });

  it("returns an empty skill list for a cohort without evidence (unknown, not zero)", async () => {
    const r = SkillAnalyticsResponseSchema.parse((await get("criterionVersion=rubric-v1&difficulty=C1")).json());
    expect(r.skills).toEqual([]);
  });

  it.each([["missing cohort", ""], ["bad difficulty", "criterionVersion=r&difficulty=Z9"], ["bad asOf", "criterionVersion=r&difficulty=B2&asOf=yesterday"], ["unknown param", "criterionVersion=r&difficulty=B2&x=1"]])("rejects %s with the error envelope", async (_n, qs) => {
    const res = await get(qs);
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("does not write or change any raw event", async () => {
    const count = (t: string) => (env.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = ["attempts", "assessment_revisions", "skill_opportunities", "session_events"].map(count);
    await get("criterionVersion=rubric-v1&difficulty=B2&asOf=2026-10-28T03:00:00.000Z");
    expect(["attempts", "assessment_revisions", "skill_opportunities", "session_events"].map(count)).toEqual(before);
  });
});
