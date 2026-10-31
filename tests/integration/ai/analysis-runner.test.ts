import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { disputeAssessment } from "../../../apps/server/src/domain/attempts/assessments.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { readRun, runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { TransportError, type CallStats, type ChatClient, type ChatResult } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V3 } from "../../../apps/server/src/domain/ai/config.js";
import { AnalysisJobRunner } from "../../../apps/server/src/domain/ai/analysisRunner.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { applyAction, getJob, resultOf } from "../../../apps/server/src/queue/jobs.js";
import { jobsOutbox } from "../../../apps/server/src/queue/outbox.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { fixture } from "../../fixtures/exercises/load.js";
import { FakeClock, FakeGpu, flush } from "../../fixtures/queue/fakes.js";
import { TARGET, makeEnv, makeRevision, makeSession, makeSlot, addEvent, one, rows, type Env } from "../attempts/fixtures.js";

const COHORT = { criterionVersion: "rubric-v1", difficulty: "B2" as const };
const ANSWER = "He quit it long ago.";
const stats: CallStats = { totalMs: 10, loadMs: null, promptTokens: 5, evalTokens: 5, evalMs: 5 };
const good = (o: Record<string, unknown> = {}) => (attemptId: string) =>
  JSON.stringify({
    schema_version: "analysis-v2",
    attempt_id: attemptId,
    judgement: "incorrect_candidate",
    reason_code: "grammar_violation",
    missing_context: null,
    findings: [{ skill_id: TARGET, kind: "grammar", start: 3, end: 7, original: "quit", suggestion: "stopped", explanation_ru: "Нужна форма stop + -ing.", confidence: 0.82 }],
    explanation_ru: "Возможная ошибка в конструкции.",
    ...o,
  });

type Step = ((attemptId: string) => string) | Error;
class ScriptedChat implements ChatClient {
  calls = 0;
  attemptId = "";
  constructor(public steps: Step[]) {}
  async chat(): Promise<ChatResult> {
    const s = this.steps[Math.min(this.calls++, this.steps.length - 1)]!;
    if (s instanceof Error) throw s;
    return { text: s(this.attemptId), stats };
  }
}

interface Rig {
  env: Env;
  clock: FakeClock;
  chat: ScriptedChat;
  runner: AnalysisJobRunner;
  sched: GpuScheduler;
  digest: { current: string | null };
  attemptId: string;
  assessmentId: string;
  jobId: string;
}
const envs: Env[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});

async function rig(steps: Step[], answer = ANSWER): Promise<Rig> {
  const env = await makeEnv({ assessor: ClosedFormAssessor });
  envs.push(env);
  const deps = { ...env.deps, outbox: jobsOutbox({ now: env.deps.now, newId: randomUUID }) };
  const rev = makeRevision(env, { type: "guided_short_answer", dimension: "production", content: fixture("guided_short_answer") });
  const session = makeSession(env);
  const slotId = makeSlot(env, session, rev, 0);
  addEvent(env, session, slotId, "reveal");
  const r = recordAttempt(env.db, deps, { slotId, submissionId: "s1", answer, inputMode: "text" });
  const chat = new ScriptedChat(steps);
  chat.attemptId = r.body.attemptId;
  const digest = { current: AI_CONFIG_V3.analysis.digest as string | null };
  const runner = new AnalysisJobRunner({ db: env.db, chat, installedDigest: async () => digest.current, runtimeVersion: async () => "test", deps: env.deps, sleep: async () => {} });
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const sched = new GpuScheduler({ db: env.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "A", config: { admission: "spike", idleUnloadMs: 600_000 } });
  const jobId = one<{ id: string }>(env.db, "SELECT id FROM jobs").id;
  return { env, clock, chat, runner, sched, digest, attemptId: r.body.attemptId, assessmentId: r.body.assessment.id, jobId };
}

