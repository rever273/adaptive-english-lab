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
 * T2: after Enter, a plainly correct answer needs no Continue click. Anything the learner must read keeps the button: a mistake, a detail slip,
 * an unconfirmed/pending verdict, a closed (diagnostic) result, a hint or shown answer, and every vocabulary result (its sentence and translation are the point).
 */
export function shouldAutoAdvance(feedback: Pick<FeedbackResponse, "state" | "verdict" | "confirmation" | "detail" | "vocabulary">, opts: { hintUsed: boolean; vocabulary: boolean }): boolean {
  if (opts.hintUsed || opts.vocabulary) return false;
  return feedback.state === "confirmed" && feedback.verdict === "correct" && feedback.confirmation === "confirmed" && !feedback.detail && !feedback.vocabulary;
}
/** how long the "Correct" confirmation stays visible before the next exercise opens */
export const AUTO_ADVANCE_MS = 600;

/** T3b: what the review says about an answer the code could not judge; always "not counted yet", and the AI's own opinion only as an opinion */
export function unconfirmedLabel(f: Pick<FeedbackResponse, "verdict" | "aiReview">): string {
  const j = f.aiReview?.judgement;
  if (j === "acceptable" || (j === undefined && f.verdict === "correct")) return "Looks correct (AI check) — not counted in your stats yet";
  if (j === "incorrect_candidate" || (j === undefined && f.verdict === "incorrect")) return "Looks wrong (AI check) — not counted in your stats yet";
  if (j === "ambiguous" || j === "abstain" || f.verdict === "ambiguous") return "The AI check could not decide — not counted in your stats yet";
  return "Waiting for the AI check — not counted in your stats yet";
}

/** T5: the starting diagnostic is finished (all its blocks used), so the block and its card are hidden; regular practice stays */
export const diagnosticFinished = (d: Pick<Dashboard["diagnostic"], "nextBlock" | "blocksUsed" | "blocksTotal">): boolean => d.nextBlock === null && d.blocksUsed >= d.blocksTotal;
