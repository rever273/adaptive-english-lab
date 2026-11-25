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
/** the daily practice goal reached (only the daily goal notice uses it) */
export type GoalSound = "goal";

const VOLUME: Record<FeedbackSound | "complete" | GameSound | GoalSound, number> = { correct: 0.175, incorrect: 0.175, complete: 0.175, shoot: 0.12, explode: 0.2, fail: 0.2, goal: 0.22 };

type Kind = FeedbackSound | "complete" | GameSound | GoalSound;

// One shared AudioContext and decoded buffers: a new <audio> element per keystroke piles up while typing fast,
// and the browser then stalls all sounds for a few seconds.
let ctx: AudioContext | null | undefined;
const buffers = new Map<Kind, Promise<AudioBuffer | null>>();

function context(): AudioContext | null {
  if (ctx === undefined) {
    try { ctx = new AudioContext(); } catch { ctx = null; }
  }
  return ctx;
}

function buffer(c: AudioContext, kind: Kind): Promise<AudioBuffer | null> {
  let p = buffers.get(kind);
  if (!p) {
    p = fetch(`/sounds/${kind}.wav`).then((r) => r.arrayBuffer()).then((d) => c.decodeAudioData(d)).catch(() => null);
    buffers.set(kind, p);
  }
  return p;
}

/** Sound is optional: browser autoplay restrictions or disabled audio must never interrupt practice. */
/** `rate` above 1 raises the pitch (Grammar Cloze lifts it a little on a run of right answers) */
export function playPracticeSound(kind: Kind, enabled = true, volume?: number, rate = 1): void {
  if (!enabled) return;
  const gainValue = volume ?? VOLUME[kind];
  try {
    const c = context();
    if (c) {
      if (c.state === "suspended") void c.resume().catch(() => {});
      void buffer(c, kind).then((b) => {
        if (!b) return;
        const src = c.createBufferSource();
        const gain = c.createGain();
        gain.gain.value = gainValue;
        src.buffer = b;
        src.playbackRate.value = rate;
        src.connect(gain).connect(c.destination);
        src.start();
      }).catch(() => {});
      return;
    }
    const audio = new Audio(`/sounds/${kind}.wav`);
    audio.volume = gainValue;
    void audio.play().catch(() => {});
  } catch {
    // The answer and session still work if audio is unavailable.
  }
}
