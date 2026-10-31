import { describe, expect, it } from "vitest";
import { difficultyLevels } from "../../../packages/contracts/src/index.js";
import { AUTO_ADVANCE_MS, diagnosticFinished, noSpeechLeft, shouldAutoAdvance, shouldPreloadSpeech, unconfirmedLabel } from "../../../apps/web/src/practiceFlow.js";

type Slot = Parameters<typeof shouldPreloadSpeech>[0][number];
const slot = (format: string, inputPreference: "text" | "voice", state: Slot["state"] = "unrevealed"): Slot => ({ format, inputPreference, state });
const typed = slot("choose_form", "text");
const voice = (state: Slot["state"] = "unrevealed") => slot("guided_short_answer", "voice", state);

const correct = { state: "confirmed", verdict: "correct", confirmation: "confirmed" } as const;
const plain = { hintUsed: false, vocabulary: false };

describe("T2 auto-advance after a correct answer", () => {
  it("advances only for a plainly correct, confirmed answer", () => {
    expect(shouldAutoAdvance(correct, plain)).toBe(true);
    expect(AUTO_ADVANCE_MS).toBeLessThanOrEqual(1000);
  });
  it("keeps Continue whenever there is something to read", () => {
    expect(shouldAutoAdvance({ ...correct, verdict: "incorrect" }, plain)).toBe(false);
    expect(shouldAutoAdvance({ ...correct, verdict: "idk" }, plain)).toBe(false);
    expect(shouldAutoAdvance({ state: "pending", verdict: "pending", confirmation: "tentative" }, plain)).toBe(false);
    expect(shouldAutoAdvance({ state: "pending", verdict: "correct", confirmation: "tentative" }, plain)).toBe(false);
    expect(shouldAutoAdvance({ state: "closed", verdict: null, confirmation: null }, plain)).toBe(false);
    expect(shouldAutoAdvance({ state: "skipped", verdict: null, confirmation: null }, plain)).toBe(false);
    expect(shouldAutoAdvance({ ...correct, detail: { approved: "x", tokens: [], expected: [] } }, plain)).toBe(false);
    expect(shouldAutoAdvance(correct, { hintUsed: true, vocabulary: false })).toBe(false);
    expect(shouldAutoAdvance(correct, { hintUsed: false, vocabulary: true })).toBe(false);
  });
});

describe("T1 speech model preload", () => {
  it("loads at the start when the first exercise allows speaking", () => {
    expect(shouldPreloadSpeech([voice(), typed], 0)).toBe(true);
  });
  it("loads while the exercise before a voice one is open", () => {
    expect(shouldPreloadSpeech([typed, voice()], 0)).toBe(true);
    expect(shouldPreloadSpeech([typed, typed, voice()], 0)).toBe(false);
    expect(shouldPreloadSpeech([typed, typed, voice()], 1)).toBe(true);
  });
  it("does not load when no later exercise can use the microphone", () => {
    expect(shouldPreloadSpeech([voice("continued"), typed, typed], 1)).toBe(false);
    expect(shouldPreloadSpeech([typed, slot("guided_short_answer", "text")], 0)).toBe(false);
    expect(shouldPreloadSpeech([typed], -1)).toBe(false);
  });
});

describe("T3a when grading may start", () => {
  it("is true when every voice exercise is finished or skipped, or there is none", () => {
    expect(noSpeechLeft([typed, typed])).toBe(true);
    expect(noSpeechLeft([voice("continued"), typed])).toBe(true);
    expect(noSpeechLeft([voice("skipped"), typed])).toBe(true);
  });
  it("stays false while a voice exercise can still be reached (an answered one is not finished until Continue)", () => {
    expect(noSpeechLeft([typed, voice()])).toBe(false);
    expect(noSpeechLeft([voice("answered"), typed])).toBe(false);
  });
});

describe("T3b verdict text for an unconfirmed answer", () => {
  it("names the AI verdict and says it is not counted yet", () => {
    const base = { explanation_ru: "x", findings: [] };
    expect(unconfirmedLabel({ verdict: "correct", aiReview: { judgement: "acceptable", ...base } })).toBe("Looks correct (AI check) — not counted in your stats yet");
    expect(unconfirmedLabel({ verdict: "incorrect", aiReview: { judgement: "incorrect_candidate", ...base } })).toBe("Looks wrong (AI check) — not counted in your stats yet");
    expect(unconfirmedLabel({ verdict: "ambiguous", aiReview: { judgement: "ambiguous", ...base } })).toContain("could not decide");
    expect(unconfirmedLabel({ verdict: "pending" })).toBe("Waiting for the AI check — not counted in your stats yet");
    for (const f of [{ verdict: "correct" }, { verdict: "incorrect" }, { verdict: "pending" }]) expect(unconfirmedLabel(f)).toContain("not counted in your stats yet");
  });
});

describe("T5 diagnostic card", () => {
  it("is hidden only once every block is used", () => {
    expect(diagnosticFinished({ nextBlock: null, blocksUsed: 3, blocksTotal: 3 })).toBe(true);
    expect(diagnosticFinished({ nextBlock: 2, blocksUsed: 1, blocksTotal: 3 })).toBe(false);
    expect(diagnosticFinished({ nextBlock: 1, blocksUsed: 0, blocksTotal: 3 })).toBe(false);
  });
});

describe("T4 difficulty range", () => {
  it("unset or the whole range means no restriction", () => {
    expect(difficultyLevels({})).toBeNull();
    expect(difficultyLevels({ difficultyMin: "A2", difficultyMax: "C1" })).toBeNull();
  });
  it("returns the levels inside the range", () => {
    expect(difficultyLevels({ difficultyMin: "B2", difficultyMax: "C1" })).toEqual(["B2", "C1"]);
    expect(difficultyLevels({ difficultyMin: "B2" })).toEqual(["B2", "C1"]);
    expect(difficultyLevels({ difficultyMax: "B1" })).toEqual(["A2", "B1"]);
    expect(difficultyLevels({ difficultyMin: "C1", difficultyMax: "B1" })).toEqual(["B1", "B2", "C1"]);
  });
});
