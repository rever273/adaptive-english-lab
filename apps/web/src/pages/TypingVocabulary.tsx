import { useCallback, useEffect, useRef, useState } from "react";
import type { VtEstimateView, VtOverview, VtScreeningCard, VtSessionState, VtWordFacts } from "@english-lab/contracts";
import * as api from "../api";
import { Kbd, isTextField, useEnterContinue, useKeys } from "../components/hotkeys";
import { TypingKeyboard } from "../components/TypingKeyboard";
import { DailyGoalCheck } from "../components/DailyGoalNotice";
import { createTyper, keyStatsOf, mergePairs, typeKey, typingFacts, typingTarget, type KeyPair, type TyperState } from "../game/vocabTypeEngine";
import { useVocabTypingActivity } from "../vocabTypingActivity";
import { CYRILLIC, LAYOUT_HINT, Toast, useToast } from "./typingShared";
import { Stat, VT_TIPS, errorText, estimateText, fmtDuration, speakWord, speakWordIfCached, useEventId, useTypingSounds } from "./vocabTypingShared";

const LISTEN_KEY = "F4";

/** the fourth Typing card (TASK_038): two starts, live counters, a rough vocabulary size */
export function VocabTypingCard({ overview, onScreening, onLearning, error }: { overview: VtOverview | null; onScreening: () => void; onLearning: () => void; error: string | null }) {
  const o = overview;
  const learnedTotal = o ? o.learning.awaiting + o.learning.verified : 0;
  const learningPossible = o !== null && (o.learning.playable > 0 || o.learning.dueNow > 0);
  return (
    <div className="card typing-mode-card" data-testid="vocab-typing-card">
      <img className="typing-card-image" src="/typing/vocabulary.jpg" alt="" loading="lazy" />
      <h3><i className="pi pi-language" aria-hidden="true" /> Vocabulary</h3>
      <p className="muted small">Type new words and real example sentences. Screening finds out which words you already know; Learning teaches the rest in sentences and checks them later.</p>
      {o && o.prepared && (
        <>
          <p className="typing-level" data-testid="vocab-typing-screening">Screening <span className="muted">({o.screening.screened.toLocaleString("en-US")} / {o.poolSize.toLocaleString("en-US")} · {o.screening.known} known · {o.screening.unknown} to learn)</span></p>
          <p className="typing-level" data-testid="vocab-typing-learning">Learning <span className="muted">({o.learning.learning} learning · {learnedTotal} learned · {o.learning.dueNow} {o.learning.dueNow === 1 ? "check" : "checks"} due)</span></p>
          {o.estimate.value !== null && <p className="small" data-testid="vocab-typing-estimate">{estimateText(o.estimate)} known</p>}
        </>
      )}
      {o && !o.prepared && <p className="notice notice-warning small" role="status">The word ranks are missing. Run `npm run vtyping:prepare` once.</p>}
      {error && <p className="notice notice-warning small" role="alert">{error}</p>}
      <div className="typing-card-actions">
        <button className="btn btn-primary" disabled={!o || !o.prepared || o.screening.remaining === 0} onClick={onScreening} data-testid="vocab-typing-screening-start">Screening</button>
        <button className="btn btn-primary" disabled={!learningPossible} onClick={onLearning} data-testid="vocab-typing-learning-start" title={learningPossible ? undefined : "Screen some words first: the words you do not know are learned here."}>Learning</button>
      </div>
    </div>
  );
}

