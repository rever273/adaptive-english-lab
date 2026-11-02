import { afterEach, describe, expect, it, vi } from "vitest";
import { feedbackSound, playPracticeSound } from "../../../apps/web/src/practiceSounds.js";

const confirmed = { state: "confirmed", confirmation: "confirmed", verdict: "correct" } as const;

describe("practice sounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sounds for decided correct and incorrect answers, including a decided model review", () => {
    expect(feedbackSound(confirmed)).toBe("correct");
    expect(feedbackSound({ ...confirmed, verdict: "incorrect" })).toBe("incorrect");
    expect(feedbackSound({ state: "pending", confirmation: "tentative", verdict: "incorrect", aiChecked: true })).toBe("incorrect");
  });

  it("stays silent for ambiguous, unresolved, closed, skipped, IDK and partial answers", () => {
    expect(feedbackSound({ state: "pending", confirmation: "tentative", verdict: "pending" })).toBeNull();
    expect(feedbackSound({ state: "pending", confirmation: "tentative", verdict: "ambiguous", unresolved: true })).toBeNull();
    expect(feedbackSound({ ...confirmed, aiReview: { judgement: "ambiguous", explanation_ru: "", findings: [] } })).toBeNull();
    expect(feedbackSound({ ...confirmed, state: "closed" })).toBeNull();
    expect(feedbackSound({ ...confirmed, state: "skipped" })).toBeNull();
    expect(feedbackSound({ ...confirmed, verdict: "idk" })).toBeNull();
    expect(feedbackSound({ ...confirmed, detail: { approved: "", tokens: [], expected: [] } })).toBeNull();
  });

  it("plays the requested local file and tolerates a blocked browser", async () => {
    const play = vi.fn().mockRejectedValue(new Error("autoplay blocked"));
    const audio = vi.fn(function (this: { volume: number; play: typeof play }) { this.volume = 1; this.play = play; });
    vi.stubGlobal("Audio", audio);
    expect(() => playPracticeSound("complete")).not.toThrow();
    expect(audio).toHaveBeenCalledWith("/sounds/complete.wav");
    expect(play).toHaveBeenCalledOnce();
    expect(audio.mock.instances[0]!.volume).toBe(0.175);
    playPracticeSound("incorrect", false);
    expect(audio).toHaveBeenCalledOnce();
    await Promise.resolve();
  });
});
