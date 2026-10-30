import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MASTERY_V1, type MasteryComponents } from "../../../packages/learning/src/index.js";
import { appendAssessmentRevision } from "../../../apps/server/src/domain/attempts/assessments.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { currentWatermark } from "../../../apps/server/src/domain/analytics/evidence.js";
import { readRun, runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { SKILL_B, TARGET, advance, exactSetAssessor, makeEnv, one, revealedSlot, rows, type Env, type ExerciseOptions } from "../attempts/fixtures.js";

const COHORT = { criterionVersion: "rubric-v1", difficulty: "B2" as const };
let env: Env;
beforeEach(async () => {
  env = await makeEnv({ assessor: exactSetAssessor() });
});
afterEach(() => env.cleanup());

const asOf = () => env.deps.now().toISOString();
/** Records one unaided first attempt on a fresh revealed slot. `ok` picks the correct option set. */
function answer(ok: boolean, o: ExerciseOptions & { purpose?: "practice" | "diagnostic" | "heldout"; idk?: boolean } = {}) {
  const { sessionId, slotId } = revealedSlot(env, { ...o, bankRole: o.purpose === "heldout" ? "heldout" : o.bankRole });
  const r = recordAttempt(env.db, env.deps, { slotId, submissionId: randomUUID(), inputMode: "text", ...(o.idk ? { idk: true } : { answer: [ok ? "a" : "b"] }) });
  return { sessionId, slotId, attemptId: r.body.attemptId, assessmentId: r.body.assessment.id };
}
const skill = (runId: string, skillId = TARGET, dim = "recognition") =>
  JSON.parse(one<{ components_json: string }>(env.db, "SELECT components_json FROM mastery_snapshots WHERE run_id = ? AND skill_id = ? AND dimension = ?", runId, skillId, dim).components_json) as MasteryComponents;
const snapshotBytes = (runId: string, skillId = TARGET) => JSON.stringify(rows(env.db, "SELECT skill_id, dimension, score, n, days, confidence_status, components_json FROM mastery_snapshots WHERE run_id = ? AND skill_id = ? ORDER BY dimension", runId, skillId));

/** spec/04 row 3: 8 correct, 2 incorrect, 2 IDK, held-out 3/4 (held-out are part of the 12). */
function buildRow3() {
  const wrongPractice: ReturnType<typeof answer>[] = [];
  for (let i = 0; i < 5; i++) answer(true);
  wrongPractice.push(answer(false));
  answer(false, { idk: true });
  answer(false, { idk: true });
  for (let i = 0; i < 3; i++) answer(true, { purpose: "heldout" });
  answer(false, { purpose: "heldout" });
  return wrongPractice;
}

describe("replaying spec/04 on real stored attempts", () => {
  it("row 3 gives A = 9/14, H = 4/6, S = 6.5 from raw events", () => {
    buildRow3();
    const run = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    const c = skill(run.id);
    expect(Math.abs((c.a as number) - 9 / 14)).toBeLessThan(1e-9);
    expect(Math.abs((c.h as number) - 4 / 6)).toBeLessThan(1e-9);
    expect(Math.abs((c.score as number) - 6.5)).toBeLessThan(1e-9);
    expect(c).toMatchObject({ n: 12, heldoutN: 4, successes: 8, status: "insufficient" });
    expect(one(env.db, "SELECT n, days, confidence_status FROM mastery_snapshots WHERE run_id = ?", run.id)).toEqual({ n: 12, days: 1, confidence_status: "insufficient" });
  });

  it("hints, retries, skips, pending answers and extra slots add nothing to the score inputs", () => {
    buildRow3();
    const before = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    for (let i = 0; i < 5; i++) {
      const { sessionId, slotId } = revealedSlot(env);
      recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "skip", clientEventId: randomUUID() });
    }
    for (let i = 0; i < 6; i++) {
      // hint first, then answer: an assisted first attempt (kept in history, not unaided evidence), then a retry
      const { sessionId, slotId } = revealedSlot(env);
      recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "hint", clientEventId: randomUUID() });
      recordAttempt(env.db, env.deps, { slotId, submissionId: randomUUID(), answer: ["b"], inputMode: "text" });
      recordAttempt(env.db, env.deps, { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
    }
    // voluntary retries of the already-counted failed first attempts: the first attempt stays the evidence
    for (const row of rows<{ slot_id: string; session_id: string }>(env.db, "SELECT t.slot_id, ss.session_id FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id JOIN sessions se ON se.id = ss.session_id AND se.purpose = 'practice' JOIN assessment_revisions a ON a.attempt_id = t.id WHERE a.verdict = 'incorrect' AND t.attempt_no = 1 AND t.hints_before = 0")) {
      recordSessionEvent(env.db, env.deps, row.session_id, { slotId: row.slot_id, type: "hint", clientEventId: randomUUID() });
      recordAttempt(env.db, env.deps, { slotId: row.slot_id, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
    }
    for (let i = 0; i < 3; i++) {
      const { sessionId, slotId } = revealedSlot(env);
      recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "reveal_answer", clientEventId: randomUUID() });
      recordAttempt(env.db, env.deps, { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" }); // answer seen first
    }
    const after = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(after.id).not.toBe(before.id); // the watermark moved, so it is a new run...
    expect(snapshotBytes(after.id)).toBe(snapshotBytes(before.id)); // ...with bitwise identical values for the skill
  });

  it("a confirmed wrong->correct re-assessment gives A = 10/14, S = 7.0 in a new run; the old run stays readable and replayable", () => {
    const wrong = buildRow3()[0]!;
    const oldRun = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(Math.abs((skill(oldRun.id).score as number) - 6.5)).toBeLessThan(1e-9);

    appendAssessmentRevision(env.db, env.deps, {
      attemptId: wrong.attemptId,
      expectedSequence: 1,
      decision: { verdict: "correct", confirmation: "confirmed", source: "human", rationale: "acceptable alternative" },
    });
    const newRun = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    const c = skill(newRun.id);
    expect(Math.abs((c.a as number) - 10 / 14)).toBeLessThan(1e-9);
    expect(Math.abs((c.h as number) - 4 / 6)).toBeLessThan(1e-9);
    expect(Math.abs((c.score as number) - 7)).toBeLessThan(1e-9);
    expect(newRun.id).not.toBe(oldRun.id);

    // the saved run is untouched...
    expect(Math.abs((skill(oldRun.id).score as number) - 6.5)).toBeLessThan(1e-9);
    // ...and recomputing "as it was" (same watermark) reproduces it exactly: same run, same hash
    const replay = runMastery(env.db, { asOf: oldRun.asOf, watermark: oldRun.eventWatermark, cohort: COHORT, now: env.deps.now });
    expect(replay).toMatchObject({ id: oldRun.id, inputHash: oldRun.inputHash, created: false });
  });

  it("is idempotent: the same request reuses the saved run and never rewrites snapshots", () => {
    buildRow3();
    const a = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    const before = snapshotBytes(a.id);
    const b = runMastery(env.db, { asOf: a.asOf, watermark: a.eventWatermark, cohort: COHORT, now: env.deps.now });
    expect(b).toMatchObject({ id: a.id, created: false, inputHash: a.inputHash });
    expect(snapshotBytes(a.id)).toBe(before);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM analytics_runs").n).toBe(1);
  });

  it("a disputed answer leaves the next run (the evidence is removed), the earlier run still shows it", () => {
    const [wrong] = buildRow3();
    const r1 = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    appendAssessmentRevision(env.db, env.deps, { attemptId: wrong!.attemptId, expectedSequence: 1, decision: { verdict: "disputed", confirmation: "disputed", source: "human", rationale: "disputed" } });
    const r2 = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(skill(r1.id).n).toBe(12);
    expect(skill(r2.id).n).toBe(11);
  });
});

describe("invariants", () => {
  it("course size does not move the score: extra bank content and other skills leave the skill bitwise unchanged", () => {
    buildRow3();
    const before = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    for (let i = 0; i < 60; i++) revealedSlot(env); // a bigger bank, never answered
    for (let i = 0; i < 25; i++) answer(i % 2 === 0, { target: SKILL_B });
    const after = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(snapshotBytes(after.id, TARGET)).toBe(snapshotBytes(before.id, TARGET));
    expect(skill(after.id, SKILL_B).n).toBe(25);
  });

  it("keeps cohorts apart: other rubric or difficulty never mixes into the cohort's score", () => {
    for (let i = 0; i < 4; i++) answer(true);
    for (let i = 0; i < 4; i++) answer(false, { difficulty: "C1" });
    for (let i = 0; i < 4; i++) answer(false, { rubricVersion: "rubric-v2" });
    const run = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(skill(run.id)).toMatchObject({ n: 4, successes: 4 });
    const c1 = runMastery(env.db, { asOf: asOf(), cohort: { criterionVersion: "rubric-v1", difficulty: "C1" }, now: env.deps.now });
    expect(skill(c1.id)).toMatchObject({ n: 4, successes: 0 });
    expect(JSON.parse(one<{ cohort_json: string }>(env.db, "SELECT cohort_json FROM analytics_runs WHERE id = ?", c1.id).cohort_json)).toEqual({ criterionVersion: "rubric-v1", difficulty: "C1" });
  });

  it("recognition evidence never creates production evidence and the summary stays null", () => {
    for (let i = 0; i < 14; i++) answer(true);
    const run = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    const p = readRun(env.db, run.id).find((s) => s.skillId === TARGET)!;
    expect(Object.keys(p.dimensions)).toEqual(["recognition"]);
    expect(p.summary).toMatchObject({ score: null, reason: "insufficient_dimensions" });
    expect(p.summary.missing).toEqual(expect.arrayContaining(["correction", "production"]));
  });

  it("only evidence up to as_of counts (time travel) and the score is anchored to its newest evidence", () => {
    answer(true);
    advance(env, 3 * 86_400_000);
    answer(false);
    const early = runMastery(env.db, { asOf: "2026-10-28T12:00:00.000Z", cohort: COHORT, now: env.deps.now });
    const late = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(skill(early.id).n).toBe(1);
    expect(skill(late.id).n).toBe(2);
    expect(skill(late.id).tE).toBe(asOf());
  });

  it("snapshot rows are append-only and a changed formula needs a new algorithm version", () => {
    answer(true);
    const run = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(() => env.db.prepare("UPDATE mastery_snapshots SET score = 10").run()).toThrow(/append-only/);
    expect(() => env.db.prepare("DELETE FROM analytics_runs WHERE id = ?").run(run.id)).toThrow(/append-only/);
    expect(() => env.db.prepare("UPDATE algorithm_versions SET config_json = '{}'").run()).toThrow(/append-only/);
    try {
      runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now, config: { ...MASTERY_V1, window: 39 } });
      throw new Error("expected drift error");
    } catch (e) {
      expect((e as ApiError).code).toBe("ALGORITHM_CONFIG_DRIFT");
    }
    expect(one(env.db, "SELECT id FROM algorithm_versions")).toEqual({ id: "mastery-v1" });
  });

  it("the watermark view of the evidence equals the confirmed_opportunities projection (spec/09)", () => {
    buildRow3();
    const run = runMastery(env.db, { asOf: asOf(), cohort: COHORT, now: env.deps.now });
    expect(currentWatermark(env.db)).toBe(run.eventWatermark);
    const viewN = one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM confirmed_opportunities WHERE dimension = 'recognition'").n;
    expect(skill(run.id).n).toBe(viewN);
  });
});
