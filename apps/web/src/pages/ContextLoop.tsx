import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { WordImage } from "../components/WordImage";
import { PauseButton, PauseOverlay, useAutoPause, usePauseKeys } from "../components/Pause";
import { HOTKEYS, Kbd, isTextField, useEnterContinue, useKeys } from "../components/hotkeys";
import { useContextLoopActivity } from "../contextLoopActivity";
import { VoiceBar } from "../components/PromptView";
import { useVoice } from "../voice";
import type { ContextLoopCheckCard, ContextLoopCheckResult } from "@english-lab/contracts";

const errorText = (e: unknown) => (e instanceof api.ApiRequestError ? e.message : "Something went wrong.");

/** plays the clip and resolves when it has finished (or failed), so the caller can keep one voice at a time */
async function playBlob(blob: Blob | null): Promise<void> {
  if (!blob) throw new Error("Audio unavailable.");
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

/** one voice at a time: a click while a clip is loading or playing is ignored */
function useOneVoice() {
  const busy = useRef(false);
  const [playing, setPlaying] = useState(false);
  const run = useCallback(async (load: () => Promise<Blob | null>) => {
    if (busy.current) return;
    busy.current = true;
    setPlaying(true);
    try {
      await playBlob(await load());
    } finally {
      busy.current = false;
      setPlaying(false);
    }
  }, []);
  return { run, playing };
}

/** the sentence with the studied word marked */
function Marked({ text, start, length }: { text: string; start: number; length: number }) {
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, start + length)}</mark>
      {text.slice(start + length)}
    </>
  );
}

const CHECK_TEXT: Record<ContextLoopCheckResult["outcome"], string> = {
  correct: "Right",
  incorrect: "Not this time",
  synonym: "Close, but we were looking for another word",
  skipped: "No problem — here is the word",
};

/** the full sentence with the expected word in the gap, coloured by the result */
function Filled({ r }: { r: ContextLoopCheckResult }) {
  const i = r.sentence.toLowerCase().indexOf(r.expected.toLowerCase());
  if (i < 0) return <>{r.sentence}</>;
  return (
    <>
      {r.sentence.slice(0, i)}
      <mark className={`cl-fill cl-fill-${r.outcome === "correct" ? "ok" : "bad"}`} data-testid="context-loop-filled">{r.sentence.slice(i, i + r.expected.length)}</mark>
      {r.sentence.slice(i + r.expected.length)}
    </>
  );
}

/**
 * D159: the rare check. Only the familiar sentence with a gap and the Russian meaning are shown; the learner types or says the word.
 * A spoken answer is recognised by the existing speech service and stays editable before it is sent; no audio is kept.
 * The result is shown in the same card: the right word goes into the gap (green or red) and Continue (Enter) moves on.
 */
