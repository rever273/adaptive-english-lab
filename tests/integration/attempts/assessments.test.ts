import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptRequest } from "../../../packages/contracts/src/index.js";
import { appendAssessmentRevision, disputeAssessment, latestAssessment, resolveDispute } from "../../../apps/server/src/domain/attempts/assessments.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { effectiveFindingVerdict, reviewFinding } from "../../../apps/server/src/domain/attempts/findings.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { SKILL_B, TARGET, exactSetAssessor, makeEnv, one, revealedSlot, rows, type Env } from "./fixtures.js";

let env: Env;
beforeEach(async () => {
  env = await makeEnv({
    assessor: exactSetAssessor((correct) =>
      correct ? {} : { findings: [{ skillId: SKILL_B, fragmentStart: 4, fragmentEnd: 9, correction: "a", explanationRu: "артикль", findingType: "grammar", verdict: "tentative", confidence: 0.9 }] },
    ),
  });
});
afterEach(() => env.cleanup());

const submit = (slotId: string, answer: string[] = ["b"]): AttemptRequest => ({ slotId, submissionId: randomUUID(), answer, inputMode: "text" });
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
const human = (verdict: "correct" | "incorrect", rationale = "reviewed by hand") => ({
  verdict,
  confirmation: "confirmed" as const,
  source: "human" as const,
  rationale,
});

