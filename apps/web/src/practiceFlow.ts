import type { Dashboard, FeedbackResponse, SessionSnapshot } from "@english-lab/contracts";

/**
 * Small pure rules of the practice screen (TASK_021), kept out of the React component so they can be tested on their own.
 * Nothing here touches Mastery: it only decides what the screen does after something the server already decided.
 */

/** the written formats where the learner may type or speak (the microphone is offered for these only, never in vocabulary practice) */
export const isShortFormat = (format: string): boolean => format === "guided_short_answer" || format === "russian_to_english_short";

type SlotLike = Pick<SessionSnapshot["slots"][number], "format" | "state" | "inputPreference">;

/** an exercise the session offered for speaking ("type or speak"): a short written format with the voice preference */
const offersSpeech = (s: SlotLike): boolean => isShortFormat(s.format) && s.inputPreference === "voice";

/** can the microphone still be used for this exercise? An answered one counts as closed even if "Try again" could reopen it (its model is already loaded by then). */
const canStillSpeak = (s: SlotLike): boolean => offersSpeech(s) && s.state !== "answered" && s.state !== "skipped" && s.state !== "continued";

/** T1: load the speech model when the open exercise, or the one right after it, allows recording - so it is ready before the microphone is pressed */
export function shouldPreloadSpeech(slots: readonly SlotLike[], openSlotIndex: number): boolean {
  if (openSlotIndex < 0) return false;
  const open = slots[openSlotIndex];
  const next = slots[openSlotIndex + 1];
  return (open !== undefined && canStillSpeak(open)) || (next !== undefined && offersSpeech(next));
}

/** T3a: no exercise left in this session where the microphone could be used (every voice-capable one is skipped or finished) */
export function noSpeechLeft(slots: readonly SlotLike[]): boolean {
  return !slots.some((s) => offersSpeech(s) && s.state !== "skipped" && s.state !== "continued");
}

/**
 * T2 (revised): a correct answer no longer moves on by itself: the learner reads the whole result (explanation, rule, examples) and presses
 * Continue or Enter when ready. The decision stays in one place in case a timed advance is wanted again.
 */
export function shouldAutoAdvance(_feedback: Pick<FeedbackResponse, "state" | "verdict" | "confirmation" | "detail" | "vocabulary">, _opts: { hintUsed: boolean; vocabulary: boolean }): boolean {
  return false;
}
/** how long an answer waits for the local AI verdict before it is shown as "checked later" (seconds) */
export const AI_CHECK_WAIT_S = 45;
/** how long the "Correct" confirmation stays visible before the next exercise opens */
export const AUTO_ADVANCE_MS = 600;

/**
 * T3b / D65: what the review says about an answer the code could not judge. A decided AI verdict is stated plainly ("Correct / Incorrect (checked by AI)")
 * with the AI's reason; it counts provisionally, never as confirmed. No verdict (abstain, ambiguous, invalid, failed) is "could not be checked" and waits for review.
 */
export function unconfirmedLabel(f: Pick<FeedbackResponse, "verdict" | "aiReview"> & { aiChecked?: boolean; unresolved?: boolean }): string {
  const j = f.aiReview?.judgement;
  const decided = f.aiChecked ?? (j === "acceptable" || j === "incorrect_candidate");
  if (decided && (f.verdict === "correct" || f.verdict === "incorrect")) {
    const reason = f.aiReview?.explanation_ru?.trim();
    return `${f.verdict === "correct" ? "Correct" : "Incorrect"} (checked by AI)${reason ? ` — ${reason}` : ""}${f.verdict === "incorrect" ? " · counts in your stats after review" : ""}`;
  }
  if (f.unresolved || j === "ambiguous" || j === "abstain" || f.verdict === "ambiguous") return "Could not be checked automatically — it will be reviewed later";
  return "Waiting for the AI check";
}

/** T5: the starting diagnostic is finished (all its blocks used), so the block and its card are hidden; regular practice stays */
export const diagnosticFinished = (d: Pick<Dashboard["diagnostic"], "nextBlock" | "blocksUsed" | "blocksTotal">): boolean => d.nextBlock === null && d.blocksUsed >= d.blocksTotal;