function CheckCard({ sessionId, tabId, card, onState, paused }: { sessionId: string; tabId: string; card: ContextLoopCheckCard; onState: (s: api.ContextLoopState) => void; paused: boolean }) {
  const [text, setText] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [letter, setLetter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** the answered check: its result and the state to move on to */
  const [done, setDone] = useState<{ r: ContextLoopCheckResult; next: api.ContextLoopState } | null>(null);
  const attemptId = useRef(crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);
  const voice = useVoice(sessionId, tabId, card.voice && !paused && !done, api.contextLoopSttStart);
  const vs = voice.state;
  const atMount = useRef(vs);
  useEffect(() => {
    if (vs.phase === "draft" && vs !== atMount.current) {
      setText(vs.text);
      setDraftId(vs.draftId);
      input.current?.focus();
    }
  }, [vs]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => () => voice.close(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEnterContinue(done && !paused ? () => onState(done.next) : null);

  const send = async (answer: string | null) => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    const spoken = answer !== null && draftId !== null && voice.streamId !== null;
    try {
      const r = await api.answerContextLoopCheck(sessionId, { id: attemptId.current, tabId, cardIndex: card.cardIndex, text: answer, firstLetter: letter !== null, ...(spoken ? { input: "voice" as const, streamId: voice.streamId!, draftId: draftId! } : { input: "text" as const }) });
      voice.close();
      voice.clear();
      if (r.lastCheck) setDone({ r: r.lastCheck, next: r });
      else onState(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const hint = async () => {
    try {
      setLetter((await api.contextLoopFirstLetter(sessionId, tabId, card.cardIndex)).letter);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const r = done?.r;
  return (
    <div className={`cl-check${r ? ` cl-res cl-res-${r.outcome === "correct" ? "ok" : r.outcome === "skipped" ? "skip" : "bad"}` : ""}`} data-testid="context-loop-check">
      <span className="chip chip-info">Quick check</span>
      {r ? (
        <p className="cl-res-head" role="status" data-testid="context-loop-check-result">
          <i className={`pi ${r.outcome === "correct" ? "pi-check-circle" : r.outcome === "skipped" ? "pi-info-circle" : "pi-times-circle"}`} aria-hidden="true" /> {CHECK_TEXT[r.outcome]}
          {r.outcome === "correct" && r.formMatch === "other_form" ? " (another form of the word)" : ""}
        </p>
      ) : (
        <p className="muted small">Which of your words fits the gap? Type it or say it — just the word.</p>
      )}
      <p className="cl-sentence" lang="en" data-testid="context-loop-gapped">{r ? <Filled r={r} /> : card.gapped}</p>
      <p className="cl-meaning"><strong>{card.cue.translationRu}</strong> {card.cue.pos && card.cue.pos !== "unknown" && <span className="muted small">({card.cue.pos})</span>}{letter && <span className="small"> · starts with “{letter}”</span>}</p>
      {r ? (
        <>
          {r.answer && r.outcome !== "correct" && <p className="small">Your answer: <span className="cl-wrong" lang="en">{r.answer}</span></p>}
          <div className="actions">
            <button className="btn btn-primary btn-big has-kbd" onClick={() => onState(done!.next)} data-testid="context-loop-continue"><Kbd k="Enter" /> Continue</button>
          </div>
        </>
      ) : (
        <>
          <form
            className="field-add cl-check-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void send(text);
            }}
          >
            <input ref={input} value={text} onChange={(e) => setText(e.target.value)} aria-label="The missing word" autoComplete="off" spellCheck={false} maxLength={60} data-testid="context-loop-check-input" />
            <button className="btn btn-primary" disabled={busy || !text.trim()} type="submit">Check</button>
          </form>
          {card.voice && <VoiceBar voice={voice} busy={busy} hasDraft={draftId !== null} />}
          <div className="actions">
            {!letter && <button className="link small" onClick={() => void hint()}>Show the first letter</button>}
            <button className="link small" disabled={busy} onClick={() => void send(null)} data-testid="context-loop-idk">I don't know</button>
          </div>
        </>
      )}
      {error && <p className="notice notice-error small" role="alert">{error}</p>}
    </div>
  );
}

type Card = api.ContextLoopState["card"] & { kind: "card" };
type WordResult = api.ContextLoopState["summary"]["perWord"][number];

/** share of answers recalled or typed right in this session, as a ring with the percentage in the middle */
function QualityRing({ words }: { words: WordResult[] }) {
  const ok = words.reduce((n, w) => n + w.success, 0);
  const all = ok + words.reduce((n, w) => n + w.miss, 0);
  const p = all === 0 ? null : ok / all;
  const R = 42;
  const C = 2 * Math.PI * R;
  const tone = p === null ? "" : p >= 0.75 ? "cl-q-good" : p >= 0.5 ? "cl-q-mid" : "cl-q-low";
  return (
    <figure className={`cl-quality ${tone}`} data-testid="context-loop-quality">
      <svg viewBox="0 0 100 100" role="img" aria-label={p === null ? "No answers yet" : `Session quality ${Math.round(p * 100)}%: ${ok} of ${all} answers right`}>
        <circle className="cl-q-track" cx="50" cy="50" r={R} />
        {p !== null && p > 0 && <circle className="cl-q-arc" cx="50" cy="50" r={R} strokeDasharray={`${C * p} ${C}`} transform="rotate(-90 50 50)" />}
        <text x="50" y="50" textAnchor="middle" dominantBaseline="central" className="cl-q-value">{p === null ? "—" : `${Math.round(p * 100)}%`}</text>
      </svg>
      <figcaption><strong>Session quality</strong><span className="muted small">{ok} of {all} answers right</span></figcaption>
    </figure>
  );
}

/** one row per word: a full-width bar split into the share recalled (green) and missed (red); the numbers give the counts */
function WordBars({ words }: { words: WordResult[] }) {
  if (words.length === 0) return null;
  return (
    <div className="cl-words" data-testid="context-loop-word-bars">
      <div className="cl-words-head"><strong>By word</strong><span className="cl-legend"><span className="cl-sw cl-sw-ok" /> right <span className="cl-sw cl-sw-bad" /> missed</span></div>
      <ul role="list">
        {words.map((w) => (
          <li key={w.lemma} title={`${w.lemma}: ${w.success} right, ${w.miss} missed${w.done ? " · done for this session" : ""}`}>
            <span className="cl-w-name" lang="en">{w.done && <i className="pi pi-check" aria-label="done" />} {w.lemma}</span>
            <span className="cl-w-bar" aria-hidden="true">
              {w.success > 0 && <span className="cl-w-ok" style={{ width: `${(w.success / (w.success + w.miss)) * 100}%` }} />}
              {w.miss > 0 && <span className="cl-w-bad" style={{ width: `${(w.miss / (w.success + w.miss)) * 100}%` }} />}
            </span>
            <span className="cl-w-num small">{w.success} / {w.success + w.miss}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Context Loop (TASK_037): a short sentence with one saved word marked. The learner says honestly whether they recall its meaning here
 * (1 / 2) and only then sees the translation and definition. Missed words come back after other cards, recalled ones in a new sentence.
 * No timer; Finish is always there.
 */
export function ContextLoop({ onExit, onFinished }: { onExit: () => void; onFinished?: () => void }) {
  const tab = useRef(crypto.randomUUID());
  const [st, setSt] = useState<api.ContextLoopState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [translation, setTranslation] = useState<string | null>(null);
  const aids = useRef<api.ContextLoopAids>({});
  /** the card just answered with its meaning: shown until the learner continues, before the next card or the summary */
  const [shown, setShown] = useState<{ card: Card; outcome: "recalled" | "not_recalled" } | null>(null);
  const [paused, setPaused] = useState(false);
  const voice = useOneVoice();

  const start = useCallback(() => {
    let live = true;
    setSt(null);
    setError(null);
    void api
      .startContextLoop(tab.current)
      .then((r) => live && setSt(r.state))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, []);
  // starts a session, or continues the open one in this tab (the server keeps one active session)
  useEffect(() => start(), [start]);

  const active = !!st && st.status === "active" && !st.finished;
  usePauseKeys(paused, setPaused, active);
  const auto = useAutoPause(active && !paused);
  useContextLoopActivity(st?.sessionId ?? null, tab.current, active && !paused && !auto.reason && !shown);

  const cardKey = st?.card ? `${st.card.cardIndex}` : "none";
  useEffect(() => {
    aids.current = {};
  }, [cardKey]);

  // the last card was answered: the session is closed at once, the summary only offers Continue or Exit
  const sessionId = st?.sessionId;
  const closeNow = !!st && st.finished && st.status === "active";
  useEffect(() => {
    if (!closeNow || !sessionId) return;
    void api
      .completeContextLoop(sessionId)
      .then(setSt)
      .catch((e) => setError(errorText(e)));
  }, [closeNow, sessionId]);

  const answer = useCallback(
    async (outcome: "recalled" | "not_recalled") => {
      if (!st?.card || st.card.kind !== "card" || busy || shown) return;
      const card = st.card;
      setBusy(true);
      setError(null);
      try {
        const next = await api.answerContextLoop(st.sessionId, { id: crypto.randomUUID(), tabId: tab.current, cardIndex: card.cardIndex, outcome, aids: aids.current });
        setTranslation(null);
        setNote(null);
        setShown({ card, outcome });
        setSt(next);
      } catch (e) {
        setError(errorText(e));
        try {
          setSt(await api.fetchContextLoopSession(st.sessionId));
        } catch {
          /* keep the card */
        }
      } finally {
        setBusy(false);
      }
    },
    [st, busy, shown],
  );

  const finish = async () => {
    if (!st) return onExit();
    try {
      setShown(null);
      setSt(await api.completeContextLoop(st.sessionId));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const playWord = (card: Card) => {
    if (!shown) aids.current.wordAudio = true;
    void voice.run(() => api.vocabularyWordSpeech(card.entryId)).catch((e) => setNote(e instanceof Error ? e.message : "Pronunciation unavailable."));
  };
  const playSentence = (card: Card) => {
    if (!shown) aids.current.sentenceAudio = true;
    void voice.run(() => api.fetchBookSpeech({ text: card.sentence.text })).catch((e) => setNote(e instanceof Error ? e.message : "The sentence cannot be read aloud now."));
  };
  const translate = async (card: Card) => {
    try {
      setTranslation((await api.translateSentence(card.sentence.text)).text);
    } catch (e) {
      setNote(errorText(e));
    }
  };

  const onCard = active && !paused && !shown && st?.card?.kind === "card";
  useKeys((e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
    const card = shown?.card ?? (onCard ? (st!.card as Card) : null);
    if (!card || paused) return;
    if (e.key === HOTKEYS.listen) {
      e.preventDefault();
      playSentence(card);
    } else if (shown && e.key === HOTKEYS.translate) {
      e.preventDefault();
      if (!translation && !card.sentence.translationRu) void translate(card);
    } else if (onCard && e.key === "1") {
      e.preventDefault();
      void answer("recalled");
    } else if (onCard && e.key === "2") {
      e.preventDefault();
      void answer("not_recalled");
    }
  });
  const finished = !!st && st.finished && !shown;
  const continueAfter = () => (onFinished ? onFinished() : start());
  useEnterContinue(shown && !paused ? () => setShown(null) : finished && st?.status === "completed" ? continueAfter : null);

  if (!st) {
    return (
      <section className="card">
        {error ? <p className="notice notice-error" role="alert">{error}</p> : <p role="status">Loading…</p>}
        <button className="btn" onClick={onExit}>Back to Vocabulary</button>
      </section>
    );
  }

  const pauseOverlays = (
    <>
      {paused && <PauseOverlay onResume={() => setPaused(false)} />}
      {!paused && auto.reason && <PauseOverlay auto={auto.reason} onResume={auto.resume} />}
    </>
  );
  const top = (
    <div className="cl-top">
      <h2 id="cl-h"><i className="pi pi-sync" aria-hidden="true" /> Context Loop</h2>
      {!st.finished && <span className="muted small">{st.progress.cards + (shown ? 0 : 1)} / {st.progress.maxCards} · {st.progress.wordsDone} of {st.progress.wordsTotal} words done</span>}
      {!st.finished && <PauseButton paused={paused} onToggle={() => setPaused(!paused)} />}
      {!st.finished && <button className="btn" onClick={() => void finish()} data-testid="context-loop-finish">Finish</button>}
    </div>
  );
  const listen = (card: Card) => (
    <div className="cl-audio">
      <button type="button" className="cl-pill" disabled={voice.playing} onClick={() => playWord(card)} aria-label={`Play ${card.lemma}`}><i className="pi pi-volume-up" aria-hidden="true" /> Word</button>
      <button type="button" className="cl-pill has-kbd" disabled={voice.playing} onClick={() => playSentence(card)}><Kbd k={HOTKEYS.listen} /><i className="pi pi-play" aria-hidden="true" /> Listen to the sentence</button>
    </div>
  );
  const body = (card: Card) => (
    <div className="cl-body">
      {card.sameSentenceAgain ? (
        <span className="cl-badge cl-badge-repeat" data-testid="context-loop-repeat"><i className="pi pi-replay" aria-hidden="true" /> Same sentence again</span>
      ) : card.newContext ? (
        <span className="cl-badge cl-badge-new"><i className="pi pi-star" aria-hidden="true" /> New context</span>
      ) : null}
      <div className="cl-image"><WordImage word={card.lemma} hideIfMissing /></div>
      <p className="cl-sentence" lang="en" data-testid="context-loop-sentence">
        <Marked text={card.sentence.text} start={card.sentence.targetStart} length={card.sentence.targetLength} />
      </p>
      {listen(card)}
    </div>
  );
  const messages = (
    <>
      {note && <p className="small notice notice-warn" role="status">{note}</p>}
      {error && <p className="notice notice-error small" role="alert">{error}</p>}
    </>
  );

  // the meaning of the card just answered
  if (shown) {
    const card = shown.card;
    const m = card.meaning;
    return (
      <section className="card cl-card" aria-labelledby="cl-h" data-testid="context-loop">
        {top}
        {body(card)}
        <div className={`cl-meaning-box ${shown.outcome === "recalled" ? "cl-yes" : "cl-no"}`} data-testid="context-loop-meaning">
          <div className="cl-meaning-head">
            <span className="cl-meaning-word" lang="en">{card.lemma}</span>
            {m.pos && m.pos !== "unknown" && <span className="muted small">{m.pos}</span>}
            <span className="cl-meaning-outcome small">{shown.outcome === "recalled" ? "Recalled" : "Not recalled"}</span>
          </div>
          <div className="cl-meaning-ru">{m.translationRu}</div>
          {m.definitionRu && <div className="cl-meaning-def">{m.definitionRu}</div>}
          <div className="cl-meaning-tr">
            {card.sentence.translationRu || translation ? <span data-testid="context-loop-translation">{card.sentence.translationRu ?? translation}</span> : <button className="cl-pill has-kbd" onClick={() => void translate(card)}><Kbd k={HOTKEYS.translate} /><i className="pi pi-language" aria-hidden="true" /> Translate sentence</button>}
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-primary btn-big has-kbd" onClick={() => setShown(null)} data-testid="context-loop-next"><Kbd k="Enter" /> Continue</button>
        </div>
        {messages}
        {pauseOverlays}
      </section>
    );
  }

  if (st.finished) {
    const s = st.summary;
    const stats: Array<[string | number, string]> = [
      [s.cards, "cards"],
      [s.words, "words"],
      [s.firstTry, "recalled at first sight"],
      [s.newContextSuccess, "recalled in a new sentence"],
      [s.returns, "returns"],
      ...(s.checks.total > 0 ? [[`${s.checks.correct} / ${s.checks.total}`, "words typed or said right"] as [string, string]] : []),
    ];
    return (
      <section className="card cl-card cl-summary" aria-labelledby="cl-done" data-testid="context-loop-summary">
        <h2 id="cl-done"><i className="pi pi-sync" aria-hidden="true" /> Context Loop</h2>
        <div className="cl-sum-top">
          <QualityRing words={s.perWord} />
          <ul className="cl-stats" role="list">
            {stats.map(([n, label]) => (
              <li key={label}><strong>{n}</strong><span>{label}</span></li>
            ))}
          </ul>
        </div>
        <WordBars words={s.perWord} />
        {s.needsWork.length > 0 && (
          <p className="cl-needs"><span className="muted small">Needs more work</span> {s.needsWork.map((w) => <span key={w} className="cl-badge" lang="en">{w}</span>)}</p>
        )}
        {error && <p className="notice notice-error small" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn btn-primary btn-big has-kbd" disabled={st.status !== "completed"} onClick={continueAfter} data-testid="context-loop-continue-next"><Kbd k="Enter" /> Continue</button>
          <button className="btn btn-big" onClick={onExit}>Exit</button>
        </div>
      </section>
    );
  }

  if (st.card!.kind === "check") {
    return (
      <section className="card cl-card" aria-labelledby="cl-h" data-testid="context-loop">
        {top}
        <CheckCard
          key={st.card!.cardIndex}
          sessionId={st.sessionId}
          tabId={tab.current}
          card={st.card as ContextLoopCheckCard}
          paused={paused || !!auto.reason}
          onState={setSt}
        />
        {pauseOverlays}
      </section>
    );
  }
  const c = st.card as Card;
  return (
    <section className="card cl-card" aria-labelledby="cl-h" data-testid="context-loop">
      {top}
      {body(c)}
      <p className="cl-ask muted small">Do you know what the marked word means here? Answer first, then see the meaning.</p>
      <div className="actions">
        <button className="btn btn-ok btn-big has-kbd" disabled={busy} onClick={() => void answer("recalled")} data-testid="context-loop-recalled"><Kbd k="1" /> I know it</button>
        <button className="btn btn-big has-kbd" disabled={busy} onClick={() => void answer("not_recalled")} data-testid="context-loop-not-recalled"><Kbd k="2" /> I don't know</button>
      </div>
      {messages}
      {pauseOverlays}
    </section>
  );
}
