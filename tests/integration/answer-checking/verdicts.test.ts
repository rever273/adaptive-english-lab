// D65: the agent's way to settle the review queue - attempt-verdict-review-v1 appends a NEW confirmed assessment; nothing is edited.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MASTERY_V2 } from "../../../packages/learning/src/index.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { readRun, runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import type { CallStats, ChatClient, ChatResult } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V3 } from "../../../apps/server/src/domain/ai/config.js";
import { AnalysisJobRunner } from "../../../apps/server/src/domain/ai/analysisRunner.js";
import { summarize } from "../../../apps/server/src/domain/sessions/finish.js";
import { reviewStatus, unresolvedAttempts } from "../../../apps/server/src/domain/sessions/reviewQueue.js";
import { applyAttemptVerdicts, attemptsForVerdictReview } from "../../../apps/server/src/domain/reports/attemptVerdictReview.js";
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
const ANSWER = "He stopped checking the emails long ago.";
const stats: CallStats = { totalMs: 10, loadMs: null, promptTokens: 5, evalTokens: 5, evalMs: 5 };
const reply = (o: Record<string, unknown>) => (attemptId: string) =>
  JSON.stringify({ schema_version: "analysis-v2", attempt_id: attemptId, judgement: "acceptable", reason_code: "grammatical", missing_context: null, findings: [], explanation_ru: "Всё верно.", ...o });
const INCORRECT = reply({ judgement: "incorrect_candidate", reason_code: "grammar_violation", explanation_ru: "Нужна форма -ing.", findings: [{ skill_id: TARGET, kind: "grammar", start: 3, end: 10, original: "stopped", suggestion: "stop", explanation_ru: "Ошибка.", confidence: 0.8 }] });
const ABSTAIN = reply({ judgement: "abstain", reason_code: "insufficient_evidence" });