/** Stage 1: one word at a time; type it, then say whether you know it (Space), do not (Enter) or the word should be archived (Backspace or Delete) */
export function VocabScreening({ sessionId, tabId, initial, onNext, onDone, onDailyDone }: { sessionId: string; tabId: string; initial: VtSessionState; onNext: () => void; onDone: () => void; onDailyDone?: () => void }) {
  const [st, setSt] = useState<VtSessionState>(initial);
  const [typer, setTyperState] = useState<TyperState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const typerRef = useRef<TyperState | null>(null);
  const pairs = useRef<Record<string, KeyPair>>({});
  const busy = useRef(false);
  /** the words decided in this sitting, kept in the line (dimmed) so the row of words does not jump */
  const [history, setHistory] = useState<Array<{ lemma: string; kind: DecisionKind }>>([]);
  const [layoutNotice, showLayoutNotice] = useToast();
  const sound = useTypingSounds();
  const [undo, setUndo] = useState<{ lemma: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 4000);
    return () => window.clearTimeout(t);
  }, [undo]);
  const card = st.card?.kind === "screen" ? (st.card as VtScreeningCard) : null;
  const lemma = card?.word.lemma ?? "";
  const eventId = useEventId(`${sessionId}:${lemma}`);
  useVocabTypingActivity(sessionId, tabId, !st.finished);

  const setTyper = (t: TyperState | null) => {
    typerRef.current = t;
    setTyperState(t);
  };
  // a new word: a fresh text to type and its sound
  useEffect(() => {
    if (!lemma) {
      setTyper(null);
      return;
    }
    setTyper(createTyper(lemma));
    // only a clip that is already stored: screening shows many words and must not spend ElevenLabs credits (Listen, F4, still asks for it)
    if (st.settings.speakWord) void speakWordIfCached(lemma);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lemma]);

  const finishIfDone = useCallback(async (s: VtSessionState) => {
    if (!s.finished) return s;
    try {
      return await api.completeVocabSession(sessionId, { tabId, keyStats: keyStatsOf(pairs.current) });
    } catch {
      return s;
    }
  }, [sessionId, tabId]);

  const decide = async (kind: DecisionKind) => {
    const t = typerRef.current;
    // the typer of the PREVIOUS word may still be in the ref for a moment after the card changed
    if (!card || !t || t.target !== typingTarget(card.word.lemma) || busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const next = await api.sendVocabEvent(sessionId, { clientEventId: eventId(), tabId, kind, lemma: card.word.lemma, typing: typingFacts(t) });
      pairs.current = mergePairs(pairs.current, t.pairs);
      if (kind === "screen_archived") setUndo({ lemma: card.word.lemma });
      setHistory((h) => [...h, { lemma: card.word.lemma, kind }]);
      setSt(await finishIfDone(next));
    } catch (e) {
      if (e instanceof api.ApiRequestError && (e.code === "ALREADY_ANSWERED" || e.code === "EVENT_ID_CONFLICT")) {
        // the decision is already stored: continue from the server's state
        try {
          setSt(await api.fetchVocabSession(sessionId));
        } catch (e2) {
          setError(errorText(e2));
        }
      } else setError(errorText(e));
    } finally {
      busy.current = false;
    }
  };

  useKeys((e) => {
    if (st.finished || !card || e.isComposing) return;
    if (e.key === LISTEN_KEY && !e.repeat) {
      e.preventDefault();
      void speakWord(card.word.lemma);
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextField(e.target)) {
      // one action, any time on the card (the typing here never erases anything): the word is archived, not deleted (D184)
      e.preventDefault();
      void decide("screen_archived");
      return;
    }
    const t = typerRef.current;
    if (!t || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.done) {
      // the decision keys work only once the word is fully typed
      // Space (or Tab) = "I know it" (as skipping a word); the space is never part of a single word, so it cannot be typed by mistake mid-word
      if ((e.key === " " || e.key === "Tab") && !e.shiftKey) {
        if (e.target instanceof HTMLElement && e.target.closest("button, a")) return;
        e.preventDefault();
        void decide("screen_known");
      } else if (e.key === "Enter") {
        if (isTextField(e.target)) return;
        e.preventDefault();
        void decide("screen_unknown");
      }
      return;
    }
    if (isTextField(e.target)) return;
    // the Russian layout is not a typing mistake: a hint, nothing counted (as in the other typing modes)
    if (CYRILLIC.test(e.key)) {
      e.preventDefault();
      showLayoutNotice();
      return;
    }
    const r = typeKey(t, e.key, performance.now());
    if (r.result === "ignored") return;
    sound(r.result);
    // a space must not press a focused button
    e.preventDefault();
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
    setTyper(r.state);
  });

  const showResult = st.finished;
  const next = useCallback(() => onNext(), [onNext]);
  useEnterContinue(showResult ? next : null);

  if (showResult) return <><DailyGoalCheck mode="vocabTyping" /><ScreeningResult state={st} onNext={next} onDone={onDone} {...(onDailyDone ? { onDailyDone } : {})} /></>;
  // while the effect has not yet made the typer of a new word, a fresh one is drawn: the old (finished) word never shows for a frame
  const shown = card ? (typer && typer.target === typingTarget(card.word.lemma) ? typer : createTyper(card.word.lemma)) : null;
  const done = shown?.done === true;
  return (
    <div className="card vt-card" data-testid="vocab-screening">
      <p className="muted small vt-progress">Word {Math.min(st.progress.done + 1, st.progress.total)} of {st.progress.total}</p>
      {card && shown && (
        <div className="keys-text vt-line" aria-label="Words to screen" data-testid="vocab-line">
          {history.map((h) => <WordToken key={h.lemma} lemma={h.lemma} state={h.kind === "screen_known" ? "known" : h.kind === "screen_unknown" ? "unknown" : "archived"} />)}
          <WordToken key={card.word.lemma} lemma={card.word.lemma} state="current" typer={shown} facts={card.word} />
          {card.upcoming.map((w) => <WordToken key={w.lemma} lemma={w.lemma} state="next" />)}
        </div>
      )}
      {error && <p className="notice notice-warning small" role="alert">{error}</p>}
      {layoutNotice && <Toast text={LAYOUT_HINT} />}
      {undo && <p className="vt-toast" role="status" data-testid="vocab-archived-toast">Archived “{undo.lemma}” · <button type="button" className="btn" onClick={() => { const l = undo.lemma; setUndo(null); void api.restoreVocabWord(l).catch((e) => setError(errorText(e))); }}>Undo</button></p>}
      <div className="vt-actions">
        <button type="button" className="btn btn-primary has-kbd" disabled={!done} onClick={() => void decide("screen_known")} data-testid="vocab-know">I know it <Kbd k="Space" /></button>
        <button type="button" className="btn btn-primary has-kbd" disabled={!done} onClick={() => void decide("screen_unknown")} data-testid="vocab-dont-know">I don't know it <Kbd k="Enter" /></button>
        <button type="button" className="btn has-kbd" onClick={() => void decide("screen_archived")} title="Names, abbreviations and words you do not want to practise: the word is archived and no practice uses it (you can restore it in Analyze)" data-testid="vocab-archive">Archive word <Kbd k="Backspace" /></button>
        <button type="button" className="btn has-kbd" onClick={() => card && void speakWord(card.word.lemma)} aria-label="Listen to the word">Listen <Kbd k={LISTEN_KEY} /></button>
      </div>
      <p className="muted small">Type the word, then choose: its meaning is under it. Space (or Tab) and Enter work once the word is typed, and move to the next word; Backspace or Delete archives the word at any time.</p>
      <TypingKeyboard next={shown && !shown.done ? shown.target[shown.pos] ?? null : null} />
      <p className="actions"><button type="button" className="btn" onClick={onDone}>Back to Typing</button></p>
    </div>
  );
}

