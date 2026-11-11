import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { WORD_LESSON_STAGES, type WordLessonAttemptView, type WordLessonItemState, type WordLessonRunState, type WordLessonTaskView } from "@english-lab/contracts";
import * as api from "../api";
import { VoiceBar } from "../components/PromptView";
import { Kbd, isPressable, isTextField, useKeys } from "../components/hotkeys";
import { AI_CHECK_WAIT_S } from "../practiceFlow";
import { useVoice } from "../voice";
import { useWordLessonActivity } from "../wordLessonActivity";
import { PauseButton, PauseOverlay, useAutoPause, usePauseKeys } from "../components/Pause";
import { DailyGoalCheck } from "../components/DailyGoalNotice";

const errorText = (e: unknown) => (e instanceof api.ApiRequestError ? e.message : "Something went wrong.");
const stageOf = (key: string): number => (key === "s1" ? 1 : key === "s2" ? 2 : key.startsWith("s3.") ? 3 : key === "s4" ? 4 : 5);

/** the sentence with the word form in bold (plain React elements, no HTML) */
function Marked({ text, at }: { text: string; at: { start: number; length: number } }): ReactNode {
  return (
    <>
      {text.slice(0, at.start)}
      <strong>{text.slice(at.start, at.start + at.length)}</strong>
      {text.slice(at.start + at.length)}
    </>
  );
}

function Steps({ stage, sub }: { stage: number; sub: string | null }) {
  const title = WORD_LESSON_STAGES[stage - 1]!.title;
  return (
    <div className="wl-steps" data-testid="wl-steps">
      <p className="progress" aria-live="polite">
        <strong data-testid="wl-stage">{stage}/5</strong> · {title}
        {sub && <span className="muted"> · {sub}</span>}
      </p>
      <div className="wl-bar" role="progressbar" aria-valuemin={1} aria-valuemax={5} aria-valuenow={stage} aria-label={`Stage ${stage} of 5`}>
        {WORD_LESSON_STAGES.map((s) => (
          <span key={s.n} className={s.n < stage ? "done" : s.n === stage ? "now" : ""} />
        ))}
      </div>
    </div>
  );
}

/**
 * Says the word aloud (ElevenLabs, through the app's stored files: a word already spoken anywhere in the app costs nothing) each time a new stage
 * begins, stage 1 included. It follows the "pronunciation" switch of the dictionary and stays silent while the lesson is paused or the browser
 * blocks autoplay; the sound never changes the lesson or its scoring.
 */
function useSpeakWordPerStage(lemma: string | null, stage: number | null, allowed: boolean): void {
  const spoken = useRef<number | null>(null);
  const enabled = useRef<boolean | null>(null);
  const url = useRef<{ lemma: string; clip: Promise<string | null> } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!lemma || stage === null || !allowed || spoken.current === stage) return;
    spoken.current = stage;
    let cancelled = false;
    void (async () => {
      try {
        if (enabled.current === null) enabled.current = (await api.fetchVocabularySpeech()).enabled;
        if (!enabled.current || cancelled) return;
        if (url.current?.lemma !== lemma) url.current = { lemma, clip: api.vocabularyTextSpeech(lemma).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null) };
        const src = await url.current.clip;
        if (!src || cancelled) return;
        audio.current?.pause();
        audio.current = new Audio(src);
        await audio.current.play();
      } catch { /* silent: no key, no limit left, or autoplay blocked */ }
    })();
    return () => { cancelled = true; };
  }, [lemma, stage, allowed]);
  useEffect(() => () => {
    audio.current?.pause();
    const u = url.current;
    if (u) void u.clip.then((x) => { if (x) URL.revokeObjectURL(x); });
  }, []);
}

