import type { FeedbackResponse } from "@english-lab/contracts";

type FeedbackSound = "correct" | "incorrect";

/** Only an actual, decided assessment gets a sound; a detail mismatch is not a clear result. */
export function feedbackSound(feedback: Pick<FeedbackResponse, "state" | "verdict" | "confirmation" | "aiChecked" | "unresolved" | "aiReview" | "detail">): FeedbackSound | null {
  if (feedback.unresolved || feedback.detail || feedback.state === "closed" || feedback.state === "skipped") return null;
  if (feedback.aiReview?.judgement === "ambiguous" || feedback.aiReview?.judgement === "abstain") return null;
  if (!(feedback.state === "confirmed" && feedback.confirmation === "confirmed") && !feedback.aiChecked) return null;
  return feedback.verdict === "correct" ? "correct" : feedback.verdict === "incorrect" ? "incorrect" : null;
}

/** Sound is optional: browser autoplay restrictions or disabled audio must never interrupt practice. */
export function playPracticeSound(kind: FeedbackSound | "complete", enabled = true): void {
  if (!enabled) return;
  try {
    const audio = new Audio(`/sounds/${kind}.wav`);
    audio.volume = 0.175;
    void audio.play().catch(() => {});
  } catch {
    // The answer and session still work if audio is unavailable.
  }
}
