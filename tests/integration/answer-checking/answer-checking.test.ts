import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_V1 } from "../../../packages/contracts/src/index.js";
import { MASTERY_V2 } from "../../../packages/learning/src/index.js";
import { appendAssessmentRevision } from "../../../apps/server/src/domain/attempts/assessments.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { readRun, runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import type { CallStats, ChatClient, ChatResult } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V3 } from "../../../apps/server/src/domain/ai/config.js";
import { AnalysisJobRunner } from "../../../apps/server/src/domain/ai/analysisRunner.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { summarize } from "../../../apps/server/src/domain/sessions/finish.js";
import { reviewStatus, unresolvedAttempts } from "../../../apps/server/src/domain/sessions/reviewQueue.js";
import { agentTask } from "../../../apps/server/src/domain/tutor/agentExport.js";
import { getJob } from "../../../apps/server/src/queue/jobs.js";
import { jobsOutbox } from "../../../apps/server/src/queue/outbox.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { fixture } from "../../fixtures/exercises/load.js";
import { FakeClock, FakeGpu, flush } from "../../fixtures/queue/fakes.js";
import { TARGET, makeEnv, makeRevision, makeSession, makeSlot, addEvent, one, rows, type Env } from "../attempts/fixtures.js";

const FX_SKILL = fixture("guided_short_answer").target_skill;
const COHORT = { criterionVersion: "rubric-v1", difficulty: "B2" as const };
const AS_OF = "2030-01-01T00:00:00.000Z";
const stats: CallStats = { totalMs: 10, loadMs: null, promptTokens: 5, evalTokens: 5, evalMs: 5 };
const reply = (o: Record<string, unknown>) => (attemptId: string) =>
  JSON.stringify({ schema_version: "analysis-v2", attempt_id: attemptId, judgement: "acceptable", reason_code: "grammatical", missing_context: null, findings: [], explanation_ru: "Всё верно.", ...o });

class ScriptedChat implements ChatClient {
  attemptId = "";
  constructor(public step: (attemptId: string) => string) {}
  async chat(): Promise<ChatResult> {
    return { text: this.step(this.attemptId), stats };
  }
}

interface Rig {
  env: Env;
  clock: FakeClock;
  runner: AnalysisJobRunner;
  sched: GpuScheduler;
  attemptId: string;
  sessionId: string;
  slotId: string;
  jobId: string;
}
const envs: Env[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

async function rig(step: (attemptId: string) => string, answer = "He stopped checking the emails long ago."): Promise<Rig> {
  const env = await makeEnv({ assessor: ClosedFormAssessor });
  envs.push(env);
  const deps = { ...env.deps, outbox: jobsOutbox({ now: env.deps.now, newId: randomUUID }) };
  const rev = makeRevision(env, { type: "guided_short_answer", dimension: "production", content: fixture("guided_short_answer") });
  const sessionId = makeSession(env);
  const slotId = makeSlot(env, sessionId, rev, 0);
  addEvent(env, sessionId, slotId, "reveal");
  const r = recordAttempt(env.db, deps, { slotId, submissionId: "s1", answer, inputMode: "text" });
  const chat = new ScriptedChat(step);
  chat.attemptId = r.body.attemptId;
  const runner = new AnalysisJobRunner({ db: env.db, chat, installedDigest: async () => AI_CONFIG_V3.analysis.digest, runtimeVersion: async () => "test", deps: env.deps, sleep: async () => {} });
  await runner.prepare();
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const sched = new GpuScheduler({ db: env.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "A", config: { admission: "spike", idleUnloadMs: 600_000 } });
  const jobId = one<{ id: string }>(env.db, "SELECT id FROM jobs").id;
  return { env, clock, runner, sched, attemptId: r.body.attemptId, sessionId, slotId, jobId };
}
async function settle(r: Rig): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await r.sched.tick();
    await flush();
    await flush();
    if (["completed", "failed", "cancelled"].includes(getJob(r.env.db, r.jobId)!.state)) return;
    r.clock.advance(500);
  }
  throw new Error("job did not settle");
}
const feedback = (r: Rig) => getFeedback(r.env.db, r.env.deps, r.sessionId, r.slotId);
const v2 = (r: Rig) => {
  const run = runMastery(r.env.db, { asOf: AS_OF, cohort: COHORT, now: r.env.deps.now, config: MASTERY_V2 });
  return { run, skill: readRun(r.env.db, run.id).find((s) => s.skillId === FX_SKILL)?.dimensions.production };
};
const v1 = (r: Rig) => readRun(r.env.db, runMastery(r.env.db, { asOf: AS_OF, cohort: COHORT, now: r.env.deps.now }).id).find((s) => s.skillId === FX_SKILL);

