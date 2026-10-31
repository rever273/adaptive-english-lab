import { describe, expect, it } from "vitest";
import { ClosedFormAssessor, NO_MISTAKE_ID, nearMatch, normalizeAnswerText } from "../../../apps/server/src/domain/content/grader.js";
import type { AssessContext } from "../../../apps/server/src/domain/attempts/ports.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { fixture, type FixtureName } from "../../fixtures/exercises/load.js";

const ctx = (name: FixtureName, rawAnswer: unknown, o: Partial<AssessContext> = {}): AssessContext => {
  const c = fixture(name);
  return {
    attemptId: "a1",
    slotId: "s1",
    sessionId: "x",
    purpose: "practice",
    exerciseRevisionId: "r1",
    exerciseType: c.type,
    content: c,
    questionId: null,
    rawAnswer,
    inputMode: "text",
    idk: false,
    firstAttempt: true,
    hintsBefore: 0,
    answerSeenBefore: false,
    criterionVersion: "rubric-v1",
    ...o,
  };
};
const options = (...optionIds: string[]) => ({ schema_version: 1, kind: "options", optionIds });
const text = (t: string) => ({ schema_version: 1, kind: "text", text: t });
const assess = (name: FixtureName, raw: unknown, o: Partial<AssessContext> = {}) => ClosedFormAssessor.assess(ctx(name, raw, o));
const shapeError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("ANSWER_SHAPE_INVALID");
    return;
  }
  throw new Error("expected ANSWER_SHAPE_INVALID");
};

describe("closed-form grading is exact and confirmed", () => {
  it("choose_form / choose_missing_fragment: exact set equality, order irrelevant", () => {
    expect(assess("choose_form", options("a"))).toMatchObject({ verdict: "correct", confirmation: "confirmed", source: "deterministic" });
    expect(assess("choose_form", options("b"))).toMatchObject({ verdict: "incorrect", confirmation: "confirmed" });
    expect(assess("choose_form", options("a", "b"))).toMatchObject({ verdict: "incorrect" }); // extra option
    expect(assess("choose_form", options("zzz"))).toMatchObject({ verdict: "incorrect" });
    expect(assess("choose_missing_fragment", options("a"))).toMatchObject({ verdict: "correct" });
  });

  it("multiple accepted options compare as a set", () => {
    const c = fixture("choose_form");
    c.payload.multiple = true;
    c.payload.accepted_option_ids = ["a", "b"];
    const base = ctx("choose_form", options("b", "a"), { content: c });
    expect(ClosedFormAssessor.assess(base)).toMatchObject({ verdict: "correct" });
    expect(ClosedFormAssessor.assess({ ...base, rawAnswer: options("a") })).toMatchObject({ verdict: "incorrect" });
  });

  it("detect_error: the faulty segment, or No mistake - a distinct action from IDK", () => {
    expect(assess("detect_error", options("s2"))).toMatchObject({ verdict: "correct" });
    expect(assess("detect_error", options("s1"))).toMatchObject({ verdict: "incorrect" });
    expect(assess("detect_error", options(NO_MISTAKE_ID))).toMatchObject({ verdict: "incorrect", rationale: expect.stringContaining("does contain a mistake") });
    expect(assess("detect_error_no_mistake", options(NO_MISTAKE_ID))).toMatchObject({ verdict: "correct", confirmation: "confirmed" });
    expect(assess("detect_error_no_mistake", options("s2"))).toMatchObject({ verdict: "incorrect" });
    shapeError(() => assess("detect_error", options(NO_MISTAKE_ID, "s2")));
  });

  it("reading: each child question is graded on its own accepted options", () => {
    expect(assess("context_reading", options("a"), { questionId: "q1" })).toMatchObject({ verdict: "correct" });
    expect(assess("context_reading", options("b"), { questionId: "q1" })).toMatchObject({ verdict: "incorrect" });
    expect(assess("context_reading", options("a"), { questionId: "q2" })).toMatchObject({ verdict: "correct" });
    shapeError(() => assess("context_reading", options("a"), { questionId: "nope" }));
  });
});

