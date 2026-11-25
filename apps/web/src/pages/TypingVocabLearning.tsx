import { useEffect, useRef, useState } from "react";
import type { VtCheckCard, VtCheckResult, VtLearnCard, VtSessionState } from "@english-lab/contracts";
import * as api from "../api";
import { TypingKeyboard } from "../components/TypingKeyboard";
import { DailyGoalCheck } from "../components/DailyGoalNotice";
import { HOTKEYS, Kbd, isTextField, useEnterContinue, useKeys } from "../components/hotkeys";
import { createTyper, keyStatsOf, mergePairs, typeKey, typingFacts, type KeyPair, type TyperState } from "../game/vocabTypeEngine";
import { useVocabTypingActivity } from "../vocabTypingActivity";
import { CYRILLIC, LAYOUT_HINT, Toast, useToast } from "./typingShared";
import { Stat, TypedText, VT_TIPS, errorText, fmtDuration, speakSentence, speakWord, useEventId, useTypingSounds } from "./vocabTypingShared";

const FLAG_KEY = "F8";
const OUTCOME_TEXT: Record<VtCheckResult["outcome"], string> = {
  correct: "Correct",
  form_match: "Right word, another form",
  typo: "Right, with a small typo",
  incorrect: "Not quite",
  revealed: "Answer shown",
  skipped: "Skipped",
};

