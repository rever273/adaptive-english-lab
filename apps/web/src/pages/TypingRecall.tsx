import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import * as api from "../api";
import type { TypingRecallWord } from "../api";
import { createRecall, isFinished, recallHint, recallKey, recallResults, recallReveal, wordPoints } from "../game/recallEngine";
import { playPracticeSound } from "../practiceSounds";
import { LAYOUT_HINT, Toast, useToast } from "./typingShared";

/** one word sits in the middle, two side by side, three form a triangle (two above, one below) */
const POSITIONS: Record<number, readonly string[]> = {
  1: ["recall-centre"],
  2: ["recall-left", "recall-right"],
  3: ["recall-top-left", "recall-top-right", "recall-bottom"],
};

/** a bright, twinkling star: nothing to shoot, it only carries the translation */
function Star({ done, active, index }: { done: boolean; active: boolean; index: number }) {
  return (
    <svg className={`recall-star${done ? " done" : ""}${active ? " active" : ""}`} viewBox="-50 -50 100 100" aria-hidden="true" style={{ animationDelay: `${index * 0.5}s` }}>
      <defs>
        <radialGradient id={`rs-${index}`}>
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor={done ? "#8dffc4" : "#ffe27a"} />
          <stop offset="100%" stopColor={done ? "#2ecf88" : "#ff9d2e"} />
        </radialGradient>
      </defs>
      <polygon className="recall-star-body" fill={`url(#rs-${index})`} points="0,-42 11,-14 41,-13 17,6 25,36 0,19 -25,36 -17,6 -41,-13 -11,-14" />
      <circle className="recall-spark s1" cx="-38" cy="-30" r="2.6" />
      <circle className="recall-spark s2" cx="40" cy="-24" r="2" />
      <circle className="recall-spark s3" cx="30" cy="38" r="2.4" />
    </svg>
  );
}

/**
 * The memory check after a Words level (bonus, optional): three saved words appear as stars with their Russian translation; the learner
 * types them from memory. Raw counts go to the server, which computes the points and remembers how each word went.
 */
export function TypingRecall({ sessionId, words, onDone }: { sessionId: string; words: TypingRecallWord[]; onDone: (bonus: { points: number } | null) => void }) {
  const stateRef = useRef(createRecall(words));
  const s = stateRef.current;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [layoutNotice, showLayoutNotice] = useToast();
  const [saved, setSaved] = useState<{ points: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const soundsRef = useRef(true);
  const savingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void api.fetchSettings().then((x) => { if (active) soundsRef.current = x.values.typingSoundsEnabled ?? true; }).catch(() => {});
    return () => { active = false; };
  }, []);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const r = await api.saveTypingRecall(sessionId, recallResults(stateRef.current));
      setSaved({ points: r.points });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the bonus.");
      savingRef.current = false;
    }
  }, [sessionId]);

  const afterKey = useCallback((r: { kind: string; finishedWord: boolean }) => {
    if (r.kind === "wrong") playPracticeSound("incorrect", soundsRef.current);
    else if (r.kind === "ok") playPracticeSound(r.finishedWord ? "explode" : "shoot", soundsRef.current);
    bump();
    if (isFinished(stateRef.current)) window.setTimeout(() => void save(), 600);
  }, [save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || saved) return;
      if (e.key === "F4") { e.preventDefault(); if (!e.repeat) afterKey(recallHint(stateRef.current)); return; }
      if (e.key === "F5") { e.preventDefault(); if (!e.repeat) afterKey(recallReveal(stateRef.current)); return; }
      if (e.key.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (/[Ѐ-ӿ]/.test(e.key)) { showLayoutNotice(); return; } // Russian layout: not a mistake
      afterKey(recallKey(stateRef.current, e.key));
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [afterKey, saved, showLayoutNotice]);

  return (
    <div className="recall" data-no-word>
      <div className="typing-game-bar">
        <span>Memory check · bonus</span>
        <span className="muted small">Type the English words for these translations. The first letter picks the star.</span>
        <span className="actions">
          <button className="btn" onClick={() => onDone(null)} disabled={savingRef.current}>Skip</button>
        </span>
      </div>
      <div className="recall-stage">
        {s.words.map((w, i) => (
          <div key={w.entryId} className={`recall-slot ${(POSITIONS[s.words.length] ?? POSITIONS[3]!)[i] ?? "recall-bottom"}${s.active === i ? " active" : ""}${w.done ? " done" : ""}`}>
            <Star done={w.done} active={s.active === i} index={i} />
            <p className="recall-translation" lang="ru">{w.translationRu}</p>
            {w.sentence && <p className="recall-sentence">{w.sentence}</p>}
            <p className="recall-letters" aria-label={w.done ? w.lemma : `${w.lemma.length} letters`}>
              {w.lemma.split("").map((ch, k) => (
                <span key={k} className={k < w.filled ? (w.kinds[k] === "hinted" ? "hinted" : "typed") : "blank"}>{k < w.filled ? ch : "_"}</span>
              ))}
            </p>
            {w.done && <p className="muted small recall-points">{w.revealed ? "shown" : `+${wordPoints(w)}`}</p>}
          </div>
        ))}
        {layoutNotice && <Toast text={LAYOUT_HINT} />}
      </div>
      <p className="muted small">F4: the next letter (costs points) · F5: show the word (no points). Wrong keys only cost a little; you can try as long as you like.</p>
      {saved && (
        <div className="recall-done" role="status">
          <strong>Bonus: +{saved.points} points</strong>
          <button className="btn btn-primary" onClick={() => onDone(saved)} autoFocus>Continue</button>
        </div>
      )}
      {error && <p role="alert" className="notice notice-warning small">{error} <button className="btn" onClick={() => { setError(null); void save(); }}>Retry</button></p>}
    </div>
  );
}
