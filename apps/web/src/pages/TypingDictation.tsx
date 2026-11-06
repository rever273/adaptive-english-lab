import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import * as api from "../api";
import type { DictationResult, DictationState } from "../api";
import { cyrillicOnly, hintFocus, markTyped, type MarkedSegment } from "../game/dictationMarks";
import { ActiveClock, advance, applyAnswer, createDictationEngine, currentExercise, markChecking, setText, setWords, submitCheck } from "../game/dictationEngine";
import { DictationScene } from "../game/dictationScene";
import { playPracticeSound } from "../practiceSounds";
import { fmtTotalTime } from "../format";
import { LAYOUT_HINT, Toast, useToast } from "./typingShared";

const MASK = "•••";
const NEXT_DELAY_MS = 800;

/** One audio controller per screen: Blob URLs cached per sentence, the previous sound is stopped before the next one starts. */
function useDictationAudio(lessonId: string) {
  const urls = useRef(new Map<string, Promise<string>>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const stop = useCallback(() => {
    audio.current?.pause();
    if (audio.current) audio.current.currentTime = 0;
    setPlaying(false);
  }, []);
  const load = useCallback((exerciseId: string): Promise<string> => {
    let p = urls.current.get(exerciseId);
    if (!p) {
      p = api.fetchDictationAudio(exerciseId).then((b) => URL.createObjectURL(b));
      p.catch(() => urls.current.delete(exerciseId));
      urls.current.set(exerciseId, p);
    }
    return p;
  }, []);
  /** resolves true when the browser really started the sound (an autoplay block after a reload is not an error) */
  const play = useCallback(async (exerciseId: string, source: "auto" | "manual" | "wrong_answer"): Promise<boolean> => {
    try {
      const url = await load(exerciseId);
      audio.current?.pause();
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => setPlaying(false);
      a.onpause = () => setPlaying(false);
      await a.play();
      setPlaying(true);
      void api.sendDictationPlay(exerciseId, source).catch(() => {});
      return true;
    } catch {
      setPlaying(false);
      return false;
    }
  }, [load]);
  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hide);
    const map = urls.current;
    return () => {
      document.removeEventListener("visibilitychange", hide);
      audio.current?.pause();
      for (const p of map.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      map.clear();
    };
  }, [lessonId, stop]);
  return { play, stop, load, playing };
}