/** Stage 2: type a real sentence and say "Learned" (Tab) or "Still learning" (Enter); later fill in the missing word of a sentence (cloze check) */
export function VocabLearning({ sessionId, tabId, initial, onNext, onDone, onDailyDone }: { sessionId: string; tabId: string; initial: VtSessionState; onNext: () => void; onDone: () => void; onDailyDone?: () => void }) {
  const [st, setSt] = useState<VtSessionState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [typer, setTyperState] = useState<TyperState | null>(null);
  const [answer, setAnswer] = useState("");
  const [acked, setAcked] = useState<number>(initial.lastCheck?.cardIndex ?? -1);
  const typerRef = useRef<TyperState | null>(null);
  const pairs = useRef<Record<string, KeyPair>>({});
  const busy = useRef(false);
  const [layoutNotice, showLayoutNotice] = useToast();
  const sound = useTypingSounds();
  const card = st.card;
  const cardKey = card ? `${sessionId}:${card.cardIndex}:${card.kind === "learn" ? card.sentence.id : card.kind}` : "";
  const cardKeyRef = useRef("");
  cardKeyRef.current = cardKey;
  const eventId = useEventId(cardKey);
  const flagId = useEventId(`${cardKey}:flag`);
  const pending = st.lastCheck !== null && st.lastCheck.cardIndex > acked ? st.lastCheck : null;
  const active = sessionId !== "" && !st.finished;
  useVocabTypingActivity(sessionId || null, tabId, active);

  const setTyper = (t: TyperState | null) => {
    typerRef.current = t;
    setTyperState(t);
  };

  // a new card: a fresh sentence to type (learning) or an empty answer (check)
  useEffect(() => {
    setAnswer("");
    if (card?.kind === "learn") {
      setTyper(createTyper(card.sentence.text));
      // the word, then straight away its sentence (no need to finish typing first); a card left meanwhile stays quiet
      const key = cardKey;
      void (async () => {
        if (st.settings.speakWord) await speakWord(card.word.lemma);
        if (st.settings.speakSentence && cardKeyRef.current === key) await speakSentence(card.sentence.text);
      })();
    } else setTyper(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardKey]);

  // after a check the answer is shown, and its audio plays
  const pendingKey = pending ? `${pending.cardIndex}` : "";
  useEffect(() => {
    if (!pending) return;
    void (async () => {
      if (st.settings.speakWord) await speakWord(pending.lemma);
      if (st.settings.speakSentence) await speakSentence(pending.sentence);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const apply = async (next: VtSessionState): Promise<void> => {
    if (next.finished && next.status === "active") {
      try {
        next = await api.completeVocabSession(sessionId, { tabId, keyStats: keyStatsOf(pairs.current) });
      } catch {
        /* the totals are computed again when the session is opened */
      }
    }
    setSt(next);
  };

  const run = async (fn: () => Promise<VtSessionState>): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await apply(await fn());
    } catch (e) {
      if (e instanceof api.ApiRequestError && (e.code === "CARD_MISMATCH" || e.code === "EVENT_ID_CONFLICT")) {
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

  const decide = (kind: "learn_exposure" | "learn_learned") => {
    const t = typerRef.current;
    if (!card || card.kind !== "learn" || !t?.done) return;
    void run(async () => {
      const next = await api.sendVocabEvent(sessionId, { clientEventId: eventId(), tabId, kind, cardIndex: card.cardIndex, typing: typingFacts(t) });
      pairs.current = mergePairs(pairs.current, t.pairs);
      return next;
    });
  };
  const submit = (text: string | null) => {
    if (!card || card.kind !== "check") return;
    if (text !== null && text.trim() === "") return;
    void run(() => api.sendVocabReview(sessionId, { clientEventId: eventId(), tabId, cardIndex: card.cardIndex, text }));
  };
  const flag = () => {
    if (!card || card.kind === "screen") return;
    void run(() => api.flagVocabSentence(sessionId, { clientEventId: flagId(), tabId, cardIndex: card.cardIndex }));
  };

  useKeys((e) => {
    if (!active || e.isComposing) return;
    if (pending) {
      if (e.key === "Enter" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLElement && e.target.closest("button, a"))) {
        e.preventDefault();
        setAcked(pending.cardIndex);
      }
      return;
    }
    if (!card) return;
    if (e.key === FLAG_KEY && !e.repeat) {
      e.preventDefault();
      flag();
      return;
    }
    if (card.kind === "check") {
      if (e.key === HOTKEYS.showAnswer && !e.repeat) {
        e.preventDefault();
        submit(null);
      }
      return;
    }
    if (card.kind !== "learn") return;
    if (e.key === HOTKEYS.listen && !e.repeat) {
      e.preventDefault();
      void speakSentence(card.sentence.text);
      return;
    }
    const t = typerRef.current;
    if (!t || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.done) {
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        decide("learn_learned");
      } else if (e.key === "Enter" && !isTextField(e.target)) {
        e.preventDefault();
        decide("learn_exposure");
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
    e.preventDefault();
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
    setTyper(r.state);
  });

  const showResult = st.finished || st.empty !== null;
  // Enter goes on with the next session; with nothing left to learn it goes back to Typing
  useEnterContinue(showResult ? (st.empty ? onDone : onNext) : null);
  if (showResult) return <><DailyGoalCheck mode="vocabTyping" /><LearningResult state={st} onNext={onNext} onDone={onDone} {...(onDailyDone ? { onDailyDone } : {})} /></>;

  if (pending) return <CheckFeedback result={pending} onContinue={() => setAcked(pending.cardIndex)} />;
  return (
    <div className="card vt-card gc-enter" key={cardKey} data-testid="vocab-learning">
      <p className="muted small vt-progress">Card {st.progress.done + 1} of up to {st.progress.total}</p>
      {card?.kind === "learn" && typer && <LearnBody card={card} typer={typer} onLearned={() => decide("learn_learned")} onStill={() => decide("learn_exposure")} onFlag={flag} />}
      {card?.kind === "check" && <CheckBody card={card} answer={answer} setAnswer={setAnswer} onSubmit={() => submit(answer)} onReveal={() => submit(null)} onFlag={flag} />}
      {error && <p className="notice notice-warning small" role="alert">{error}</p>}
      {layoutNotice && <Toast text={LAYOUT_HINT} />}
      <p className="actions"><button type="button" className="btn" onClick={onDone}>Back to Typing</button></p>
    </div>
  );
}

function LearnBody({ card, typer, onLearned, onStill, onFlag }: { card: VtLearnCard; typer: TyperState; onLearned: () => void; onStill: () => void; onFlag: () => void }) {
  const done = typer.done;
  return (
    <>
      <TypedText typer={typer} mark={{ start: card.sentence.targetStart, length: card.sentence.targetLength }} />
      <p className="vt-sentence-ru" data-testid="vocab-sentence-ru">{card.sentence.textRu}</p>
      <p className="vt-meta muted"><strong>{card.word.lemma}</strong>{card.word.transcription ? ` ${card.word.transcription}` : ""}{card.word.pos ? ` · ${card.word.pos}` : ""} — {card.word.translationRu}</p>
      {card.sentence.seenBefore && <p className="muted vt-seen">Seen before: this sentence is a repeat, not new evidence.</p>}
      {card.show > 1 && <p className="muted vt-seen">Showing {card.show} of {card.maxShows} for this word today.</p>}
      <div className="vt-actions">
        <button type="button" className="btn btn-primary has-kbd" disabled={!done} onClick={onLearned} data-testid="vocab-learned">Learned <Kbd k="Tab" /></button>
        <button type="button" className="btn btn-primary has-kbd" disabled={!done} onClick={onStill} data-testid="vocab-still">Still learning <Kbd k="Enter" /></button>
        <button type="button" className="btn has-kbd" onClick={() => void speakSentence(card.sentence.text)}>Listen <Kbd k={HOTKEYS.listen} /></button>
        <button type="button" className="btn has-kbd" onClick={onFlag} title="Hide this sentence for this word" data-testid="vocab-bad-example">Bad example <Kbd k={FLAG_KEY} /></button>
      </div>
      <p className="muted small">Type the sentence first, then choose. Tab and Enter work once it is typed.</p>
      <TypingKeyboard next={done ? null : typer.target[typer.pos] ?? null} />
    </>
  );
}

function CheckBody({ card, answer, setAnswer, onSubmit, onReveal, onFlag }: { card: VtCheckCard; answer: string; setAnswer: (v: string) => void; onSubmit: () => void; onReveal: () => void; onFlag: () => void }) {
  const [before, after] = card.gapped.split("____");
  return (
    <>
      <p className="muted small">Type the missing word.</p>
      <p className="vt-gapped" data-testid="vocab-gapped">{before}<span className="vt-gap">&nbsp;</span>{after}</p>
      <p className="vt-sentence-ru">{card.textRu}</p>
      {card.pos && <p className="muted small">Part of speech: {card.pos}</p>}
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <input className="vt-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={60} aria-label="The missing word" data-testid="vocab-answer" />
      </form>
      <div className="vt-actions">
        <button type="button" className="btn btn-primary has-kbd" disabled={answer.trim() === ""} onClick={onSubmit} data-testid="vocab-check">Check <Kbd k="Enter" /></button>
        <button type="button" className="btn has-kbd" onClick={onReveal} data-testid="vocab-reveal">I don't know <Kbd k={HOTKEYS.showAnswer} /></button>
        <button type="button" className="btn has-kbd" onClick={onFlag} title="Hide this sentence for this word" data-testid="vocab-bad-example">Bad example <Kbd k={FLAG_KEY} /></button>
      </div>
    </>
  );
}

function CheckFeedback({ result, onContinue }: { result: VtCheckResult; onContinue: () => void }) {
  const good = result.rating === "good";
  const at = result.sentence.toLowerCase().indexOf(result.expected.toLowerCase());
  return (
    <div className="card vt-card gc-enter" data-testid="vocab-check-feedback">
      <p className={good ? "vt-verdict-ok" : "vt-verdict-bad"}>{OUTCOME_TEXT[result.outcome]}</p>
      <p className="vt-gapped">{at >= 0 ? <>{result.sentence.slice(0, at)}<strong>{result.sentence.slice(at, at + result.expected.length)}</strong>{result.sentence.slice(at + result.expected.length)}</> : result.sentence}</p>
      <p className="vt-sentence-ru">{result.textRu}</p>
      {result.answer !== null && result.outcome !== "correct" && <p className="muted small">You wrote: {result.answer}</p>}
      <p className="vt-meta muted"><strong>{result.word.lemma}</strong>{result.word.transcription ? ` ${result.word.transcription}` : ""} — {result.word.translationRu}</p>
      {!good && <p className="muted small">The word goes back to learning; it will come up again in a sentence.</p>}
      <div className="vt-actions">
        <button type="button" className="btn btn-primary has-kbd" onClick={onContinue} autoFocus data-testid="vocab-check-next">Next <Kbd k="Enter" /></button>
        <button type="button" className="btn" onClick={() => void speakSentence(result.sentence)}>Listen again</button>
      </div>
    </div>
  );
}

function LearningResult({ state, onNext, onDone, onDailyDone }: { state: VtSessionState; onNext: () => void; onDone: () => void; onDailyDone?: () => void }) {
  if (state.empty) {
    return (
      <div className="card typing-result" data-testid="vocab-learning-empty">
        <h3>Learning</h3>
        <p>{state.empty.reason === "nothing_to_learn" ? "Nothing to learn yet — screen some words first." : `All done for now${state.empty.nextDue ? `; the next check is due ${state.empty.nextDue}` : ""}.`}</p>
        <div className="actions">
          <button className="btn btn-primary" onClick={onDone} autoFocus>Back to Typing <Kbd k="Enter" /></button>
        </div>
      </div>
    );
  }
  const m = state.metrics;
  const s = state.summary;
  const stats = [
    { label: "WPM", value: m ? String(Math.round(m.wpm)) : "—", tip: VT_TIPS.wpm },
    { label: "Accuracy", value: m?.accuracy == null ? "—" : `${Math.round(m.accuracy)}%`, tip: VT_TIPS.accuracy },
    { label: "Errors", value: String(m?.errors ?? 0), tip: VT_TIPS.errors },
    { label: "Time", value: fmtDuration(m?.activeMs ?? 0), tip: VT_TIPS.time },
    { label: "Learned today", value: String(s.learned), tip: "Words you marked Learned (Tab). They are checked later; until then this is only your own opinion.\nСлова, отмеченные как выученные; позже они проверяются." },
    { label: "Still learning", value: String(s.stillLearning), tip: "Words that will be shown again.\nСлова, которые покажутся снова." },
    { label: "Checks passed", value: String(s.checksPassed), tip: "Missing-word checks you answered right.\nПроверки, пройденные верно." },
    { label: "Checks failed", value: String(s.checksFailed), tip: "Checks you answered wrong or revealed: those words go back to learning.\nПровалы: слова возвращаются в обучение." },
  ];
  return (
    <div className="card typing-result" data-testid="vocab-learning-result">
      <h3>Learning — session complete</h3>
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {stats.map((x) => <Stat key={x.label} label={x.label} value={x.value} tip={x.tip} />)}
      </div>
      <p className="muted small">Speed and accuracy count only the typed sentences, not the missing-word answers.</p>
      <div className="actions">
        <button className="btn btn-primary" onClick={onNext} autoFocus data-testid="vocab-next-session">Next session <Kbd k="Enter" /></button>
        {onDailyDone && <button className="btn btn-primary" onClick={onDailyDone}>Continue Daily Practice</button>}
        <button className="btn" onClick={onDone} data-testid="vocab-back">Back to Typing</button>
      </div>
    </div>
  );
}