async function drive(r: Rig, until: () => boolean, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    await r.sched.tick();
    await flush();
    await flush();
    if (until()) return;
    r.clock.advance(500);
  }
  throw new Error(`not reached; job is ${getJob(r.env.db, r.jobId)?.state}`);
}
const settled = (r: Rig) => ["completed", "failed", "cancelled"].includes(getJob(r.env.db, r.jobId)!.state);
const revisions = (r: Rig) => rows<{ source: string; confirmation: string; verdict: string; ai_annotation_id: string | null; model_version_id: string | null }>(r.env.db, "SELECT source, confirmation, verdict, ai_annotation_id, model_version_id FROM assessment_revisions WHERE attempt_id = ? ORDER BY rowid", r.attemptId);
const annotations = (r: Rig) => rows<{ id: string; status: string; findings_json: string }>(r.env.db, "SELECT id, status, findings_json FROM ai_annotations");

describe("free-text analysis runs through the dispatcher and produces a TENTATIVE draft only", () => {
  it("writes the annotation, a model-sourced tentative revision and tentative findings in one commit; Mastery is bit-identical", async () => {
    const r = await rig([good()]);
    expect((await r.runner.prepare()).ok).toBe(true);
    const before = runMastery(r.env.db, { asOf: "2026-10-29T00:00:00.000Z", cohort: COHORT, now: r.env.deps.now });
    await drive(r, () => settled(r));
    expect(getJob(r.env.db, r.jobId)!.state).toBe("completed");

    const revs = revisions(r);
    expect(revs.map((x) => `${x.source}:${x.confirmation}:${x.verdict}`)).toEqual(["deterministic:tentative:pending", "model:tentative:incorrect"]);
    const ann = annotations(r);
    expect(ann).toHaveLength(1);
    expect(ann[0]!.status).toBe("validated"); // never approved
    expect(revs[1]!.ai_annotation_id).toBe(ann[0]!.id);
    expect(revs[1]!.model_version_id).not.toBeNull();
    expect(JSON.parse(ann[0]!.findings_json).provenance).toMatchObject({ model: AI_CONFIG_V3.analysis.tag, digest: AI_CONFIG_V3.analysis.digest, prompt: "analysis-v3", offsets: "unicode_code_points" });

    const f = rows<{ verdict: string; fragment_start: number; fragment_end: number; finding_type: string }>(r.env.db, "SELECT verdict, fragment_start, fragment_end, finding_type FROM error_events");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ verdict: "tentative", fragment_start: 3, fragment_end: 7, finding_type: "grammar" });

    // no confirmed evidence exists, so Mastery cannot move; a fresh run over the new history equals the old one
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM confirmed_opportunities").n).toBe(0);
    const after = runMastery(r.env.db, { asOf: "2026-10-29T00:00:00.000Z", cohort: COHORT, now: r.env.deps.now });
    expect(JSON.stringify(readRun(r.env.db, after.id))).toBe(JSON.stringify(readRun(r.env.db, before.id))); // the watermark moved (new revision), the evidence and projection did not
    // the job result and its annotation share the job
    expect(resultOf(r.env.db, r.jobId)!.schemaVersion).toBe("analysis-v2");
    const slot = one<{ slot_id: string; session_id: string }>(r.env.db, "SELECT a.slot_id, s.session_id FROM attempts a JOIN session_slots s ON s.id = a.slot_id WHERE a.id = ?", r.attemptId);
    const feedback = getFeedback(r.env.db, r.env.deps, slot.session_id, slot.slot_id);
    expect(feedback.state).toBe("pending");
    expect(feedback.confirmation).toBe("tentative");
    expect(feedback.aiReview).toMatchObject({ judgement: "incorrect_candidate", findings: [{ original: "quit", suggestion: "stopped" }] });
    expect(rows(r.env.db, "SELECT 1 FROM job_results WHERE job_id = ?", r.jobId)).toHaveLength(1);
  });

  it("the pending history row is never rewritten; answer text and attempt are untouched", async () => {
    const r = await rig([good()]);
    await r.runner.prepare();
    const before = one<{ raw: string }>(r.env.db, "SELECT raw_answer_json AS raw FROM attempts WHERE id = ?", r.attemptId).raw;
    await drive(r, () => settled(r));
    expect(one<{ raw: string }>(r.env.db, "SELECT raw_answer_json AS raw FROM attempts WHERE id = ?", r.attemptId).raw).toBe(before);
    expect(() => r.env.db.prepare("UPDATE assessment_revisions SET verdict = 'correct'").run()).toThrow(/append-only|immutable/i);
  });

  it("an 'ambiguous' judgement is stored as uncertain, an 'abstain' keeps only the annotation", async () => {
    const amb = await rig([good({ judgement: "ambiguous", reason_code: "context_required", missing_context: "Which action stopped?", findings: [{ skill_id: TARGET, kind: "ambiguity", start: 3, end: 7, original: "quit", suggestion: "stopped", explanation_ru: "Неоднозначно.", confidence: 0.4 }] })]);
    await amb.runner.prepare();
    await drive(amb, () => settled(amb));
    expect(revisions(amb).at(-1)).toMatchObject({ source: "model", confirmation: "uncertain", verdict: "ambiguous" });

    const ab = await rig([good({ judgement: "abstain", reason_code: "insufficient_evidence", findings: [] })]);
    await ab.runner.prepare();
    await drive(ab, () => settled(ab));
    expect(getJob(ab.env.db, ab.jobId)!.state).toBe("completed");
    expect(annotations(ab)).toHaveLength(1);
    expect(revisions(ab)).toHaveLength(1); // no model revision
  });
});