class ScriptedChat implements ChatClient {
  attemptId = "";
  constructor(public step: (attemptId: string) => string) {}
  async chat(): Promise<ChatResult> {
    return { text: this.step(this.attemptId), stats };
  }
}
interface Rig {
  env: Env;
  attemptId: string;
  sessionId: string;
}
const envs: Env[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

async function rig(step: (attemptId: string) => string): Promise<Rig> {
  const env = await makeEnv({ assessor: ClosedFormAssessor });
  envs.push(env);
  const deps = { ...env.deps, outbox: jobsOutbox({ now: env.deps.now, newId: randomUUID }) };
  const rev = makeRevision(env, { type: "guided_short_answer", dimension: "production", content: fixture("guided_short_answer") });
  const sessionId = makeSession(env);
  const slotId = makeSlot(env, sessionId, rev, 0);
  addEvent(env, sessionId, slotId, "reveal");
  const r = recordAttempt(env.db, deps, { slotId, submissionId: "s1", answer: ANSWER, inputMode: "text" });
  const chat = new ScriptedChat(step);
  chat.attemptId = r.body.attemptId;
  const runner = new AnalysisJobRunner({ db: env.db, chat, installedDigest: async () => AI_CONFIG_V3.analysis.digest, runtimeVersion: async () => "test", deps: env.deps, sleep: async () => {} });
  await runner.prepare();
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const sched = new GpuScheduler({ db: env.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "A", config: { admission: "spike", idleUnloadMs: 600_000 } });
  const jobId = one<{ id: string }>(env.db, "SELECT id FROM jobs").id;
  for (let i = 0; i < 40; i++) {
    await sched.tick();
    await flush();
    await flush();
    if (["completed", "failed", "cancelled"].includes(getJob(env.db, jobId)!.state)) break;
    clock.advance(500);
  }
  return { env, attemptId: r.body.attemptId, sessionId };
}
const v2 = (r: Rig) => {
  const run = runMastery(r.env.db, { asOf: AS_OF, cohort: COHORT, now: r.env.deps.now, config: MASTERY_V2 });
  return { run, skill: readRun(r.env.db, run.id).find((s) => s.skillId === FX_SKILL)?.dimensions.production };
};
const seq = (r: Rig) => one<{ s: number }>(r.env.db, "SELECT MAX(sequence) AS s FROM assessment_revisions WHERE attempt_id = ?", r.attemptId).s;
const manifest = (r: Rig, over: Record<string, unknown> = {}, version = "pass-1") => ({
  schema_version: "attempt-verdict-review-v1",
  reviewer: "agent:test-reviewer@1",
  review_version: version,
  items: [{ attempt_id: r.attemptId, expected_sequence: seq(r), verdict: "incorrect", rationale: "The form after 'stopped' is wrong here.", ...over }],
});
const apply = (r: Rig, m: unknown) => applyAttemptVerdicts(r.env.db, r.env.deps, m);

describe("attempt-verdict-review-v1 settles the review queue", () => {
  it("confirms a model-incorrect: a NEW human/confirmed revision, the queue shrinks, mastery-v2 recomputes (old run stays), history untouched", async () => {
    const r = await rig(INCORRECT);
    expect(unresolvedAttempts(r.env.db).map((q) => q.attemptId)).toEqual([r.attemptId]);
    const before = v2(r);
    expect(before.skill).toBeUndefined(); // a model-incorrect does not count
    const sequenceBefore = seq(r);
    const res = apply(r, manifest(r));
    expect(res).toMatchObject({ applied: 1, alreadyApplied: 0, byVerdict: { incorrect: 1 } });
    expect(seq(r)).toBe(sequenceBefore + 1);
    const revs = rows<{ sequence: number; source: string; confirmation: string; verdict: string; rationale: string }>(r.env.db, "SELECT sequence, source, confirmation, verdict, rationale FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence", r.attemptId);
    expect(revs.at(-1)).toMatchObject({ source: "human", confirmation: "confirmed", verdict: "incorrect" });
    expect(revs.at(-1)!.rationale).toContain("[pass-1] agent:test-reviewer@1");
    expect(revs.some((x) => x.source === "model" && x.verdict === "incorrect" && x.confirmation === "tentative")).toBe(true); // the AI verdict stays in the history
    expect(unresolvedAttempts(r.env.db)).toHaveLength(0);
    expect(reviewStatus(r.env.db).unresolved).toBe(0);
    const after = v2(r);
    expect(after.run.id).not.toBe(before.run.id);
    expect(after.skill).toMatchObject({ n: 1, successes: 0 });
    expect(after.skill!.sumW).toBeCloseTo(1, 12); // confirmed: full weight
    expect(summarize(r.env.db, r.sessionId, "completed")).toMatchObject({ counts: { incorrect: 1 } });
  });

  it("overturns a model-incorrect (the learner was right) and records a proposed variant in the rationale", async () => {
    const r = await rig(INCORRECT);
    apply(r, manifest(r, { verdict: "correct", rationale: "Natural Australian English.", proposed_variant: ANSWER }));
    const { skill } = v2(r);
    expect(skill).toMatchObject({ n: 1, successes: 1 });
    expect(skill!.sumW).toBeCloseTo(1, 12);
    expect(one<{ rationale: string }>(r.env.db, "SELECT rationale FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1", r.attemptId).rationale).toContain("Proposed variant");
  });

  it("settles a pending (abstained) answer too", async () => {
    const r = await rig(ABSTAIN);
    expect(unresolvedAttempts(r.env.db)).toHaveLength(1);
    expect(v2(r).skill).toBeUndefined();
    apply(r, manifest(r, { verdict: "correct", rationale: "Fine." }));
    expect(unresolvedAttempts(r.env.db)).toHaveLength(0);
    expect(v2(r).skill).toMatchObject({ n: 1, successes: 1 });
  });

  it("a stale sequence refuses the WHOLE manifest and changes nothing", async () => {
    const r = await rig(INCORRECT);
    const n = rows(r.env.db, "SELECT 1 FROM assessment_revisions").length;
    expect(() => apply(r, manifest(r, { expected_sequence: seq(r) - 1 }))).toThrow(/refused/i);
    expect(rows(r.env.db, "SELECT 1 FROM assessment_revisions")).toHaveLength(n);
    expect(unresolvedAttempts(r.env.db)).toHaveLength(1);
  });

  it("re-applying the same manifest is a no-op; a different pass on a settled attempt is stale", async () => {
    const r = await rig(INCORRECT);
    const m = manifest(r);
    apply(r, m);
    const n = rows(r.env.db, "SELECT 1 FROM assessment_revisions").length;
    expect(apply(r, m)).toMatchObject({ applied: 0, alreadyApplied: 1 });
    expect(rows(r.env.db, "SELECT 1 FROM assessment_revisions")).toHaveLength(n);
    expect(() => apply(r, manifest(r, { expected_sequence: seq(r) - 1 }, "pass-2"))).toThrow(/refused/i);
  });

  it("refuses an attempt that is not waiting (already settled by a human), a bad reviewer id and a bad manifest", async () => {
    const r = await rig(reply({}));
    expect(unresolvedAttempts(r.env.db)).toHaveLength(0);
    apply(r, manifest(r, { verdict: "correct" }, "pass-0")); // settled: no longer an AI verdict
    expect(() => apply(r, manifest(r, {}, "pass-9"))).toThrow(/refused/i);
    expect(() => apply(r, { ...manifest(r), reviewer: "model:gemma4" })).toThrow(/reviewer/i);
    expect(() => apply(r, { schema_version: "attempt-verdict-review-v1", items: [] })).toThrow(/invalid/i);
    expect(rows(r.env.db, "SELECT 1 FROM assessment_revisions WHERE source = 'human'")).toHaveLength(1); // only the first, valid settlement
  });

  it("the export lists the queue with the echo-back values; the agent task names ids and the command, never the learner's answer", async () => {
    const r = await rig(INCORRECT);
    const [item] = attemptsForVerdictReview(r.env.db);
    expect(item).toMatchObject({ attempt_id: r.attemptId, session_id: r.sessionId, expected_sequence: seq(r), current: { verdict: "incorrect", source: "model" } });
    const text = agentTask(r.env.db, "review");
    expect(text).toContain(r.sessionId);
    expect(text).toContain("lab:export -- verdicts");
    expect(text).toContain("lab:verdicts -- apply");
    expect(text).toContain("model-incorrect");
    expect(text).not.toContain("He stopped checking");
  });

  it("the agent can overturn an answer the AI called correct (counted at half weight): it becomes a confirmed failure at full weight", async () => {
    const r = await rig(reply({}));
    expect(attemptsForVerdictReview(r.env.db)).toHaveLength(0); // not in the notice queue ...
    const [item] = attemptsForVerdictReview(r.env.db, { includeAiCorrect: true }); // ... but the agent may ask for it
    expect(item).toMatchObject({ attempt_id: r.attemptId, current: { verdict: "correct", source: "model", confirmation: "tentative" } });
    expect(v2(r).skill).toMatchObject({ successes: 1, aiCheckedN: 1 });
    expect(apply(r, manifest(r))).toMatchObject({ applied: 1, byVerdict: { incorrect: 1 } });
    const after = v2(r);
    expect(after.skill).toMatchObject({ n: 1, successes: 0 });
    expect(after.skill!.sumW).toBeCloseTo(1, 12);
  });

  it("all or nothing: a manifest with one valid item and one unknown or duplicate item changes nothing", async () => {
    const r = await rig(INCORRECT);
    const before = seq(r);
    const valid = manifest(r).items[0]!;
    for (const [bad, code] of [[{ ...valid, attempt_id: randomUUID() }, "ATTEMPT_NOT_FOUND"], [{ ...valid }, "DUPLICATE_ITEM"]] as const) {
      const m = { ...manifest(r), items: [valid, bad] };
      try {
        apply(r, m);
        throw new Error("expected a refusal");
      } catch (e) {
        expect((e as { code?: string; details?: { problems?: Array<{ code: string }> } }).details?.problems?.map((p) => p.code)).toContain(code);
      }
      expect(seq(r)).toBe(before); // the valid item was NOT applied
      expect(unresolvedAttempts(r.env.db)).toHaveLength(1);
    }
  });

  it("the dashboard notice and the finish summary use one definition", async () => {
    for (const step of [INCORRECT, ABSTAIN]) {
      const r = await rig(step);
      expect(summarize(r.env.db, r.sessionId, "completed").unresolved).toBe(reviewStatus(r.env.db).unresolved);
      expect(reviewStatus(r.env.db).unresolved).toBe(1);
    }
  });
});