describe("a decided AI verdict is shown at once and counts provisionally (D65)", () => {
  it("correct: 'Correct (checked by AI) - reason', an AI-checked line in the summary, evidence at weight 0.5, confirmed-only mastery unchanged", async () => {
    const r = await rig(reply({}));
    await settle(r);
    const f = feedback(r);
    expect(f).toMatchObject({ state: "pending", verdict: "correct", confirmation: "tentative", aiChecked: true });
    expect(f.unresolved).toBeUndefined();
    expect(f.message).toBe("Correct (checked by AI) — Всё верно.");

    const s = summarize(r.env.db, r.sessionId, "completed");
    expect(s.aiChecked).toEqual({ correct: 1, incorrect: 0 });
    expect(s.counts).toMatchObject({ correct: 0, incorrect: 0, pending: 0 }); // never merged into the confirmed lines
    expect(s.unresolved).toBeUndefined();

    expect(v1(r)).toBeUndefined(); // mastery-v1 reads confirmed evidence only
    const { run, skill } = v2(r);
    expect(run.algorithmId).toBe("mastery-v2");
    expect(skill).toMatchObject({ n: 1, successes: 1, aiCheckedN: 1 });
    expect(skill!.sumW).toBeCloseTo(MASTERY_V2.aiCheckedWeight!, 12);
    expect(skill!.a).toBeCloseTo((1 + 0.5) / (2 + 0.5), 12);
    // the model never became confirmed
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM confirmed_opportunities").n).toBe(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM assessment_revisions WHERE source = 'model' AND confirmation = 'confirmed'").n).toBe(0);
  });

  it("incorrect: 'Incorrect (checked by AI) - reason', shown at once but NOT counted until reviewed, and queued for the agent", async () => {
    const r = await rig(reply({ judgement: "incorrect_candidate", reason_code: "grammar_violation", explanation_ru: "Нужна форма -ing.", findings: [{ skill_id: TARGET, kind: "grammar", start: 3, end: 10, original: "stopped", suggestion: "stop", explanation_ru: "Ошибка.", confidence: 0.8 }] }));
    await settle(r);
    expect(feedback(r)).toMatchObject({ aiChecked: true, verdict: "incorrect", message: "Incorrect (checked by AI) — Нужна форма -ing." });
    expect(summarize(r.env.db, r.sessionId, "completed").aiChecked).toEqual({ correct: 0, incorrect: 1 });
    const { skill } = v2(r);
    expect(skill).toBeUndefined(); // asymmetry (D65): a model "incorrect" never enters progress on its own
    expect(unresolvedAttempts(r.env.db).map((u) => u.attemptId)).toContain(r.attemptId); // it waits for the agent review
  });

  it("a later confirmed revision supersedes the AI verdict and the next run recomputes from the raw events; the old run stays", async () => {
    const r = await rig(reply({}));
    await settle(r);
    const first = v2(r);
    expect(first.skill).toMatchObject({ successes: 1, aiCheckedN: 1 });
    const seq = one<{ s: number }>(r.env.db, "SELECT MAX(sequence) AS s FROM assessment_revisions WHERE attempt_id = ?", r.attemptId).s;
    appendAssessmentRevision(r.env.db, r.env.deps, { attemptId: r.attemptId, expectedSequence: seq, decision: { verdict: "incorrect", confirmation: "confirmed", source: "human", rationale: "Agent review: the answer is wrong." } });
    const second = v2(r);
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.skill).toMatchObject({ n: 1, successes: 0 });
    expect(second.skill!.sumW).toBeCloseTo(1, 12); // confirmed evidence has full weight
    expect("aiCheckedN" in second.skill!).toBe(false);
    expect(readRun(r.env.db, first.run.id).find((s) => s.skillId === FX_SKILL)!.dimensions.production).toMatchObject({ successes: 1, aiCheckedN: 1 }); // the earlier run is history
    // summary now counts it as a confirmed miss
    expect(summarize(r.env.db, r.sessionId, "completed")).toMatchObject({ counts: { incorrect: 1, pending: 0 } });
    expect(v1(r)?.dimensions.production).toMatchObject({ n: 1, successes: 0 });
  });

  it("the model still cannot confirm on its own authority", async () => {
    const r = await rig(reply({}));
    expect(() =>
      appendAssessmentRevision(r.env.db, r.env.deps, { attemptId: r.attemptId, expectedSequence: 1, decision: { verdict: "correct", confirmation: "confirmed", source: "model", rationale: "x" } }),
    ).toThrow(/never be confirmed/i);
  });
});