function ScreeningResult({ state, onNext, onDone, onDailyDone }: { state: VtSessionState; onNext: () => void; onDone: () => void; onDailyDone?: () => void }) {
  const m = state.metrics;
  const s = state.summary;
  const stats = [
    { label: "WPM", value: m ? String(Math.round(m.wpm)) : "—", tip: VT_TIPS.wpm },
    { label: "Accuracy", value: m?.accuracy == null ? "—" : `${Math.round(m.accuracy)}%`, tip: VT_TIPS.accuracy },
    { label: "Errors", value: String(m?.errors ?? 0), tip: VT_TIPS.errors },
    { label: "Time", value: fmtDuration(m?.activeMs ?? 0), tip: VT_TIPS.time },
    { label: "New screened", value: String(s.screened), tip: "Words classified in this session.\nСлов классифицировано за сессию." },
    { label: "Known", value: String(s.known), tip: "Words you said you know (Space). Self-assessment, not a check.\nСлова, которые вы отметили как известные." },
    { label: "Unknown", value: String(s.unknown), tip: "Words you said you do not know: they go to Learning.\nСлова, которые вы не знаете: они пойдут в обучение." },
    { label: "Not useful", value: String(s.notUseful), tip: "Words you removed from your list.\nСлова, убранные из вашего списка." },
  ];
  return (
    <div className="card typing-result" data-testid="vocab-screening-result">
      <h3>Screening — batch complete</h3>
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {stats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tip={x.tip} />)}
      </div>
      <ScreeningProgress estimate={state.estimate} />
      <p className="small" data-testid="vocab-estimate">Vocabulary estimate: <strong>{estimateText(state.estimate)}</strong></p>
      <p className="muted small">The estimate counts what you said you know; it is a sample-based guess, not a test. Words you do not know are waiting in Learning.</p>
      <div className="actions">
        <button className="btn btn-primary" onClick={onNext} autoFocus data-testid="vocab-next-batch">Next batch <Kbd k="Enter" /></button>
        {onDailyDone && <button className="btn btn-primary" onClick={onDailyDone}>Continue Daily Practice</button>}
        <button className="btn" onClick={onDone} data-testid="vocab-back">Back to Typing</button>
      </div>
    </div>
  );
}

