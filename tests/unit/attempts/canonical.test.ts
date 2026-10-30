import { describe, expect, it } from "vitest";
import { isAssisted, isIndependent, localDateIn, rawAnswerJson, sameSubmission, toRawAnswer } from "../../../apps/server/src/domain/attempts/canonical.js";
import { PendingAssessor } from "../../../apps/server/src/domain/attempts/ports.js";
import { AttemptRequestSchema, SessionEventRequestSchema } from "../../../packages/contracts/src/index.js";

const base = { slotId: "s1", submissionId: "x1", inputMode: "text" as const };

describe("raw answer canonicalisation", () => {
  it("keeps text exactly as typed (no trimming, no Unicode normalisation)", () => {
    const text = "  Caf\u00e9 \u2013 \u201cquoted\u201d\u00a0text \n";
    expect(JSON.parse(rawAnswerJson(toRawAnswer({ answer: text })))).toEqual({ schema_version: 1, kind: "text", text });
  });

  it("serialises with a fixed key order and preserves option order", () => {
    expect(rawAnswerJson(toRawAnswer({ answer: ["b", "a"] }))).toBe('{"schema_version":1,"kind":"options","optionIds":["b","a"]}');
    expect(rawAnswerJson(toRawAnswer({ idk: true }))).toBe('{"schema_version":1,"kind":"idk"}');
    expect(() => toRawAnswer({})).toThrow();
  });
});

describe("learning day in the session time zone", () => {
  it("uses Brisbane (UTC+10, no DST) rather than UTC", () => {
    expect(localDateIn("Australia/Brisbane", new Date("2026-10-28T13:59:59Z"))).toBe("2026-10-28");
    expect(localDateIn("Australia/Brisbane", new Date("2026-10-28T14:00:00Z"))).toBe("2026-10-29");
    expect(localDateIn("UTC", new Date("2026-10-28T14:00:00Z"))).toBe("2026-10-28");
  });

  it("rejects an unknown zone instead of guessing", () => {
    expect(() => localDateIn("Mars/Olympus", new Date())).toThrow(RangeError);
  });
});

describe("unaided independence (spec/04)", () => {
  it.each([
    [{ firstAttempt: true, hintsBefore: 0, answerSeenBefore: false }, true],
    [{ firstAttempt: true, hintsBefore: 1, answerSeenBefore: false }, false],
    [{ firstAttempt: true, hintsBefore: 0, answerSeenBefore: true }, false],
    [{ firstAttempt: false, hintsBefore: 0, answerSeenBefore: false }, false],
  ])("%j -> %s", (facts, want) => {
    expect(isIndependent(facts)).toBe(want);
    expect(isAssisted(facts)).toBe(facts.hintsBefore > 0 || facts.answerSeenBefore);
  });
});

describe("replay detection", () => {
  const stored = { slot_id: "s1", raw_answer_json: '{"schema_version":1,"kind":"options","optionIds":["a"]}', input_mode: "text", transcript_id: null, idk: 0 };
  it("same payload is a replay; any difference is a conflict", () => {
    expect(sameSubmission(stored, { ...base, answer: ["a"] })).toBe(true);
    expect(sameSubmission(stored, { ...base, answer: ["b"] })).toBe(false);
    expect(sameSubmission(stored, { ...base, answer: ["a"], slotId: "s2" })).toBe(false);
    expect(sameSubmission(stored, { ...base, idk: true })).toBe(false);
    expect(sameSubmission(stored, { ...base, answer: ["a"], inputMode: "voice", transcriptId: "t" })).toBe(false);
  });
});

describe("request contracts", () => {
  it("accepts exactly one of answer / idk and rejects client-supplied evidence flags", () => {
    expect(AttemptRequestSchema.safeParse({ ...base, answer: "x" }).success).toBe(true);
    expect(AttemptRequestSchema.safeParse({ ...base, idk: true }).success).toBe(true);
    expect(AttemptRequestSchema.safeParse({ ...base, idk: true, answer: "x" }).success).toBe(false);
    expect(AttemptRequestSchema.safeParse({ ...base }).success).toBe(false);
    expect(AttemptRequestSchema.safeParse({ ...base, answer: "x", firstAttempt: true }).success).toBe(false);
    expect(AttemptRequestSchema.safeParse({ ...base, answer: "x".repeat(2001) }).success).toBe(false);
    expect(AttemptRequestSchema.safeParse({ ...base, answer: "x".repeat(2000) }).success).toBe(true);
  });

  it("voice needs a text answer and a transcript id", () => {
    expect(AttemptRequestSchema.safeParse({ ...base, inputMode: "voice", answer: "x", transcriptId: "t" }).success).toBe(true);
    expect(AttemptRequestSchema.safeParse({ ...base, inputMode: "voice", answer: ["a"], transcriptId: "t" }).success).toBe(false);
    expect(AttemptRequestSchema.safeParse({ ...base, inputMode: "voice", answer: "x" }).success).toBe(false);
  });

  it("session events accept only hint / reveal_answer / skip / continue", () => {
    for (const type of ["hint", "reveal_answer", "skip", "continue"]) expect(SessionEventRequestSchema.safeParse({ slotId: "s", type, clientEventId: "c" }).success).toBe(true);
    for (const type of ["reveal", "finish", "resume", "replacement", "show_answer"]) expect(SessionEventRequestSchema.safeParse({ slotId: "s", type, clientEventId: "c" }).success).toBe(false);
  });
});

describe("default assessor never invents correctness", () => {
  const ctx = { idk: false } as Parameters<typeof PendingAssessor.assess>[0];
  it("pending for answers, confirmed idk only for an explicit I don't know", () => {
    expect(PendingAssessor.assess(ctx)).toMatchObject({ verdict: "pending", confirmation: "tentative" });
    expect(PendingAssessor.assess({ ...ctx, idk: true })).toMatchObject({ verdict: "idk", confirmation: "confirmed" });
  });
});