describe("invalid and failing model output never reaches the history", () => {
  it("invalid twice (initial + one repair) fails the job as failed_validation with no annotation, revision or finding", async () => {
    const r = await rig([() => "I think the sentence is wrong.", () => "Still prose."]);
    await r.runner.prepare();
    await drive(r, () => settled(r));
    const j = getJob(r.env.db, r.jobId)!;
    expect(j.state).toBe("failed");
    expect(j.errorCode).toBe("failed_validation");
    expect(r.chat.calls).toBe(2);
    expect(annotations(r)).toHaveLength(0);
    expect(revisions(r)).toHaveLength(1);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM error_events").n).toBe(0);
  });

  it("a schema-valid but dishonest output (span outside the text, unknown skill, another attempt) is refused", async () => {
    for (const bad of [
      good({ findings: [{ skill_id: TARGET, kind: "grammar", start: 3, end: 99, suggestion: "x", explanation_ru: "y", confidence: 0.9 }] }),
      good({ findings: [{ skill_id: "invented.skill", kind: "grammar", start: 3, end: 7, suggestion: "x", explanation_ru: "y", confidence: 0.9 }] }),
      good({ attempt_id: "someone-else" }),
      good({ confirmed: true }),
    ]) {
      const r = await rig([bad]);
      await r.runner.prepare();
      await drive(r, () => settled(r));
      expect(getJob(r.env.db, r.jobId)!.state, typeof bad).toBe("failed");
      expect(annotations(r)).toHaveLength(0);
      expect(revisions(r)).toHaveLength(1);
    }
  });

  it("a repair that succeeds is accepted and counted", async () => {
    const r = await rig([() => "not json", good()]);
    await r.runner.prepare();
    await drive(r, () => settled(r));
    expect(getJob(r.env.db, r.jobId)!.state).toBe("completed");
    expect(r.chat.calls).toBe(2);
    expect(annotations(r)).toHaveLength(1);
    expect(JSON.parse(annotations(r)[0]!.findings_json).usage.repaired).toBe(true);
  });

  it("transient transport errors are retried inside the unit; persistent ones fail the job with the model server's reason", async () => {
    const ok = await rig([new TransportError("ollama_unreachable", "down", true), good()]);
    await ok.runner.prepare();
    await drive(ok, () => settled(ok));
    expect(getJob(ok.env.db, ok.jobId)!.state).toBe("completed");

    const down = await rig([new TransportError("ollama_unreachable", "down", true)]);
    await down.runner.prepare();
    await drive(down, () => ["failed", "queued"].includes(getJob(down.env.db, down.jobId)!.state) && down.chat.calls >= 3);
    expect(annotations(down)).toHaveLength(0);
    expect(revisions(down)).toHaveLength(1);
  });
});

