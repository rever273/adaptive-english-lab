import type { FeedbackResponse } from "@english-lab/contracts";

type FeedbackSound = "correct" | "incorrect";

/** Only an actual, decided assessment gets a sound; a detail mismatch is not a clear result. */
export function feedbackSound(feedback: Pick<FeedbackResponse, "state" | "verdict" | "confirmation" | "aiChecked" | "unresolved" | "aiReview" | "detail">): FeedbackSound | null {
  if (feedback.unresolved || feedback.detail || feedback.state === "closed" || feedback.state === "skipped") return null;
  if (feedback.aiReview?.judgement === "ambiguous" || feedback.aiReview?.judgement === "abstain") return null;
  if (!(feedback.state === "confirmed" && feedback.confirmation === "confirmed") && !feedback.aiChecked) return null;
  return feedback.verdict === "correct" ? "correct" : feedback.verdict === "incorrect" ? "incorrect" : null;
}

export type GameSound = "shoot" | "explode" | "fail";

const VOLUME: Record<FeedbackSound | "complete" | GameSound, number> = { correct: 0.175, incorrect: 0.175, complete: 0.175, shoot: 0.12, explode: 0.2, fail: 0.2 };

/** Sound is optional: browser autoplay restrictions or disabled audio must never interrupt practice. */
export function playPracticeSound(kind: FeedbackSound | "complete" | GameSound, enabled = true, volume?: number): void {
  if (!enabled) return;
  try {
    const audio = new Audio(`/sounds/${kind}.wav`);
    audio.volume = volume ?? VOLUME[kind];
    void audio.play().catch(() => {});
  } catch {
    // The answer and session still work if audio is unavailable.
  }
}
