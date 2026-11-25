import { describe, expect, it } from "vitest";
import { addDays, stateTimeline, summarise, wordState, type VtFact, type VtFactKind } from "../../../apps/server/src/domain/vocabTyping/state.js";

const facts = (...kinds: VtFactKind[]): VtFact[] => kinds.map((kind, i) => ({ kind, at: `2026-11-0${1 + i}T10:00:00.000Z`, date: `2026-11-0${1 + i}` }));

describe("vocabulary typing word state", () => {
  it("starts unscreened and follows the screening result", () => {
    expect(wordState([])).toBe("unscreened");
    expect(wordState(facts("screen_known"))).toBe("known_screening");
    expect(wordState(facts("screen_unknown"))).toBe("learning");
    expect(wordState(facts("screen_not_useful"))).toBe("excluded_by_learner");
  });

  it("a self-assessed Learned only awaits verification; a passed check verifies", () => {
    expect(wordState(facts("screen_unknown", "learn_exposure", "learn_learned"))).toBe("awaiting_verification");
    expect(wordState(facts("screen_unknown", "learn_learned", "review_good"))).toBe("verified");
  });

  it("a failed check returns the word to learning and the history is kept", () => {
    const f = facts("screen_unknown", "learn_learned", "review_good", "review_again", "learn_learned", "review_good");
    expect(stateTimeline(f).map((t) => t.state)).toEqual(["learning", "awaiting_verification", "verified", "learning", "awaiting_verification", "verified"]);
    const s = summarise(f);
    expect(s).toMatchObject({ state: "verified", lapses: 1, checksPassed: 2, checksFailed: 1, originalScreen: "unknown" });
  });

  it("a skipped check changes nothing and a known word stays known", () => {
    expect(wordState(facts("screen_unknown", "learn_learned", "review_skipped"))).toBe("awaiting_verification");
    expect(wordState(facts("screen_known", "learn_learned", "review_good"))).toBe("known_screening");
  });

  it("restoring an excluded word makes it unscreened again, and only then", () => {
    expect(wordState(facts("screen_not_useful", "restore"))).toBe("unscreened");
    expect(wordState(facts("screen_known", "restore"))).toBe("known_screening");
    const s = summarise(facts("screen_not_useful", "restore", "screen_unknown"));
    expect(s.state).toBe("learning");
    expect(s.originalScreen).toBe("unknown");
  });

  it("remembers the original screening result after the word is learned", () => {
    expect(summarise(facts("screen_unknown", "learn_learned", "review_good")).originalScreen).toBe("unknown");
    expect(summarise(facts("screen_unknown", "learn_learned")).lastLearnedDate).toBe("2026-11-02");
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 7)).toBe("2027-01-07");
  });
});