describe("model identity is pinned", () => {
  it("a drifted installed digest stops the job before any model call", async () => {
    const r = await rig([good()]);
    await r.runner.prepare();
    r.digest.current = "sha256-something-else";
    await drive(r, () => settled(r));
    expect(getJob(r.env.db, r.jobId)!.state).toBe("failed");
    expect(getJob(r.env.db, r.jobId)!.errorCode).toBe("model_digest_mismatch");
    expect(r.chat.calls).toBe(0);
  });

  it("prepare() refuses an unavailable or drifted model and leaves admission at profile_unknown", async () => {
    const r = await rig([good()]);
    r.digest.current = null;
    expect(await r.runner.prepare()).toEqual({ ok: false, reason: "model_server_or_model_unavailable" });
    r.digest.current = "other";
    expect(await r.runner.prepare()).toEqual({ ok: false, reason: "digest_drift" });
    expect(r.runner.profileKey()).toBeNull();
    r.digest.current = AI_CONFIG_V3.analysis.digest;
    expect((await r.runner.prepare()).ok).toBe(true);
    expect(r.runner.profileKey()).not.toBeNull();
    expect((await r.runner.prepare()).ok).toBe(true); // idempotent
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM gpu_profiles").n).toBe(1);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM prompt_versions").n).toBe(1);
  });
});

describe("the draft never overrides a human", () => {
  it("if the learner/reviewer already disputed or corrected the assessment, the draft is stored as a superseded annotation only", async () => {
    const r = await rig([good()]);
    await r.runner.prepare();
    disputeAssessment(r.env.db, r.env.deps, { assessmentId: r.assessmentId, reason: "I think my answer is fine" });
    const histBefore = revisions(r).length;
    await drive(r, () => settled(r));
    expect(getJob(r.env.db, r.jobId)!.state).toBe("completed");
    expect(annotations(r)).toHaveLength(1);
    expect(JSON.parse(annotations(r)[0]!.findings_json).superseded).toBe(true);
    expect(revisions(r).filter((x) => x.source === "model")).toHaveLength(0);
    expect(revisions(r).length).toBe(histBefore);
  });
});

describe("cancellation", () => {
  it("cancelling a queued analysis job is final: no model call, no annotation", async () => {
    const r = await rig([good()]);
    await r.runner.prepare();
    applyAction(r.env.db, { now: r.env.deps.now, newId: randomUUID }, r.jobId, "cancel");
    await r.sched.tick();
    await flush();
    expect(getJob(r.env.db, r.jobId)!.state).toBe("cancelled");
    expect(r.chat.calls).toBe(0);
    expect(annotations(r)).toHaveLength(0);
  });
});

describe("database guards against model authority", () => {
  it("an annotation can only be draft/validated and a model revision can never be confirmed", async () => {
    const r = await rig([good()]);
    await r.runner.prepare();
    await drive(r, () => settled(r));
    const ann = annotations(r)[0]!;
    const jr = one<{ id: string }>(r.env.db, "SELECT id FROM job_results").id;
    for (const status of ["approved", "pending_review", "flagged", "rejected"]) {
      expect(() => r.env.db.prepare("INSERT INTO ai_annotations(id, job_result_id, status, findings_json, created_at) VALUES (?,?,?,?,?)").run(randomUUID(), jr, status, "{}", "2026-10-29T00:00:00Z")).toThrow(/CHECK/i);
    }
    expect(() => r.env.db.prepare("UPDATE ai_annotations SET status = 'validated' WHERE id = ?").run(ann.id)).toThrow(/append-only/);
    expect(() => r.env.db.prepare("DELETE FROM ai_annotations WHERE id = ?").run(ann.id)).toThrow(/append-only/);
    expect(() => r.env.db.prepare("UPDATE prompt_versions SET purpose = 'x'").run()).toThrow(/append-only/);
  });
});