export function DictationGame({ state, onResult, onExit }: { state: DictationState; onResult: (r: DictationResult) => void; onExit: () => void }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const engineRef = useRef(createDictationEngine(state));
  const engine = engineRef.current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<DictationScene | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const clock = useRef(new ActiveClock(state.activeMs));
  const soundsRef = useRef(true);
  const audio = useDictationAudio(state.lessonId);
  const playingRef = useRef(false);
  /** sentences played to the end of a start in this session: only a sentence you have heard can be marked */
  const heardRef = useRef(new Set<string>());
  playingRef.current = audio.playing;
  const [layoutNotice, showLayoutNotice] = useToast();
  const [message, setMessage] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const busyRef = useRef(false);
  // wrong words are shown only after Enter or Hint, for exactly the text that was checked; any edit clears them
  const [marks, setMarks] = useState<{ text: string; segments: MarkedSegment[] } | null>(null);
  // typing time of the current attempt (gaps over 5 s between keys do not count) and keys pressed; sent with every answer
  const typing = useRef({ ms: 0, last: 0, keys: 0 });

  useEffect(() => {
    let active = true;
    void api.fetchSettings().then((s) => { if (active) soundsRef.current = s.values.typingSoundsEnabled ?? true; }).catch(() => {});
    return () => { active = false; };
  }, []);

  // the scene
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new DictationScene(canvas, () => ({ total: engine.exercises.length, active: engine.current, done: new Set(engine.exercises.flatMap((e, i) => (e.done ? [i] : []))), playing: playingRef.current }), state.level);
    sceneRef.current = scene;
    scene.start();
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(canvas);
    return () => { scene.stop(); ro.disconnect(); sceneRef.current = null; };
  }, [engine, state.level]);

  // active time: monotonic clock, only while visible and (sound playing or a key within 30 s); sent every 15 s and when the page is hidden
  useEffect(() => {
    let lastSent = clock.current.ms;
    const path = `/api/v1/typing/dictation/lessons/${encodeURIComponent(state.lessonId)}/time`;
    const tick = window.setInterval(() => clock.current.tick(performance.now(), { visible: !document.hidden, playing: playingRef.current }), 250);
    const send = window.setInterval(() => {
      if (clock.current.ms > lastSent) { lastSent = clock.current.ms; void api.sendDictationTime(state.lessonId, Math.round(lastSent)).catch(() => {}); }
    }, 15000);
    const flush = () => { if (clock.current.ms > lastSent) { lastSent = clock.current.ms; void api.sendKeepalive(path, { activeMs: Math.round(lastSent) }); } };
    const onVis = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => { window.clearInterval(tick); window.clearInterval(send); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pagehide", flush); flush(); };
  }, [state.lessonId]);

  const play = useCallback(async (source: "auto" | "manual" | "wrong_answer") => {
    const ex = currentExercise(engine);
    if (!ex) return;
    const ok = await audio.play(ex.id, source);
    if (!ok && source === "auto") setMessage("Press F2 or Play to hear the sentence.");
    else if (ok) { setMessage(null); heardRef.current.add(ex.id); }
    const next = engine.exercises[(engine.current ?? 0) + 1];
    if (next) void audio.load(next.id).catch(() => {});
    bump();
  }, [audio, engine]);

  // the first sentence starts by itself (the browser may refuse after a reload: then the button says what to do)
  useEffect(() => {
    if (engine.phase === "listening") void play("auto");
    const t = timers.current;
    return () => { for (const id of t) window.clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showTranslation = useCallback(async () => {
    const ex = currentExercise(engine);
    if (!ex || busyRef.current || ex.translationRu !== null) return;
    try {
      const r = await api.openDictationTranslation(ex.id);
      ex.translationRu = r.translationRu;
      bump();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not open the translation."); }
    inputRef.current?.focus();
  }, [engine]);

  // D128: "Sounds bad" lowers how often this voice is chosen; it changes nothing about the answer or the credit
  const toggleSoundFlag = useCallback(async () => {
    const ex = currentExercise(engine);
    if (!ex) return;
    try {
      const r = await api.setDictationSoundFlag(ex.id, !ex.soundFlagged);
      ex.soundFlagged = r.flagged;
      bump();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not save the mark."); }
    inputRef.current?.focus();
  }, [engine]);

  const hint = useCallback(async () => {
    const ex = currentExercise(engine);
    if (!ex || busyRef.current || engine.phase !== "listening") return;
    try {
      if (engine.text.trim().length > 0) setMarks({ text: engine.text, segments: markTyped(engine.text, ex.textEn, true) });
      const r = await api.requestDictationHint(ex.id, engine.text);
      if (!r.applied) setMessage(r.words.every((w) => w.text !== null) ? "The whole sentence is already shown." : stuckNote(engine.text, ex.words));
      else { setWords(engine, r.words, r.hintLevel); setMessage(null); }
      bump();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not get a hint."); }
    inputRef.current?.focus();
  }, [engine]);

  const reveal = useCallback(async () => {
    const ex = currentExercise(engine);
    if (!ex || busyRef.current || engine.phase !== "listening") return;
    try {
      const r = await api.revealDictationAnswer(ex.id);
      setWords(engine, r.words, r.hintLevel);
      setMessage(r.applied ? "The answer is shown. Type it to continue: this sentence earns no credit." : null);
      bump();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not show the answer."); }
    inputRef.current?.focus();
  }, [engine]);

  const submit = useCallback(async () => {
    const check = submitCheck(engine);
    if (check === "layout") { showLayoutNotice(); return; }
    if (check !== "ok") return;
    const ex = currentExercise(engine)!;
    busyRef.current = true;
    markChecking(engine);
    bump();
    try {
      const r = await api.answerDictation(ex.id, { attemptId: engine.attemptId, text: engine.text, activeMs: Math.round(clock.current.ms), typingMs: Math.round(typing.current.ms), keystrokes: typing.current.keys });
      typing.current = { ms: 0, last: 0, keys: 0 };
      const verdict = applyAnswer(engine, r);
      if (verdict === "wrong") {
        setMarks({ text: engine.text, segments: markTyped(engine.text, ex.textEn, true) });
        setMessage(engine.notice);
        busyRef.current = false;
        bump();
        void play("wrong_answer");
        inputRef.current?.focus();
        return;
      }
      audio.stop();
      const index = engine.current!;
      sceneRef.current?.destroy(index);
      playPracticeSound("shoot", soundsRef.current);
      timers.current.push(window.setTimeout(() => playPracticeSound("explode", soundsRef.current), 150));
      if (r.xpAwarded > 0) api.announceXp();
      bump();
      timers.current.push(window.setTimeout(async () => {
        busyRef.current = false;
        if (r.lessonCompleted || r.nextOrdinal === null) {
          api.announceXp();
          try { onResult(await api.fetchDictationResult(state.lessonId)); } catch { onExit(); }
          return;
        }
        advance(engine, r.nextOrdinal);
        setMarks(null);
        setMessage(null);
        bump();
        inputRef.current?.focus();
        void play("auto");
      }, NEXT_DELAY_MS));
    } catch (e) {
      engine.phase = "listening";
      busyRef.current = false;
      setMessage(e instanceof Error ? e.message : "Could not check the answer.");
      bump();
    }
  }, [audio, engine, onExit, onResult, play, showLayoutNotice, state.lessonId]);

  // F2 / F3 / F4 work while the answer field has the focus (the Words and Books handlers ignore fields, so they are not reused)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.key === "F2") { e.preventDefault(); if (!e.repeat) void play("manual"); return; }
      if (e.key === "F3") { e.preventDefault(); if (!e.repeat) void showTranslation(); return; }
      if (e.key === "F4") { e.preventDefault(); if (!e.repeat) void hint(); return; }
      if (e.key === "F5") { e.preventDefault(); if (!e.repeat) void reveal(); return; }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [hint, play, reveal, showTranslation]);

  const ex = currentExercise(engine);
  const busy = engine.phase !== "listening";
  const focus = ex && !ex.done && ex.hintLevel > 0 ? hintFocus(ex.words) : null;
  const marked = marks && marks.text === engine.text ? marks.segments : cyrillicOnly(engine.text);
  return (
    <div className="dictation-game" data-no-word>
      <div className="typing-hud">
        <strong>Audio Dictation · Level {String(state.level).padStart(2, "0")}</strong>
        <span className="muted">{engine.exercises.filter((e) => e.done).length} / {engine.exercises.length} sentences</span>
        <button className="btn" onClick={onExit}>Leave (progress is kept)</button>
      </div>
      <div className="dictation-stage">
        <canvas ref={canvasRef} className="typing-canvas dictation-canvas" aria-label="Audio Dictation game" />
        {layoutNotice && <Toast text={LAYOUT_HINT} />}
      </div>
      {ex && (
        <>
          {ex.isRepeat && <p className="muted small dictation-repeat">Repeat: you made mistakes in this sentence before.</p>}
          <p className="dictation-words" aria-live="polite" aria-label="Revealed words">
            {ex.words.map((w) => <span key={w.index} className={w.text === null ? "dictation-masked" : w.index === focus ? "dictation-shown dictation-focus" : "dictation-shown"}>{w.text ?? MASK}</span>)}
          </p>
          {ex.translationRu !== null && <p className="dictation-translation" lang="ru">{ex.translationRu}</p>}
          <div className="dictation-field">
            <div className="dictation-mirror" aria-hidden="true">
              {marked.map((s, i) => (s.wrong ? <span key={i} className="dictation-wrong">{s.text}</span> : <span key={i}>{s.text}</span>))}
              {"\u200b"}
            </div>
          <textarea
            ref={inputRef}
            className="dictation-input"
            rows={3}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="Type what you hear"
            aria-label="Type the sentence you hear"
            value={engine.text}
            disabled={busy && engine.phase === "checking"}
            onChange={(e) => {
              clock.current.input(performance.now());
              // a Russian layout is only a reminder (as in Words): the letters turn red and a notice asks to switch
              if (/[Ѐ-ӿ]/.test(e.target.value.slice(engine.text.length > e.target.value.length ? 0 : engine.text.length))) showLayoutNotice();
              setText(engine, e.target.value);
              bump();
            }}
            onKeyDown={(e) => {
              const now = performance.now();
              clock.current.input(now);
              if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === "Backspace")) {
                const t = typing.current;
                if (t.last > 0 && now - t.last <= 5000) t.ms += now - t.last;
                t.last = now;
                t.keys++;
              }
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            }}
          />
          </div>
          <p className="dictation-message muted small" role="status">{message ?? engine.notice ?? " "}</p>
          <div className="actions">
            <button className="btn" onClick={() => { void play("manual"); inputRef.current?.focus(); }} disabled={busy}><i className="pi pi-volume-up" aria-hidden="true" /> Play (F2)</button>
            <button className="btn" onClick={() => void showTranslation()} disabled={busy || ex.translationRu !== null} title="Counts as help: the sentence is then worth at most half">Show Russian Translation (F3)</button>
            <button className="btn" onClick={() => void hint()} disabled={busy} title="Shows the sentence up to the first word you got wrong. A hint costs a little of the credit.">Hint (F4)</button>
            <button className="btn" onClick={() => void reveal()} disabled={busy} title="Shows the whole sentence; you still type it, but it earns no credit">Show answer (F5)</button>
            <button className="btn" onClick={() => void toggleSoundFlag()} disabled={busy || (ex.plays === 0 && !heardRef.current.has(ex.id))} aria-pressed={ex.soundFlagged} title="Tell us this voice sounded unclear or unpleasant here. It lowers how often this voice is used.">{ex.soundFlagged ? "Marked as bad sound — undo" : "Sounds bad"}</button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>Check (Enter)</button>
          </div>
        </>
      )}
    </div>
  );
}

const ERROR_LABEL: Record<string, string> = { articles: "articles", auxiliary_verbs: "auxiliary verbs", prepositions: "prepositions", word_endings: "word endings", contractions: "contractions", vocabulary: "wrong word", word_order: "word order", missing_word: "missing word", extra_word: "extra word" };
const OUTCOME: Record<string, string> = { no_help: "full credit", partial: "part credit", full_reveal: "no credit" };

/** what a hint can say when it shows nothing new */
function stuckNote(text: string, words: Array<{ text: string | null }>): string {
  return text.trim().length === 0 || words.some((w) => w.text === null) ? "Everything up to your first mistake is already shown above." : "Your answer looks complete. Press Enter.";
}

export function DictationResultView({ result, onNext, onDone }: { result: DictationResult; onNext: () => void; onDone: () => void }) {
  const stats: Array<[string, string, string]> = [
    ["Score", String(result.score), "Average credit of the sentences, 0 to 100. Each mistake costs part of a sentence; a hint costs half a mistake; the translation caps a sentence at half; showing the answer (F5) removes it."],
    ["XP", String(result.xpAwarded), "Typing XP: up to 6 per sentence, in proportion to its credit."],
    ["WPM", result.wpm === null ? "—" : String(Math.round(result.wpm)), "Words per minute while typing: correct characters / 5 per minute of typing. Time spent listening is not counted."],
    ["CPM", result.cpm === null ? "—" : String(result.cpm), "Characters per minute of typing (WPM × 5)."],
    ["Right first time", `${result.firstAttemptCorrect} / ${result.sentences}`, "Sentences typed correctly on the first try."],
    ["No help", `${result.noHelp} / ${result.sentences}`, "Sentences with full credit: no mistakes, no hints, no translation."],
    ["Wrong answers", String(result.wrongSubmissions), "Answers you submitted that were not correct."],
    ["Replays", String(result.manualReplays), "Replays you pressed yourself (F2 or Play); automatic repeats are not counted."],
    ["Plays per sentence", String(result.avgPlaysPerSentence), "All playbacks of a sentence, automatic ones included."],
    ["Time", fmtTotalTime(result.activeMs / 1000), "Active time: listening and typing, not pauses."],
  ];
  const columns = Math.ceil(stats.length / 2); // exactly two rows, like Words and Books
  return (
    <section className="typing-result card" aria-label="Audio Dictation result">
      <h2>Level {String(result.level).padStart(2, "0")} complete</h2>
      <div className="stat-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {stats.map(([label, value, tip]) => <div className="stat typing-stat" key={label} tabIndex={0} role="group" aria-label={`${label}: ${value}. ${tip}`} data-tip={tip}><span className="stat-num">{value}</span><span className="stat-label">{label}</span></div>)}
      </div>
      <p className="muted small">The sentences are AI-written, not reviewed. Hover a number for what it means.</p>
      <details className="dictation-list">
        <summary>All {result.sentences} sentences</summary>
        <ol>
          {result.items.map((it) => (
            <li key={it.ordinal}>
              <p><strong>{it.textEn}</strong> <span className="muted small">({OUTCOME[it.outcome]}, {it.maxHintLevel} {it.maxHintLevel === 1 ? "hint" : "hints"}, {it.plays} plays, {it.attempts} {it.attempts === 1 ? "try" : "tries"})</span></p>
              <p className="muted small" lang="ru">{it.translationRu}</p>
              {it.errorTypes.length > 0 && <p className="muted small">Mistakes: {[...new Set(it.errorTypes)].map((t) => ERROR_LABEL[t] ?? t).join(", ")}</p>}
              {it.attempts > 1 || it.diff.some((d) => d.op !== "same") ? (
                <p className="small">First answer: {it.firstAnswer ? it.diff.map((d, i) => <span key={i} className={`dictation-diff-${d.op}`}>{d.op === "missing" ? `[${d.expected}]` : d.op === "extra" ? `${d.typed}` : d.op === "wrong" ? `${d.typed} → ${d.expected}` : d.typed} </span>) : "—"}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
      <div className="actions">
        <button className="btn btn-primary" onClick={onNext}>Generate next lesson</button>
        <button className="btn" onClick={onDone}>Back to Typing</button>
      </div>
    </section>
  );
}