/** Single Word Context Practice: one saved word, five fixed stages, no way to fail or skip. The lesson is ready-made; only the checking asks the model. */
export function WordLesson({ lessonId, onExit, onFinished }: { lessonId: string; onExit: () => void; onFinished?: () => void }) {
  const tab = useRef(crypto.randomUUID());
  const [run, setRun] = useState<WordLessonRunState | null>(null);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<string, WordLessonTaskView>>({});
  const [text, setText] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const attemptId = useRef<string | null>(null);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const voice = useVoice(run?.runId ?? null, tab.current, !!run && run.voice && run.status === "active", api.wordLessonSttStart);
  const vs = voice.state;
  const atMount = useRef(vs);
  useEffect(() => {
    if (vs.phase === "draft" && vs !== atMount.current) {
      setText(vs.text);
      setDraftId(vs.draftId);
    }
  }, [vs]);
  const [paused, setPaused] = useState(false);
  usePauseKeys(paused, setPaused, !!run && run.status === "active");
  const auto = useAutoPause(!!run && run.status === "active" && !paused);
  useWordLessonActivity(run?.runId ?? null, tab.current, !!run && run.status === "active" && !paused && !auto.reason);

  const take = useCallback((s: WordLessonRunState, follow = false) => {
    setRun(s);
    if (s.task) setTasks((t) => (t[s.task!.key] ? t : { ...t, [s.task!.key]: s.task! }));
    setViewKey((k) => (follow || k === null ? (s.currentKey ?? k) : k));
  }, []);

  useEffect(() => {
    let live = true;
    api
      .startWordLessonRun(lessonId, tab.current)
      .then((r) => live && take(r.state, true))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [lessonId, take]);

  // an open run whose tasks are all answered has no current task: show the last one (with the Finish button), not stage 1
  const key = viewKey ?? run?.currentKey ?? (run?.status === "active" ? run.items.at(-1)?.key : undefined) ?? "s1";
  const item: WordLessonItemState | undefined = run?.items.find((i) => i.key === key);
  const attempts = item?.attempts ?? [];
  const last: WordLessonAttemptView | undefined = attempts.at(-1);
  const feedbackShown = !!last && attempts.length > (dismissed[key] ?? 0);
  const task = tasks[key] ?? (run?.task?.key === key ? run.task : undefined);
  useSpeakWordPerStage(run?.lemma ?? null, run?.status === "active" ? stageOf(key) : null, !paused && !auto.reason);

  async function call(fn: () => Promise<WordLessonRunState>, follow = false): Promise<WordLessonRunState | null> {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      if (alive.current) take(s, follow);
      return s;
    } catch (e) {
      if (alive.current) setError(errorText(e));
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const event = (kind: Parameters<typeof api.sendWordLessonEvent>[2], k = key) => call(() => api.sendWordLessonEvent(run!.runId, k, kind));

  async function submit() {
    if (!run || !text.trim() || busy || waiting) return;
    attemptId.current ??= crypto.randomUUID();
    const spoken = draftId !== null && voice.streamId !== null;
    const body = { id: attemptId.current, itemKey: key, text, input: spoken ? ("voice" as const) : ("text" as const), ...(spoken ? { streamId: voice.streamId!, draftId: draftId! } : {}) };
    const s = await call(() => api.sendWordLessonAttempt(run.runId, body));
    if (!s) return; // the same id is sent again on the next try, so a flaky connection never doubles an answer
    attemptId.current = null;
    setText("");
    setDraftId(null);
    voice.close(); // with local speech recognition the open voice session holds the graphics card, and the check needs it
    voice.clear();
  }

  // an answer waits for the local model: look again every second, and after AI_CHECK_WAIT_S give up waiting (the answer is then "unresolved" and the learner can go on)
  // Enter does what the main button on screen does (Next, Continue ...), unless the cursor is in a text box or on a button of its own
  const enterAction = useRef<(() => void) | null>(null);
  useKeys((e) => {
    if (e.key !== "Enter" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target) || isPressable(e.target)) return;
    if (enterAction.current) {
      e.preventDefault();
      enterAction.current();
    }
  });
  const watching = useRef<string | null>(null);
  const lastId = last?.id;
  const lastVerdict = last?.verdict;
  const runId = run?.runId;
  useEffect(() => {
    if (!runId || !lastId || lastVerdict !== "pending" || watching.current === lastId) return;
    watching.current = lastId;
    setWaiting(true);
    void (async () => {
      let pending = true;
      for (let i = 0; i < AI_CHECK_WAIT_S && alive.current && pending; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const latest = await api.fetchWordLessonRun(runId);
          if (!alive.current) return;
          take(latest);
          pending = latest.items.some((x) => x.attempts.some((a) => a.id === lastId && a.verdict === "pending"));
        } catch {
          /* keep waiting */
        }
      }
      if (alive.current && pending) {
        try {
          take(await api.giveUpWordLessonCheck(runId, lastId));
        } catch (e) {
          watching.current = null; // look again: the wait can start over
          setError(errorText(e));
        }
      }
      if (alive.current) setWaiting(false);
    })();
  }, [runId, lastId, lastVerdict, take]);

  const tryAgain = () => {
    setDismissed((d) => ({ ...d, [key]: attempts.length }));
    setText("");
    setDraftId(null);
    voice.clear();
    setTimeout(() => field.current?.focus(), 0);
  };

  const next = async () => {
    if (!run) return;
    if (run.currentKey === null) {
      await call(() => api.completeWordLessonRun(run.runId));
      api.announceXp();
      return;
    }
    setViewKey(run.currentKey);
    setText("");
    setDraftId(null);
    voice.clear();
  };

  if (error && !run) {
    return (
      <section className="card">
        <p className="notice notice-error" role="alert">{error}</p>
        <button className="btn" onClick={onExit}>Back to Vocabulary</button>
      </section>
    );
  }
  if (!run) return <section className="card"><p role="status">Opening the lesson…</p></section>;

  if (run.status === "completed" && run.result) {
    const r = run.result;
    return (
      <section className="card wl-lesson" data-testid="wl-result">
        <DailyGoalCheck mode="wordLesson" />
        <h2><i className="pi pi-star" aria-hidden="true" /> {run.lemma}</h2>
        <div className={`wl-hero ${r.score >= 80 ? "wl-tier-high" : r.score >= 50 ? "wl-tier-mid" : "wl-tier-low"}`}>
          <p className="wl-score" aria-label={`Score ${r.score} out of 100`}><strong>{r.score}</strong><span>/100</span></p>
          <div className="wl-meter" role="presentation"><span style={{ width: `${Math.max(0, Math.min(100, r.score))}%` }} /></div>
          <p className="wl-hero-time"><i className="pi pi-clock" aria-hidden="true" /> {Math.max(1, Math.round(r.activeMs / 60000))} min</p>
        </div>
        <p className="muted small">The score shows how independent you were: hints and corrections lower it, and you can play this lesson again any time.</p>
        <ol className="wl-stages">
          {r.stages.map((s) => {
            const ratio = s.max ? Math.max(0, Math.min(1, s.points / s.max)) : 0;
            return (
              <li key={s.stage} className="wl-stage-row" data-testid="wl-stage-row">
                <span className="wl-stage-no" aria-hidden="true">{s.stage}</span>
                <div className="wl-stage-main">
                  <p className="wl-stage-title">{s.title}</p>
                  <p className="wl-stage-note">{s.note}</p>
                  {s.max ? <div className="wl-meter wl-meter-small" role="presentation"><span style={{ width: `${Math.round(ratio * 100)}%` }} /></div> : null}
                </div>
                <p className="wl-stage-points">
                  {s.max ? <><strong>{Math.round(s.points)}</strong><span>/{s.max}</span></> : <span className="wl-stage-none">no points</span>}
                </p>
              </li>
            );
          })}
        </ol>
        <div className="actions">
          <button className="btn btn-primary" onClick={onFinished ?? onExit} autoFocus data-testid="wl-finish">{onFinished ? "Continue" : "Back to Vocabulary"} <i className="pi pi-arrow-right" aria-hidden="true" /></button>
          {onFinished && <button className="btn" onClick={onExit}>Stay in Vocabulary</button>}
        </div>
      </section>
    );
  }

  const stage = stageOf(key);
  const sub = stage === 3 ? `Transformation ${Number(key.split(".")[1])}/${run.transformationCount}` : null;
  const kinds = new Set(item?.events ?? []);
  const done = !!item?.done;
  const canType = stage >= 2 && !done && !waiting && (!last || !feedbackShown) && run.status === "active";
  const word = run.word;
  const goNext = () => void next();
  const nextLabel = run.currentKey === null ? "Finish lesson" : "Next";
  const continueNow = () => void event("continue").then((s) => s && setViewKey(s.currentKey ?? key));
  const feedbackOn = stage >= 2 && !!last && feedbackShown && !waiting;
  enterAction.current = busy || waiting || run.status !== "active" ? null
    : stage === 1 ? () => void call(() => api.sendWordLessonEvent(run.runId, "s1", "stage_done"), true)
    : feedbackOn ? (last!.verdict === "correct" || done ? goNext : stage === 2 ? tryAgain : continueNow)
    : stage >= 2 && done ? goNext : null;
  // words that only replace the target word (its synonyms) are no help in a task that must use the target word itself
  const banned = [run.lemma, ...word.synonyms].map((w) => w.toLowerCase()).filter(Boolean);
  const usable = (w: string) => !banned.some((b) => new RegExp(`(^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(w));

  return (
    <section className="card wl-lesson" aria-labelledby="wl-h" data-testid="wl-lesson">
      <div className="session-header">
        <h2 id="wl-h"><i className="pi pi-star" aria-hidden="true" /> {run.lemma || "One word, five steps"}</h2>
        <PauseButton paused={paused} onToggle={() => setPaused(!paused)} />
        <button className="btn btn-small" onClick={onExit} title="Leave the lesson; you can come back to it">Leave</button>
      </div>
      {paused && <PauseOverlay onResume={() => setPaused(false)} />}
      {!paused && auto.reason && <PauseOverlay auto={auto.reason} onResume={auto.resume} />}
      <Steps stage={stage} sub={sub} />
      {error && <p className="notice notice-error" role="alert">{error}</p>}

      {stage === 1 && (
        <div data-testid="wl-stage1">
          <p className="instruction">Read the sentences. Nothing to answer here.</p>
          <div className="wl-word-block" data-testid="wl-word-block">
            <p className="wl-word-title"><strong>{run.lemma}</strong>{word.pos !== "unknown" && <span className="wl-pos">{word.pos}</span>}</p>
            <dl className="wl-word-facts">
              <dt>Translation</dt><dd lang="ru">{word.translationRu || "—"}</dd>
              <dt>Meaning</dt><dd lang="ru">{word.definitionRu || <span className="muted">—</span>}</dd>
              <dt>Synonyms</dt><dd>{word.synonyms.length ? word.synonyms.join(", ") : <span className="muted">—</span>}</dd>
            </dl>
          </div>
          <ol className="wl-examples">
            {run.stage1.examples.map((e, i) => (
              <li key={e.id} className="wl-ex-card" data-testid="wl-example">
                <span className="wl-ex-no" aria-hidden="true">{i + 1}</span>
                <div>
                  <p className="wl-en"><Marked text={e.en} at={e.target} /></p>
                  <p lang="ru" className="wl-ru"><em>{e.ru}</em></p>
                </div>
              </li>
            ))}
          </ol>
          <div className="actions">
            <button className="btn btn-primary has-kbd" disabled={busy} autoFocus onClick={() => void call(() => api.sendWordLessonEvent(run.runId, "s1", "stage_done"), true)} data-testid="wl-next">
              <Kbd k="Enter" /> Next: recall the word <i className="pi pi-arrow-right" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {stage === 2 && task?.stage === 2 && (
        <div data-testid="wl-stage2">
          <p className="instruction">Type the missing word, or say it. Hint shows it.</p>
          <p className="prompt wl-block-card" data-testid="wl-prompt">{task.gappedEn}</p>
          <p lang="ru" className="wl-sentence-ru" data-testid="wl-sentence-ru"><span className="muted small">Перевод предложения</span><br />{task.ru}</p>
        </div>
      )}
      {stage === 3 && task?.stage === 3 && (
        <div data-testid="wl-stage3">
          <p className="format-tag"><i className="pi pi-graduation-cap" aria-hidden="true" /> {task.construction}</p>
          <p className="instruction">{task.instruction}</p>
          <p className="prompt" data-testid="wl-prompt">{task.sourceEn}</p>
        </div>
      )}
      {stage === 4 && task?.stage === 4 && (
        <div data-testid="wl-stage4">
          <p className="instruction">Say this in English, using <strong>{run.lemma}</strong> and the construction below.</p>
          <p lang="ru" className="prompt ru" data-testid="wl-prompt">{task.cueRu}</p>
          <div className="wl-pattern" data-testid="wl-pattern">
            <p className="format-tag"><i className="pi pi-graduation-cap" aria-hidden="true" /> {task.construction}</p>
            <p><code>{task.pattern}</code></p>
            <p className="muted small">For example: {task.patternExample}</p>
          </div>
        </div>
      )}
      {stage === 5 && task?.stage === 5 && (
        <div data-testid="wl-stage5">
          <p className="instruction">Write one sentence of your own with <strong className="wl-target">{run.lemma}</strong>. Use any construction you like.</p>
          <p className="prompt" data-testid="wl-prompt">{task.situationEn}</p>
          <p lang="ru" className="ru small">{task.situationRu}</p>
          <p className="small">You may use (not all of them): {task.suggestedWords.filter(usable).map((w) => <span key={w} className="chip">{w}</span>)}</p>
        </div>
      )}

      {stage >= 2 && item && (
        <>
          {item.revealed.word && <p className="notice notice-info small" role="status" data-testid="wl-hint-word">The word: <strong>{item.revealed.word}</strong></p>}
          {item.revealed.start && <p className="notice notice-info small" role="status" data-testid="wl-hint-start">Start like this: <strong>{item.revealed.start}</strong> …</p>}
          {item.revealed.partial && !item.revealed.full && <p className="notice notice-info small" role="status" data-testid="wl-hint-partial">Part of the answer: <strong>{item.revealed.partial}</strong> …</p>}
          {item.revealed.full && stage !== 2 && <p className="notice notice-info small" role="status" data-testid="wl-hint-full">Full answer: <strong>{item.revealed.full}</strong></p>}
          {item.revealed.translationRu && <p lang="ru" className="vocab-translation" role="status" data-testid="wl-translation">{item.revealed.translationRu}</p>}
        </>
      )}

      {stage >= 2 && canType && (
        <div className="wl-answer">
          <label htmlFor="wl-text" className="visually-hidden">Your answer</label>
          {stage === 2 ? (
            <div className="wl-gap-row">
              <input id="wl-text" ref={(el) => { field.current = el; }} className="gap-input" maxLength={80} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void submit()} placeholder="one word" autoComplete="off" spellCheck={false} autoFocus data-testid="wl-input" />
              <span lang="ru" className="wl-word-tr" title="The word in Russian" data-testid="wl-word-tr">{word.translationRu}</span>
            </div>
          ) : (
            <textarea id="wl-text" ref={(el) => { field.current = el; }} rows={2} maxLength={600} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder="Type your sentence" autoFocus data-testid="wl-input" />
          )}
          {run.voice && <VoiceBar voice={voice} busy={busy} hasDraft={draftId !== null} />}
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void submit()} data-testid="wl-check">Check <i className="pi pi-check" aria-hidden="true" /></button>
            <HintButtons stage={stage} kinds={kinds} busy={busy} onEvent={(k) => void event(k)} />
          </div>
        </div>
      )}

      {waiting && (
        <p className="feedback feedback-pending" role="status" data-testid="wl-waiting">
          <i className="pi pi-spin pi-spinner" aria-hidden="true" /> The local AI is checking your sentence…
        </p>
      )}

      {stage >= 2 && last && feedbackShown && !waiting && <DailyGoalCheck mode="wordLesson" trigger={last.id} />}
      {stage >= 2 && last && feedbackShown && !waiting && (
        <Feedback
          attempt={last}
          stage={stage}
          busy={busy}
          done={done}
          reference={item?.revealed.full}
          final={run.currentKey === null && done}
          onTryAgain={tryAgain}
          onContinue={continueNow}
          onNext={goNext}
          onDispute={() => void call(() => api.disputeWordLessonAttempt(run.runId, last.id))}
        />
      )}
      {stage >= 2 && done && !feedbackShown && run.status === "active" && (
        <div className="actions"><button className="btn btn-primary has-kbd" autoFocus onClick={goNext} data-testid="wl-next"><Kbd k="Enter" /> {nextLabel} <i className="pi pi-arrow-right" aria-hidden="true" /></button></div>
      )}
    </section>
  );
}

function HintButtons({ stage, kinds, busy, onEvent }: { stage: number; kinds: Set<string>; busy: boolean; onEvent: (k: "hint_word" | "hint_partial" | "hint_full" | "translation" | "hint_start") => void }) {
  if (stage === 2) return <button className="btn" disabled={busy || kinds.has("hint_word")} onClick={() => onEvent("hint_word")} data-testid="wl-hint"><i className="pi pi-lightbulb" aria-hidden="true" /> Hint</button>;
  if (stage === 5) return <button className="btn" disabled={busy || kinds.has("hint_start")} onClick={() => onEvent("hint_start")} data-testid="wl-hint"><i className="pi pi-lightbulb" aria-hidden="true" /> Hint</button>;
  const second = kinds.has("hint_partial");
  return (
    <>
      <button className="btn" disabled={busy || kinds.has("hint_full")} onClick={() => onEvent(second ? "hint_full" : "hint_partial")} data-testid="wl-hint">
        <i className="pi pi-lightbulb" aria-hidden="true" /> {second ? "Hint: full answer" : "Hint"}
      </button>
      {stage === 3 && (
        <button className="btn" disabled={busy || kinds.has("translation")} onClick={() => onEvent("translation")} data-testid="wl-translate">
          <i className="pi pi-language" aria-hidden="true" /> Show Russian Translation
        </button>
      )}
    </>
  );
}

function Feedback({ attempt, stage, busy, done, final, reference, onTryAgain, onContinue, onNext, onDispute }: { attempt: WordLessonAttemptView; stage: number; busy: boolean; done: boolean; final: boolean; reference: string | undefined; onTryAgain: () => void; onContinue: () => void; onNext: () => void; onDispute: () => void }) {
  const f = attempt.feedback;
  const v = attempt.verdict;
  const ok = v === "correct";
  const shownText = f.correctedEn ?? reference ?? null;
  const title = ok ? "Correct" : v === "disputed" ? "You disagreed with this check" : v === "unresolved" ? "Could not be checked now" : stage === 2 ? "Not this word" : "Not quite";
  return (
    <div className={`feedback feedback-${ok ? "ok" : v === "unresolved" || v === "disputed" ? "info" : "again"}`} data-testid="wl-feedback" data-verdict={v} aria-live="polite">
      <p className="feedback-title">
        <i className={`pi ${ok ? "pi-check-circle" : v === "incorrect" ? "pi-times-circle" : "pi-info-circle"}`} aria-hidden="true" /> {title}
      </p>
      <p className={`wl-yours wl-yours-${ok ? "ok" : v === "incorrect" ? "bad" : "plain"}`} data-testid="wl-yours">
        <span className="wl-yours-label">Your answer</span> {attempt.answerText}
      </p>
      {!ok && f.issues.length > 0 && (
        <ul className="wl-issues">
          {f.issues.map((i, k) => (
            <li key={k}>
              {i.fragment && <code>{i.fragment}</code>} <span lang="ru">{i.problemRu}</span>
              {i.fixEn && <> → <strong>{i.fixEn}</strong></>}
            </li>
          ))}
        </ul>
      )}
      {f.commentRu && <p lang="ru" className="ru">{f.commentRu}</p>}
      {!ok && stage !== 2 && shownText && <p data-testid="wl-corrected">{v === "unresolved" ? "A model answer" : "A correct version"}: <strong>{shownText}</strong></p>}
      {v === "unresolved" && <p className="muted small">Your answer is saved. The check may still arrive later.</p>}
      <div className="actions">
        {ok || done ? (
          <button className="btn btn-primary has-kbd" autoFocus disabled={busy} onClick={onNext} data-testid="wl-next"><Kbd k="Enter" /> {final ? "Finish lesson" : "Next"} <i className="pi pi-arrow-right" aria-hidden="true" /></button>
        ) : (
          <>
            <button className={`btn${stage === 2 ? " btn-primary has-kbd" : ""}`} disabled={busy} onClick={onTryAgain} data-testid="wl-retry">{stage === 2 && <Kbd k="Enter" />}<i className="pi pi-replay" aria-hidden="true" /> Try again</button>
            {stage !== 2 && <button className="btn btn-primary has-kbd" disabled={busy} onClick={onContinue} data-testid="wl-continue"><Kbd k="Enter" /> Continue <i className="pi pi-arrow-right" aria-hidden="true" /></button>}
            {attempt.disputable && <button className="btn" disabled={busy} onClick={onDispute} data-testid="wl-dispute"><i className="pi pi-flag" aria-hidden="true" /> Disagree with AI</button>}
          </>
        )}
      </div>
    </div>
  );
}

