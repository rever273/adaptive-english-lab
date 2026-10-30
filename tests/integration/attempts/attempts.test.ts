import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptRequest } from "../../../packages/contracts/src/index.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { createTranscript, upsertModelVersion } from "../../../apps/server/src/domain/attempts/transcripts.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import {
  SKILL_B,
  SKILL_C,
  TARGET,
  addEvent,
  advance,
  exactSetAssessor,
  makeEnv,
  makeRevision,
  makeSession,
  makeSlot,
  one,
  revealedSlot,
  rows,
  type Env,
} from "./fixtures.js";

let env: Env;
afterEach(() => env?.cleanup());

const submit = (slotId: string, over: Partial<AttemptRequest> = {}): AttemptRequest => ({
  slotId,
  submissionId: randomUUID(),
  answer: ["a"],
  inputMode: "text",
  ...over,
});
const failsWith = (fn: () => unknown, status: number, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({ status, code });
    return;
  }
  throw new Error(`expected ApiError ${status} ${code}`);
};
const count = (table: string) => (one(env.db, `SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n;

describe("recording the first attempt", () => {
  beforeEach(async () => {
    env = await makeEnv({ assessor: exactSetAssessor() });
  });

  it("stores the raw answer verbatim and derives server-side facts", () => {
    const { slotId } = revealedSlot(env, { dimension: "production", type: "guided_short_answer" });
    advance(env, 4200);
    const raw = "  The employee  stopped checking emails after the shift.\n";
    const r = recordAttempt(env.db, env.deps, submit(slotId, { answer: raw }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ attemptNo: 1, firstAttempt: true, assisted: false, replayed: false });

    const a = one<Record<string, unknown>>(env.db, "SELECT * FROM attempts");
    expect(JSON.parse(a.raw_answer_json as string)).toEqual({ schema_version: 1, kind: "text", text: raw }); // untouched bytes
    expect(a).toMatchObject({ attempt_no: 1, first_attempt: 1, hints_before: 0, answer_seen_before: 0, idk: 0, latency_ms: 4200, criterion_version: "rubric-v1", timezone: "Australia/Brisbane" });
    // 01:00Z is 11:00 in Brisbane: same local day
    expect(a.local_date).toBe("2026-10-28");
  });

  it("derives the learning day from the session time zone, not UTC", () => {
    const { slotId } = revealedSlot(env);
    env.clock.current = new Date("2026-10-28T15:30:00.000Z"); // 01:30 on the 29th in Brisbane
    recordAttempt(env.db, env.deps, submit(slotId));
    expect(one<{ local_date: string }>(env.db, "SELECT local_date FROM attempts").local_date).toBe("2026-10-29");
  });

  it("answers an IDK as a confirmed failure outcome with its own opportunity, and never as an empty correct", () => {
    const { slotId } = revealedSlot(env);
    const r = recordAttempt(env.db, env.deps, submit(slotId, { answer: undefined, idk: true }));
    expect(r.body.assessment).toMatchObject({ verdict: "idk", confirmation: "confirmed", status: "assessed" });
    expect(JSON.parse(one<{ raw_answer_json: string }>(env.db, "SELECT raw_answer_json FROM attempts").raw_answer_json)).toEqual({ schema_version: 1, kind: "idk" });
    expect(rows(env.db, "SELECT result, target, independent, opportunity_type FROM skill_opportunities")).toEqual([{ result: "idk", target: 1, independent: 1, opportunity_type: "explicit" }]);
  });

  it("treats skip as an event only: no attempt, no assessment, no opportunity, and the slot closes", () => {
    const { sessionId, slotId } = revealedSlot(env);
    const e = recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "skip", clientEventId: "skip-1" });
    expect(e.status).toBe(201);
    expect(count("attempts")).toBe(0);
    expect(count("assessment_revisions")).toBe(0);
    expect(count("skill_opportunities")).toBe(0);
    failsWith(() => recordAttempt(env.db, env.deps, submit(slotId)), 409, "SLOT_CLOSED");
    failsWith(() => recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "hint", clientEventId: "h-late" }), 409, "SLOT_CLOSED");
  });

  it("keeps IDK and skip apart in SQL (idk counts as an attempt, skip does not)", () => {
    const a = revealedSlot(env);
    const b = revealedSlot(env);
    recordAttempt(env.db, env.deps, submit(a.slotId, { answer: undefined, idk: true }));
    recordSessionEvent(env.db, env.deps, b.sessionId, { slotId: b.slotId, type: "skip", clientEventId: "s" });
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts WHERE idk = 1").n).toBe(1);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(DISTINCT slot_id) AS n FROM session_events WHERE event_type = 'skip'").n).toBe(1);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM confirmed_opportunities WHERE result = 'idk'").n).toBe(1);
  });
});

describe("idempotent submission", () => {
  beforeEach(async () => {
    env = await makeEnv({ assessor: exactSetAssessor() });
  });

  it("returns the same response for the same submission and writes nothing twice", () => {
    const { slotId } = revealedSlot(env);
    const req = submit(slotId, { answer: ["a"] });
    const first = recordAttempt(env.db, env.deps, req);
    advance(env, 60_000);
    const again = recordAttempt(env.db, env.deps, { ...req });
    expect(again.status).toBe(200);
    expect({ ...again.body, replayed: false }).toEqual(first.body);
    expect(again.body.replayed).toBe(true);
    expect(count("attempts")).toBe(1);
    expect(count("assessment_revisions")).toBe(1);
    expect(count("skill_opportunities")).toBe(1);
  });

  it("rejects the same submissionId with a different payload (409) and changes nothing", () => {
    const { slotId } = revealedSlot(env);
    const req = submit(slotId, { answer: ["a"] });
    recordAttempt(env.db, env.deps, req);
    failsWith(() => recordAttempt(env.db, env.deps, { ...req, answer: ["b"] }), 409, "IDEMPOTENCY_CONFLICT");
    failsWith(() => recordAttempt(env.db, env.deps, { slotId, submissionId: req.submissionId, idk: true, inputMode: "text" }), 409, "IDEMPOTENCY_CONFLICT");
    expect(count("attempts")).toBe(1);
    expect(JSON.parse(one<{ raw_answer_json: string }>(env.db, "SELECT raw_answer_json FROM attempts").raw_answer_json).optionIds).toEqual(["a"]);
  });

  it("applies the same rules to session events", () => {
    const { sessionId, slotId } = revealedSlot(env);
    const first = recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "hint", clientEventId: "evt-1" });
    const again = recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "hint", clientEventId: "evt-1" });
    expect([first.status, again.status, again.body.replayed, again.body.eventId]).toEqual([201, 200, true, first.body.eventId]);
    failsWith(() => recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "reveal_answer", clientEventId: "evt-1" }), 409, "IDEMPOTENCY_CONFLICT");
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM session_events WHERE event_type='hint'").n).toBe(1);
  });
});

describe("hints, answer reveal and retries stay in history but not in unaided evidence", () => {
  beforeEach(async () => {
    env = await makeEnv({ assessor: exactSetAssessor() });
  });

  it("a hint before the first answer keeps first_attempt=1 but excludes it from confirmed opportunities", () => {
    const { sessionId, slotId } = revealedSlot(env);
    recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "hint", clientEventId: "h1" });
    const r = recordAttempt(env.db, env.deps, submit(slotId, { answer: ["a"] }));
    expect(r.body).toMatchObject({ firstAttempt: true, assisted: true });
    expect(one(env.db, "SELECT first_attempt, hints_before, answer_seen_before FROM attempts")).toEqual({ first_attempt: 1, hints_before: 1, answer_seen_before: 0 });
    expect(one<{ independent: number }>(env.db, "SELECT independent FROM skill_opportunities").independent).toBe(0);
    expect(count("confirmed_opportunities")).toBe(0);
  });

  it("revealing the answer first marks the attempt answer_seen and assisted", () => {
    const { sessionId, slotId } = revealedSlot(env);
    recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "reveal_answer", clientEventId: "ra" });
    const r = recordAttempt(env.db, env.deps, submit(slotId, { answer: ["a"] }));
    expect(r.body.assisted).toBe(true);
    expect(one<{ answer_seen_before: number }>(env.db, "SELECT answer_seen_before FROM attempts").answer_seen_before).toBe(1);
    expect(count("confirmed_opportunities")).toBe(0);
  });

  it("an unaided first attempt counts; a voluntary retry is attempt 2, never first, never independent", () => {
    const { sessionId, slotId } = revealedSlot(env);
    const wrong = recordAttempt(env.db, env.deps, submit(slotId, { answer: ["b"] }));
    expect(wrong.body.assessment.verdict).toBe("incorrect");
    recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "hint", clientEventId: "h-after" });
    const retry = recordAttempt(env.db, env.deps, submit(slotId, { answer: ["a"] }));
    expect(retry.body).toMatchObject({ attemptNo: 2, firstAttempt: false, assisted: true });
    expect(rows(env.db, "SELECT attempt_no, first_attempt, hints_before FROM attempts ORDER BY attempt_no")).toEqual([
      { attempt_no: 1, first_attempt: 1, hints_before: 0 },
      { attempt_no: 2, first_attempt: 0, hints_before: 1 },
    ]);
    // only the first (failed) attempt is confirmed unaided evidence; the successful retry is not
    expect(rows(env.db, "SELECT result FROM confirmed_opportunities")).toEqual([{ result: "failure" }]);
    expect(rows(env.db, "SELECT independent FROM skill_opportunities ORDER BY rowid").map((r) => r.independent)).toEqual([1, 0]);
  });

  it("the database refuses a second first attempt and out-of-order attempt numbers", () => {
    const { slotId } = revealedSlot(env);
    recordAttempt(env.db, env.deps, submit(slotId));
    const insert = (no: number, first: number) =>
      env.db
        .prepare(
          `INSERT INTO attempts(id, slot_id, submission_id, attempt_no, first_attempt, raw_answer_json, input_mode, transcript_id, hints_before, answer_seen_before, idk, submitted_at, local_date, timezone, latency_ms, criterion_version)
           VALUES (?,?,?,?,?,'{}','text',NULL,0,0,0,'t','d','tz',NULL,'v')`,
        )
        .run(randomUUID(), slotId, randomUUID(), no, first);
    expect(() => insert(2, 1)).toThrow(/CHECK/); // first_attempt must equal (attempt_no = 1)
    expect(() => insert(1, 1)).toThrow(/UNIQUE|attempt_no/);
    expect(() => insert(4, 0)).toThrow(/attempt_no must be previous \+ 1/);
    expect(count("attempts")).toBe(1);
  });
});

describe("one failed attempt with several errors", () => {
  it("creates one attempt, one assessment, one target opportunity and separate findings", async () => {
    const finding = (skillId: string, verdict: "confirmed" | "tentative" = "confirmed") => ({
      skillId,
      fragmentStart: 0,
      fragmentEnd: 3,
      correction: "fix",
      explanationRu: "объяснение",
      findingType: "grammar" as const,
      verdict,
    });
    env = await makeEnv({
      assessor: exactSetAssessor((correct) => (correct ? {} : { findings: [finding(TARGET), finding(SKILL_B), finding(SKILL_C, "tentative"), finding(SKILL_B)] })),
    });
    const { slotId } = revealedSlot(env);
    recordAttempt(env.db, env.deps, submit(slotId, { answer: ["b"] }));

    expect(count("attempts")).toBe(1);
    expect(count("assessment_revisions")).toBe(1);
    expect(count("error_events")).toBe(4); // every finding is kept, incl. the duplicate span
    expect(rows(env.db, "SELECT target, opportunity_type, reliability, result FROM skill_opportunities ORDER BY target DESC, reliability")).toEqual([
      { target: 1, opportunity_type: "explicit", reliability: "confirmed", result: "failure" },
      { target: 0, opportunity_type: "observed", reliability: "confirmed", result: "failure" },
      { target: 0, opportunity_type: "observed", reliability: "tentative", result: "failure" },
    ]);
    // v1 evidence: one failed opportunity, not three
    expect(count("confirmed_opportunities")).toBe(1);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(DISTINCT attempt_id) AS n FROM confirmed_opportunities").n).toBe(1);
  });

  it("rolls back everything when a finding names a skill outside the taxonomy", async () => {
    env = await makeEnv({ assessor: exactSetAssessor(() => ({ findings: [{ skillId: "no.such.skill", explanationRu: "x", findingType: "grammar", verdict: "confirmed" }] })) });
    const { slotId } = revealedSlot(env);
    failsWith(() => recordAttempt(env.db, env.deps, submit(slotId)), 422, "UNKNOWN_SKILL");
    expect([count("attempts"), count("assessment_revisions"), count("error_events"), count("skill_opportunities")]).toEqual([0, 0, 0, 0]);
  });
});

describe("pending assessments, outbox and authority", () => {
  it("without a grader the answer is stored as pending: no feedback, no opportunity, no fabricated verdict", async () => {
    env = await makeEnv(); // PendingAssessor
    const { slotId } = revealedSlot(env, { dimension: "production", type: "guided_short_answer" });
    const r = recordAttempt(env.db, env.deps, submit(slotId, { answer: "The employee stopped checking emails." }));
    expect(r.body.assessment).toMatchObject({ verdict: "pending", status: "pending", confirmation: "tentative" });
    expect(r.body.feedback).toEqual({ allowed: false, reason: "assessment_pending" });
    expect(count("skill_opportunities")).toBe(0);
  });

  it("commits the raw attempt and the outbox descriptor together, or neither", async () => {
    const seen: Array<{ attemptId: string; assessmentId: string; kind: string }> = [];
    let fail = false;
    env = await makeEnv({
      assessor: { assess: () => ({ verdict: "pending", confirmation: "tentative", source: "deterministic", rationale: "needs analysis", outbox: { kind: "free_text_analysis", payload: { slot: "x" } } }) },
      outbox: {
        enqueue(db, item) {
          // the attempt and assessment are already visible inside the same transaction
          expect(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE id = ?").get(item.attemptId)).toEqual({ n: 1 });
          expect(db.prepare("SELECT COUNT(*) AS n FROM assessment_revisions WHERE id = ?").get(item.assessmentId)).toEqual({ n: 1 });
          if (fail) throw new Error("queue unavailable");
          seen.push({ attemptId: item.attemptId, assessmentId: item.assessmentId, kind: item.kind });
        },
      },
    });
    const { slotId } = revealedSlot(env, { dimension: "production", type: "guided_short_answer" });
    fail = true;
    expect(() => recordAttempt(env.db, env.deps, submit(slotId, { answer: "text" }))).toThrow("queue unavailable");
    expect([count("attempts"), count("assessment_revisions")]).toEqual([0, 0]);
    expect(seen).toHaveLength(0);

    fail = false;
    const ok = recordAttempt(env.db, env.deps, submit(slotId, { answer: "text" }));
    expect(seen).toEqual([{ attemptId: ok.body.attemptId, assessmentId: ok.body.assessment.id, kind: "free_text_analysis" }]);
  });

  it("never lets model output confirm itself (service rule and CHECK constraint)", async () => {
    env = await makeEnv({ assessor: { assess: () => ({ verdict: "correct", confirmation: "confirmed", source: "model", rationale: "model says so" }) } });
    const { slotId } = revealedSlot(env);
    failsWith(() => recordAttempt(env.db, env.deps, submit(slotId)), 422, "MODEL_CANNOT_CONFIRM");
    expect(count("attempts")).toBe(0);

    env.cleanup();
    env = await makeEnv({ assessor: exactSetAssessor() });
    const s = revealedSlot(env);
    const r = recordAttempt(env.db, env.deps, submit(s.slotId));
    expect(() =>
      env.db
        .prepare("INSERT INTO assessment_revisions(id, attempt_id, sequence, source, verdict, confirmation, criterion_version, supersedes_id, rationale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), r.body.attemptId, 2, "model", "correct", "confirmed", "v", r.body.assessment.id, "x", "t"),
    ).toThrow(/CHECK/);
  });

  it("keeps held-out feedback closed", async () => {
    env = await makeEnv({ assessor: exactSetAssessor() });
    const { slotId } = revealedSlot(env, { purpose: "heldout", bankRole: "heldout" });
    const r = recordAttempt(env.db, env.deps, submit(slotId));
    expect(r.body.assessment.verdict).toBe("correct");
    expect(r.body.feedback).toEqual({ allowed: false, reason: "heldout_block_open" });
  });

  it("reading child slots use their own question target skill and evidence group", async () => {
    env = await makeEnv({ assessor: exactSetAssessor() });
    const content = {
      schema_version: "exercise-v1",
      type: "context_reading",
      target_skill: "articles.zero_general", // parent grouping only
      payload: { questions: [{ id: "q1", target_skill: SKILL_B }, { id: "q2", target_skill: SKILL_C }] },
    };
    const rev = makeRevision(env, { type: "context_reading", content });
    const session = makeSession(env);
    const q1 = makeSlot(env, session, rev, 0, "q1");
    const q2 = makeSlot(env, session, rev, 1, "q2");
    addEvent(env, session, q1, "reveal");
    addEvent(env, session, q2, "reveal");
    // the grader reads accepted ids from payload.questions in real life; here IDK exercises the target resolution only
    recordAttempt(env.db, env.deps, submit(q1, { answer: undefined, idk: true }));
    recordAttempt(env.db, env.deps, submit(q2, { answer: undefined, idk: true }));
    const opps = rows<{ skill_id: string; evidence_group: string }>(env.db, "SELECT sr.skill_id, o.evidence_group FROM skill_opportunities o JOIN skill_revisions sr ON sr.id = o.skill_revision_id ORDER BY sr.skill_id");
    expect(opps).toEqual([
      { skill_id: SKILL_B, evidence_group: `${q1}:q1` },
      { skill_id: SKILL_C, evidence_group: `${q2}:q2` },
    ]);
  });
});

describe("slot and session guards", () => {
  beforeEach(async () => {
    env = await makeEnv({ assessor: exactSetAssessor() });
  });

  it("refuses attempts and events for an unrevealed slot, a suspended session or an unknown slot", () => {
    const rev = makeRevision(env);
    const session = makeSession(env);
    const slot = makeSlot(env, session, rev, 0);
    failsWith(() => recordAttempt(env.db, env.deps, submit(slot)), 409, "SLOT_NOT_REVEALED");
    failsWith(() => recordSessionEvent(env.db, env.deps, session, { slotId: slot, type: "hint", clientEventId: "x" }), 409, "SLOT_NOT_REVEALED");
    failsWith(() => recordAttempt(env.db, env.deps, submit(randomUUID())), 404, "SLOT_NOT_FOUND");

    const suspended = revealedSlot(env, { status: "suspended" });
    failsWith(() => recordAttempt(env.db, env.deps, submit(suspended.slotId)), 409, "SESSION_NOT_ACTIVE");
    failsWith(() => recordSessionEvent(env.db, env.deps, suspended.sessionId, { slotId: suspended.slotId, type: "skip", clientEventId: "y" }), 409, "SESSION_NOT_ACTIVE");
    failsWith(() => recordSessionEvent(env.db, env.deps, randomUUID(), { slotId: slot, type: "skip", clientEventId: "z" }), 404, "SESSION_NOT_FOUND");
    failsWith(() => recordSessionEvent(env.db, env.deps, makeSession(env), { slotId: slot, type: "skip", clientEventId: "w" }), 404, "SLOT_NOT_FOUND"); // slot of another session
    expect(count("attempts")).toBe(0);
  });

  it("requires an answer before continue (skip is the explicit way to leave a slot unanswered)", () => {
    const { sessionId, slotId } = revealedSlot(env);
    failsWith(() => recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "continue", clientEventId: "c1" }), 409, "CONTINUE_WITHOUT_ANSWER");
    recordAttempt(env.db, env.deps, submit(slotId));
    expect(recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "continue", clientEventId: "c2" }).status).toBe(201);
    failsWith(() => recordAttempt(env.db, env.deps, submit(slotId)), 409, "SLOT_CLOSED");
  });
});

describe("voice transcripts (text provenance only)", () => {
  beforeEach(async () => {
    env = await makeEnv();
  });

  it("accepts a voice attempt only with the confirmed transcript text of the same slot, keeping the ASR draft", () => {
    const { sessionId, slotId } = revealedSlot(env, { dimension: "production", type: "guided_short_answer" });
    const other = revealedSlot(env, { dimension: "production", type: "guided_short_answer" });
    const model = upsertModelVersion(env.db, randomUUID, { tag: "faster-whisper-small", digest: "snap-536b", runtime: "ctranslate2", runtimeVersion: "4.7.1", parameters: { language: "en" } });
    expect(upsertModelVersion(env.db, randomUUID, { tag: "faster-whisper-small", digest: "snap-536b", runtime: "ctranslate2", runtimeVersion: "4.7.1", parameters: {} })).toBe(model);

    const t = createTranscript(env.db, { sessionId, slotId, asrText: "the employee stop checking emails", submittedText: "The employee stopped checking emails.", sttModelId: model, newId: randomUUID, now: env.deps.now });
    const row = one<{ asr_text: string; submitted_text: string; edited: number }>(env.db, "SELECT asr_text, submitted_text, edited FROM transcripts WHERE id = ?", t);
    expect(row).toEqual({ asr_text: "the employee stop checking emails", submitted_text: "The employee stopped checking emails.", edited: 1 });

    failsWith(() => recordAttempt(env.db, env.deps, submit(slotId, { answer: "something else", inputMode: "voice", transcriptId: t })), 422, "TRANSCRIPT_MISMATCH");
    failsWith(() => recordAttempt(env.db, env.deps, submit(other.slotId, { answer: row.submitted_text, inputMode: "voice", transcriptId: t })), 422, "TRANSCRIPT_MISMATCH");
    expect(count("attempts")).toBe(0);
    const ok = recordAttempt(env.db, env.deps, submit(slotId, { answer: row.submitted_text, inputMode: "voice", transcriptId: t }));
    expect(ok.status).toBe(201);
    expect(one(env.db, "SELECT input_mode, transcript_id FROM attempts")).toEqual({ input_mode: "voice", transcript_id: t });
    // no audio columns or tables exist anywhere in the schema
    const cols = rows<{ name: string }>(env.db, "SELECT m.name || '.' || p.name AS name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'");
    expect(cols.filter((c) => /audio|wav|pcm|blob/i.test(c.name))).toEqual([]);
  });
});

describe("addEvent fixture sanity", () => {
  it("raw reveal events are ordinary append-only rows", async () => {
    env = await makeEnv();
    const { sessionId, slotId } = revealedSlot(env);
    expect(addEvent(env, sessionId, slotId, "resume")).toMatch(/^[0-9a-f-]{36}$/);
    expect(count("session_events")).toBe(2);
  });
});