describe("undecided answers are unresolved and collect in the queue (D65)", () => {
  it("while the AI check is queued the answer is waiting, not unresolved", async () => {
    const r = await rig(reply({}));
    expect(unresolvedAttempts(r.env.db)).toHaveLength(0);
    expect(summarize(r.env.db, r.sessionId, "completed")).toMatchObject({ aiWaiting: 1, counts: { pending: 1 } });
    expect(feedback(r).unresolved).toBeUndefined();
  });

  it("abstain, ambiguous and invalid output are all unresolved, with the plain message, never 'ambiguous'", async () => {
    for (const step of [reply({ judgement: "abstain", reason_code: "insufficient_evidence" }), reply({ judgement: "ambiguous", reason_code: "context_required", missing_context: "Which action?" }), () => "not json at all"]) {
      const r = await rig(step);
      await settle(r);
      const f = feedback(r);
      expect(f).toMatchObject({ state: "pending", unresolved: true });
      expect(f.aiChecked).toBeUndefined();
      expect(f.message).toContain("Could not be checked automatically — it will be reviewed later");
      expect(f.message.toLowerCase()).not.toContain("ambiguous");
      expect(unresolvedAttempts(r.env.db).map((x) => x.attemptId)).toEqual([r.attemptId]);
      const s = summarize(r.env.db, r.sessionId, "completed");
      expect(s).toMatchObject({ unresolved: 1, counts: { pending: 1 } });
      expect(s.aiChecked).toBeUndefined();
      expect(v2(r).skill).toBeUndefined(); // nothing is counted for it
    }
  });

  it("the notice appears only when the queue reaches reviewNoticeThreshold (default 5), and the one task names the sessions", async () => {
    const r = await rig(reply({ judgement: "abstain", reason_code: "insufficient_evidence" }));
    await settle(r);
    r.env.db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), 2, JSON.stringify(DEFAULT_SETTINGS_V1), "2026-10-31T00:00:00.000Z");
    expect(reviewStatus(r.env.db)).toEqual({ unresolved: 1, threshold: 5, notice: false });
    r.env.db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), 3, JSON.stringify({ ...DEFAULT_SETTINGS_V1, reviewNoticeThreshold: 1 }), "2026-10-31T00:00:01.000Z");
    expect(reviewStatus(r.env.db)).toEqual({ unresolved: 1, threshold: 1, notice: true });

    const text = agentTask(r.env.db, "review");
    expect(text).toContain(r.sessionId);
    expect(text).toContain("Answers waiting for a decision: 1");
    expect(text).toContain("NEW approved variant");
    expect(text).toContain("revision + 1");
    expect(text).not.toContain("He stopped checking"); // IDs and commands only, never the learner's answer
    expect(rows(r.env.db, "SELECT 1 FROM assessment_revisions WHERE attempt_id = ?", r.attemptId)).toHaveLength(1); // nothing was written
  });
});