describe("free text: exact approved alternative or pending - never wrong by code", () => {
  it("accepts an exact approved alternative, tolerant only of letter case, whitespace, typography and terminal punctuation", () => {
    for (const ok of ["The employee stopped checking emails after the shift.", "  The employee  stopped checking emails after the shift ", "The employee stopped checking email after work!"]) {
      expect(assess("guided_short_answer", text(ok))).toMatchObject({ verdict: "correct", confirmation: "confirmed" });
    }
    expect(assess("russian_to_english_short", text("Could you tell me what time the library closes?"))).toMatchObject({ verdict: "correct" });
  });

  it("anything else is pending with a queue descriptor, not incorrect", () => {
    for (const other of ["The employee stopped to check emails after the shift.", "The employee stopped checking emails."]) {
      const r = assess("guided_short_answer", text(other));
      expect(r).toMatchObject({ verdict: "pending", confirmation: "tentative", source: "deterministic" });
      expect(r.outbox).toMatchObject({ kind: "free_text_analysis" });
    }
  });

  it("ignores letter case (D62) but is never fuzzy", () => {
    expect(assess("guided_short_answer", text("the employee stopped checking emails after the shift")).verdict).toBe("correct");
    expect(assess("guided_short_answer", text("THE EMPLOYEE STOPPED CHECKING EMAILS AFTER THE SHIFT")).verdict).toBe("correct");
    expect(assess("guided_short_answer", text("The employee stopped checking emails after the shifts.")).verdict).toBe("pending");
  });

  it("an exercise without approved alternatives is always pending", () => {
    const c = fixture("guided_short_answer");
    c.payload.accepted_answers = [];
    expect(ClosedFormAssessor.assess(ctx("guided_short_answer", text("anything"), { content: c }))).toMatchObject({ verdict: "pending" });
  });

  it("D64 near match: only a different NAME or NUMBER, everything else word for word, is confirmed for the construction", () => {
    const melb = ["They are thinking of moving to Melbourne."];
    const m = nearMatch("They are thinking of moving to Brisbane.", melb, ["thinking of moving"]);
    expect(m).toMatchObject({ approved: melb[0], expected: ["Melbourne"] });
    expect(m!.tokens.filter((t) => t.differs).map((t) => t.text)).toEqual(["Brisbane"]);
    expect(nearMatch("They are thinking of moving to brisbane", melb)).toBeNull(); // not written as a name
    expect(nearMatch("They are thinking of move to Melbourne", melb)).toBeNull(); // the construction itself differs
    expect(nearMatch("They are thinking about moving to Sydney", melb)).toBeNull(); // two words differ, one is not a name
    expect(nearMatch("They are thinking of moving to Perth soon", melb)).toBeNull(); // different length
    expect(nearMatch("We left in 2019.", ["We left in 2021."])).toMatchObject({ expected: ["2021"] });
    expect(nearMatch("Anna is thinking of moving to Melbourne", ["Tom is thinking of moving to Melbourne"])).toBeNull(); // the first word is not proof of a name
    const c = fixture("guided_short_answer");
    c.payload.accepted_answers = melb;
    expect(ClosedFormAssessor.assess(ctx("guided_short_answer", text("They are thinking of moving to Brisbane."), { content: c }))).toMatchObject({ verdict: "correct", confirmation: "confirmed", source: "deterministic" });
    expect(ClosedFormAssessor.assess(ctx("guided_short_answer", text("They are thinking of move to Melbourne."), { content: c }))).toMatchObject({ verdict: "pending" });
  });

  it("normalisation keeps negation, numbers and articles", () => {
    expect(normalizeAnswerText("  It’s  “fine” – isn't it?! ")).toBe('It\'s "fine" - isn\'t it');
    expect(normalizeAnswerText("They did not go.")).not.toBe(normalizeAnswerText("They did go."));
    expect(normalizeAnswerText("a car")).not.toBe(normalizeAnswerText("the car"));
  });
});

describe("IDK and malformed answers", () => {
  it("IDK is a confirmed failure outcome for every format", () => {
    for (const name of ["choose_form", "detect_error", "guided_short_answer", "context_reading"] as const) {
      expect(ClosedFormAssessor.assess(ctx(name, { schema_version: 1, kind: "idk" }, { idk: true, questionId: "q1" }))).toMatchObject({ verdict: "idk", confirmation: "confirmed" });
    }
  });

  it("the wrong answer shape for a format is a 422, not a verdict", () => {
    shapeError(() => assess("choose_form", text("published")));
    shapeError(() => assess("guided_short_answer", options("a")));
    shapeError(() => assess("detect_error", text("s2")));
  });
});

describe("D65 contraction equivalence", () => {
  const withAccepted = (accepted: string[]) => {
    const c = fixture("guided_short_answer");
    c.payload.accepted_answers = accepted;
    return ctx("guided_short_answer", text(""), { content: c });
  };
  const grade = (accepted: string[], answer: string) => ClosedFormAssessor.assess({ ...withAccepted(accepted), rawAnswer: text(answer) });

  it("a contraction equals its full form in both directions, case and quotes ignored", () => {
    expect(grade(["I am not going to the meeting."], "I’m not going to the meeting.")).toMatchObject({ verdict: "correct", confirmation: "confirmed", source: "deterministic" });
    expect(grade(["They don't know the answer."], "They do not know the answer")).toMatchObject({ verdict: "correct", confirmation: "confirmed" });
    expect(grade(["She cannot attend."], "She can't attend.")).toMatchObject({ verdict: "correct" });
    expect(grade(["We won't be late."], "We will not be late.")).toMatchObject({ verdict: "correct" });
  });

  it("negation stays significant: a contraction never matches the positive form", () => {
    expect(grade(["They do not know the answer."], "They do know the answer.")).toMatchObject({ verdict: "pending" });
    expect(grade(["They do know the answer."], "They don't know the answer.")).toMatchObject({ verdict: "pending" });
    expect(grade(["She can attend."], "She can't attend.")).toMatchObject({ verdict: "pending" });
  });

  it("'s and 'd are not expanded; other words stay significant", () => {
    expect(grade(["He is ready."], "He's ready.")).toMatchObject({ verdict: "pending" });
    expect(grade(["I would go."], "I'd go.")).toMatchObject({ verdict: "pending" });
    expect(grade(["I am not going."], "I'm not going to.")).toMatchObject({ verdict: "pending" });
  });
});