/** after a batch: how much of the dictionary is screened and how much is left, as counts and percentages (the same numbers as the Typing card) */
function ScreeningProgress({ estimate }: { estimate: VtEstimateView | null }) {
  const [o, setO] = useState<VtOverview | null>(null);
  useEffect(() => {
    let alive = true;
    api.fetchVocabTypingOverview().then((x) => { if (alive) setO(x); }).catch(() => {});
    return () => { alive = false; };
  }, [estimate]);
  if (!o || o.poolSize <= 0) return null;
  const done = o.screening.screened;
  const left = Math.max(0, o.poolSize - done);
  const pct = (n: number) => `${((n / o.poolSize) * 100).toFixed(1)}%`;
  return (
    <p className="small" data-testid="vocab-screening-progress">
      Screened <strong>{done.toLocaleString("en-US")} / {o.poolSize.toLocaleString("en-US")}</strong> ({pct(done)}) · {left.toLocaleString("en-US")} left ({pct(left)})
    </p>
  );
}

type DecisionKind = "screen_known" | "screen_unknown" | "screen_archived";

/** one word of the line, drawn with the Key Builder classes; the current word shows its transcription and translation under it */
function WordToken({ lemma, state, typer, facts }: { lemma: string; state: "known" | "unknown" | "archived" | "current" | "next"; typer?: TyperState; facts?: VtWordFacts }) {
  const missed = new Set(typer?.missed ?? []);
  return (
    <span className={`keys-token vt-word vt-w-${state}`}>
      <span className="keys-word">
        <span className="keys-letters">
          {[...lemma].map((c, i) => {
            const cls = typer ? `keys-char${i === typer.pos ? " cursor" : ""}${i < typer.pos ? (missed.has(i) ? " typed missed" : " typed") : ""}` : "keys-char";
            return <span key={i} className={cls}>{c}</span>;
          })}
          {state === "current" && facts && (
            <span className="vt-tr">
              <span className="vt-tr-ipa">{facts.transcription}{facts.pos ? ` · ${facts.pos}` : ""}</span>
              <span className="vt-tr-ru" data-testid="vocab-screening-translation">{facts.translationRu}</span>
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