describe("human correction / re-assessment", () => {
  it("appends a revision, keeps the original attempt bytes and the old evidence, and moves the projection", () => {
    const { slotId } = revealedSlot(env);
    const a = recordAttempt(env.db, env.deps, submit(slotId, ["b"]));
    expect(a.body.assessment.verdict).toBe("incorrect");
    const before = one<{ raw_answer_json: string; submitted_at: string }>(env.db, "SELECT raw_answer_json, submitted_at FROM attempts");
    expect(rows(env.db, "SELECT result FROM confirmed_opportunities")).toEqual([{ result: "failure" }]);

    env.clock.current = new Date(env.clock.current.getTime() + 3600_000);
    const rev = appendAssessmentRevision(env.db, env.deps, { attemptId: a.body.attemptId, expectedSequence: 1, decision: human("correct", "alternative wording is acceptable") });
    expect(rev).toMatchObject({ sequence: 2, verdict: "correct", source: "human" });

    // raw history untouched
    expect(one(env.db, "SELECT raw_answer_json, submitted_at FROM attempts")).toEqual(before);
    expect(rows(env.db, "SELECT sequence, verdict, source FROM assessment_revisions ORDER BY sequence")).toEqual([
      { sequence: 1, verdict: "incorrect", source: "deterministic" },
      { sequence: 2, verdict: "correct", source: "human" },
    ]);
    expect(one<{ supersedes_id: string }>(env.db, "SELECT supersedes_id FROM assessment_revisions WHERE sequence = 2").supersedes_id).toBe(a.body.assessment.id);
    // old evidence rows stay; the confirmed projection follows the latest revision only
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM skill_opportunities").n).toBe(3); // 2 from rev1 (target + observed), 1 from rev2
    expect(rows(env.db, "SELECT result FROM confirmed_opportunities")).toEqual([{ result: "success" }]);
    expect(one<{ id: string }>(env.db, "SELECT id FROM latest_assessments").id).toBe(rev.id);
  });

  it("rejects a stale expectedSequence with 409 and writes nothing", () => {
    const { slotId } = revealedSlot(env);
    const a = recordAttempt(env.db, env.deps, submit(slotId));
    appendAssessmentRevision(env.db, env.deps, { attemptId: a.body.attemptId, expectedSequence: 1, decision: human("correct") });
    try {
      appendAssessmentRevision(env.db, env.deps, { attemptId: a.body.attemptId, expectedSequence: 1, decision: human("incorrect") });
      throw new Error("expected conflict");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("STALE_ASSESSMENT");
      expect((e as ApiError).details).toEqual({ latestSequence: 2 });
    }
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM assessment_revisions").n).toBe(2);
  });

  it("does not allow the revision chain to branch or skip numbers (DB-level)", () => {
    const { slotId } = revealedSlot(env);
    const a = recordAttempt(env.db, env.deps, submit(slotId));
    const ins = (seq: number, supersedes: string | null) =>
      env.db
        .prepare("INSERT INTO assessment_revisions(id, attempt_id, sequence, source, verdict, confirmation, criterion_version, supersedes_id, rationale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), a.body.attemptId, seq, "human", "correct", "confirmed", "v", supersedes, "x", "t");
    expect(() => ins(1, null)).toThrow(); // duplicate sequence
    expect(() => ins(3, a.body.assessment.id)).toThrow(/latest \+ 1/); // gap
    expect(() => ins(2, null)).toThrow(/supersedes_id/); // wrong parent
    expect(() => ins(2, a.body.assessment.id)).not.toThrow();
  });

  it("a human correction of an IDK-free pending answer turns it into evidence", async () => {
    env.cleanup();
    env = await makeEnv(); // PendingAssessor
    const { slotId } = revealedSlot(env, { dimension: "production", type: "guided_short_answer" });
    const a = recordAttempt(env.db, env.deps, { slotId, submissionId: "s1", answer: "The employee stopped checking emails.", inputMode: "text" });
    expect(a.body.assessment.verdict).toBe("pending");
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM confirmed_opportunities").n).toBe(0);
    appendAssessmentRevision(env.db, env.deps, { attemptId: a.body.attemptId, expectedSequence: 1, decision: human("correct", "matches approved alternative") });
    expect(rows(env.db, "SELECT result, independent FROM confirmed_opportunities")).toEqual([{ result: "success", independent: 1 }]);
  });
});

describe("dispute", () => {
  it("appends a disputed revision, removes the evidence from the confirmed projection and keeps all history", () => {
    const { slotId } = revealedSlot(env);
    const a = recordAttempt(env.db, env.deps, submit(slotId));
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM confirmed_opportunities").n).toBe(1);

    const d = disputeAssessment(env.db, env.deps, { assessmentId: a.body.assessment.id, reason: "My answer is natural en-AU." });
    expect(d.assessment).toMatchObject({ sequence: 2, verdict: "disputed", confirmation: "disputed", source: "human" });
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM confirmed_opportunities").n).toBe(0);
    expect(one(env.db, "SELECT assessment_id, reason, resolution_assessment_id FROM assessment_disputes")).toEqual({
      assessment_id: a.body.assessment.id,
      reason: "My answer is natural en-AU.",
      resolution_assessment_id: null,
    });
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM skill_opportunities").n).toBe(2); // rev1 rows survive
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts").n).toBe(1);

    failsWith(() => disputeAssessment(env.db, env.deps, { assessmentId: d.assessment.id, reason: "again" }), 409, "ALREADY_DISPUTED");
    failsWith(() => disputeAssessment(env.db, env.deps, { assessmentId: a.body.assessment.id, reason: "stale id" }), 409, "STALE_ASSESSMENT");
    failsWith(() => disputeAssessment(env.db, env.deps, { assessmentId: randomUUID(), reason: "?" }), 404, "ASSESSMENT_NOT_FOUND");

    // resolution: a later human revision, linked once
    const res = appendAssessmentRevision(env.db, env.deps, { attemptId: a.body.attemptId, expectedSequence: 2, decision: human("correct", "dispute upheld") });
    failsWith(() => resolveDispute(env.db, { disputeId: d.disputeId, resolutionAssessmentId: d.assessment.id }), 422, "INVALID_RESOLUTION");
    resolveDispute(env.db, { disputeId: d.disputeId, resolutionAssessmentId: res.id });
    expect(one<{ resolution_assessment_id: string }>(env.db, "SELECT resolution_assessment_id FROM assessment_disputes").resolution_assessment_id).toBe(res.id);
    failsWith(() => resolveDispute(env.db, { disputeId: d.disputeId, resolutionAssessmentId: res.id }), 409, "DISPUTE_RESOLVED");
    expect(rows(env.db, "SELECT result FROM confirmed_opportunities")).toEqual([{ result: "success" }]);
    expect(latestAssessment(env.db, a.body.attemptId)?.sequence).toBe(3);
  });
});

describe("AI finding review history", () => {
  it("is append-only with an optimistic sequence; effective verdict is the latest review", () => {
    const { slotId } = revealedSlot(env);
    recordAttempt(env.db, env.deps, submit(slotId));
    const f = one<{ id: string; verdict: string }>(env.db, "SELECT id, verdict FROM error_events");
    expect(f.verdict).toBe("tentative");
    expect(effectiveFindingVerdict(env.db, f.id)).toBe("tentative");

    const base = { findingId: f.id, reviewer: "agent:test", reviewVersion: "review-v1", sourceHash: "abc", newId: randomUUID, now: env.deps.now };
    expect(reviewFinding(env.db, { ...base, verdict: "rejected", reason: "style, not grammar", expectedSequence: 0 })).toEqual({ sequence: 1 });
    expect(effectiveFindingVerdict(env.db, f.id)).toBe("rejected");
    try {
      reviewFinding(env.db, { ...base, verdict: "confirmed", reason: "stale", expectedSequence: 0 });
      throw new Error("expected conflict");
    } catch (e) {
      expect((e as ApiError).code).toBe("STALE_REVIEW");
    }
    reviewFinding(env.db, { ...base, verdict: "confirmed", reason: "re-accepted after second look", expectedSequence: 1 });
    expect(effectiveFindingVerdict(env.db, f.id)).toBe("confirmed");
    expect(rows(env.db, "SELECT sequence, verdict FROM finding_review_events ORDER BY sequence")).toEqual([
      { sequence: 1, verdict: "rejected" },
      { sequence: 2, verdict: "confirmed" },
    ]);
    // the original finding row is unchanged
    expect(one<{ verdict: string }>(env.db, "SELECT verdict FROM error_events").verdict).toBe("tentative");
  });
});

describe("append-only triggers (strong schema review item)", () => {
  function seed() {
    const { sessionId, slotId, revisionId } = revealedSlot(env);
    const a = recordAttempt(env.db, env.deps, submit(slotId));
    recordSessionEvent(env.db, env.deps, sessionId, { slotId, type: "hint", clientEventId: "ev" });
    const f = one<{ id: string }>(env.db, "SELECT id FROM error_events");
    reviewFinding(env.db, { findingId: f.id, verdict: "confirmed", reviewer: "t", reviewVersion: "v", sourceHash: "h", reason: "r", expectedSequence: 0, newId: randomUUID, now: env.deps.now });
    return { revisionId, attemptId: a.body.attemptId };
  }

  it.each([
    ["attempts", "UPDATE attempts SET hints_before = 9", "DELETE FROM attempts"],
    ["session_events", "UPDATE session_events SET event_type = 'skip'", "DELETE FROM session_events"],
    ["exercise_revisions", "UPDATE exercise_revisions SET topic = 'x'", "DELETE FROM exercise_revisions"],
    ["assessment_revisions", "UPDATE assessment_revisions SET verdict = 'correct'", "DELETE FROM assessment_revisions"],
    ["error_events", "UPDATE error_events SET verdict = 'confirmed'", "DELETE FROM error_events"],
    ["finding_review_events", "UPDATE finding_review_events SET verdict = 'rejected'", "DELETE FROM finding_review_events"],
    ["skill_opportunities", "UPDATE skill_opportunities SET result = 'success'", "DELETE FROM skill_opportunities"],
  ])("%s refuses UPDATE and DELETE", (table, update, del) => {
    seed();
    const snapshot = JSON.stringify(rows(env.db, `SELECT * FROM ${table} ORDER BY rowid`));
    expect(() => env.db.prepare(update).run()).toThrow(/append-only|immutable/);
    expect(() => env.db.prepare(del).run()).toThrow(/append-only|immutable/);
    expect(JSON.stringify(rows(env.db, `SELECT * FROM ${table} ORDER BY rowid`))).toBe(snapshot);
  });

  it("projections are views over raw rows: dropping and recreating them loses nothing", () => {
    seed();
    const before = JSON.stringify(rows(env.db, "SELECT * FROM confirmed_opportunities ORDER BY id"));
    const defs = rows<{ name: string; sql: string }>(env.db, "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name DESC");
    for (const v of ["confirmed_opportunities", "latest_assessments"]) env.db.exec(`DROP VIEW ${v}`);
    for (const v of ["latest_assessments", "confirmed_opportunities"]) env.db.exec(defs.find((d) => d.name === v)!.sql);
    expect(JSON.stringify(rows(env.db, "SELECT * FROM confirmed_opportunities ORDER BY id"))).toBe(before);
    expect(TARGET).toBe("articles.definite");
  });
});
