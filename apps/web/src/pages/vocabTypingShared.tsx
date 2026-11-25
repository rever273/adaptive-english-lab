import { useCallback, useEffect, useRef } from "react";
import type { VtEstimateView } from "@english-lab/contracts";
import * as api from "../api";
import type { TyperState } from "../game/vocabTypeEngine";
import { playPracticeSound } from "../practiceSounds";

export const errorText = (e: unknown): string => (e instanceof api.ApiRequestError ? e.message : "Something went wrong.");

export const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

export function Stat({ label, value, tip }: { label: string; value: string; tip: string }) {
  return <div className="stat typing-stat" tabIndex={0} role="group" aria-label={`${label}: ${value}. ${tip.replace(/\n/g, " ")}`} data-tip={tip}><span className="stat-num">{value}</span><span className="stat-label">{label}</span></div>;
}

export const VT_TIPS = {
  wpm: "Words per minute: correct characters ÷ 5, per minute of active typing time. Time spent deciding is not counted.\nСлов в минуту по активному времени набора; время на размышление не считается.",
  accuracy: "Share of keystrokes that were correct.\nДоля верных нажатий клавиш.",
  errors: "Wrong keys pressed. A wrong key does not erase anything.\nКоличество неверных нажатий.",
  time: "Active typing time, without the time spent deciding.\nАктивное время набора, без времени на решение.",
} as const;

export const estimateText = (e: VtEstimateView | null): string => {
  if (!e) return "—";
  if (e.value === null) return `Need more screening (${e.screened} / 100 words)`;
  return `≈ ${e.value.toLocaleString("en-US")} words (${(e.low ?? e.value).toLocaleString("en-US")}–${(e.high ?? e.value).toLocaleString("en-US")})`;
};

/** plays a clip and resolves when it has finished (or failed) */
export async function playBlob(blob: Blob | null): Promise<void> {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const done = new Promise<void>((resolve) => {
    audio.addEventListener("ended", () => resolve(), { once: true });
    audio.addEventListener("error", () => resolve(), { once: true });
    audio.addEventListener("pause", () => resolve(), { once: true });
  });
  try {
    await audio.play();
    await done;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** the word through ElevenLabs (D170): silent when it is switched off, blocked or fails */
export async function speakWord(word: string): Promise<void> {
  try {
    await playBlob(await api.vocabularyTextSpeech(word));
  } catch {
    /* the word has no sound this time */
  }
}

/** the word only if its clip is already stored: automatic playback must never spend ElevenLabs credits */
export async function speakWordIfCached(word: string): Promise<void> {
  try {
    await playBlob(await api.vocabularyCachedSpeech(word));
  } catch {
    /* no sound this time */
  }
}

/** the typing sounds of Key Builder (a soft key click, a buzz on a wrong key), following the same Settings switch */
export function useTypingSounds(): (result: "ok" | "error") => void {
  const enabled = useRef(true);
  useEffect(() => {
    let alive = true;
    void api.fetchSettings().then((s) => { if (alive) enabled.current = s.values.typingSoundsEnabled ?? true; }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return useCallback((result) => {
    if (result === "error") playPracticeSound("incorrect", enabled.current);
    else playPracticeSound("shoot", enabled.current, 0.05);
  }, []);
}

/** the sentence through local Piper */
export async function speakSentence(text: string): Promise<void> {
  try {
    await playBlob(await api.fetchBookSpeech({ text }));
  } catch {
    /* the sentence has no sound this time */
  }
}

/** keeps one stable client event id per card, so a retried decision is the same event (D168 idempotency) */
export function useEventId(key: string): () => string {
  const ref = useRef<{ key: string; id: string }>({ key, id: crypto.randomUUID() });
  if (ref.current.key !== key) ref.current = { key, id: crypto.randomUUID() };
  return () => ref.current.id;
}

/**
 * The text being typed, drawn like Key Builder (`keys-*` classes): typed letters fade, letters typed after a wrong key stay red, the cursor is underlined
 * and the frame turns red on a wrong key. `mark` highlights the target form of a sentence.
 */
export function TypedText({ typer, mark, large }: { typer: TyperState; mark?: { start: number; length: number } | null; large?: boolean }) {
  const chars = [...typer.target];
  const missed = new Set(typer.missed);
  return (
    <div className={`keys-text vt-keys${large ? " vt-keys-large" : ""}${typer.wrong ? " wrong" : ""}`} aria-label={typer.target} data-testid="vt-text">
      <span className="keys-word">
        {chars.map((c, i) => {
          const inTarget = mark ? i >= mark.start && i < mark.start + mark.length : false;
          const cls = `keys-char${i === typer.pos ? " cursor" : ""}${i < typer.pos ? (missed.has(i) ? " typed missed" : " typed") : ""}${inTarget ? " vt-target" : ""}`;
          return <span key={i} className={cls}>{c}</span>;
        })}
      </span>
    </div>
  );
}

/** calls `fn` once when `cond` becomes true */
export function useOnce(cond: boolean, fn: () => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (cond && !done.current) {
      done.current = true;
      fn();
    }
  });
}
