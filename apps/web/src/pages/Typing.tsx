import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { DictationResult, DictationState, TypingRecallWord, TypingBookStartResponse, TypingOverview, TypingResult, TypingWordsStartResponse } from "../api";
import { TypingKeyboard } from "../components/TypingKeyboard";
import { WordsScene } from "../game/scene";
import { firstTranslation } from "../format";
import { playPracticeSound } from "../practiceSounds";
import { BooksGame } from "./TypingBooks";
import { DictationGame, DictationResultView } from "./TypingDictation";
import { TypingRecall } from "./TypingRecall";
import { LAYOUT_HINT, Toast, useToast } from "./typingShared";
import { comboMultiplier, createWordsEngine, exportKeyStats, revealTranslation, type WordsEngineState, type WordsEvent } from "../game/wordsEngine";

type Screen = { kind: "overview" } | { kind: "words"; sessionId: string; level: number; plan: TypingWordsStartResponse; paused: boolean } | { kind: "books"; sessionId: string; data: TypingBookStartResponse; paused: boolean } | { kind: "result"; result: TypingResult; struggled?: string[]; bonus?: { points: number } } | { kind: "recall"; result: TypingResult; struggled?: string[]; words: TypingRecallWord[] } | { kind: "dictation"; state: DictationState } | { kind: "dictationResult"; result: DictationResult };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const fallMs = (len: number, msPerChar: number) => Math.round(clamp(3 * len * msPerChar + 2500, 5000, 22000));
/** a new meteor arrives after the time to type the previous word plus 60% (reading and aiming) and 0.6 s */
const spawnGapMs = (len: number, msPerChar: number) => Math.round(1.6 * len * msPerChar + 600);

export function Typing({ onNavigate }: { onNavigate?: (page: "analytics") => void }) {
  const [overview, setOverview] = useState<TypingOverview | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "overview" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.fetchTypingOverview().then(setOverview).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  const [dictNote, setDictNote] = useState<string | null>(null);
  // while dictation tracks are being made (a lesson or prepared ones) the card follows the progress
  const generating = overview?.dictation.lesson?.status === "generating" || (overview?.dictation.pool.generating ?? 0) > 0;
  useEffect(() => {
    if (!generating || screen.kind !== "overview") return;
    const id = window.setInterval(load, 2500);
    return () => window.clearInterval(id);
  }, [generating, screen.kind, load]);

  if (error && screen.kind === "overview") return <p role="alert">{error}</p>;
  if (!overview) return <p className="muted">Loading typing practice…</p>;

  if (screen.kind === "dictation") return <section className="typing-page" aria-label="Audio Dictation"><DictationGame state={screen.state} onResult={(result) => setScreen({ kind: "dictationResult", result })} onExit={() => { load(); setScreen({ kind: "overview" }); }} /></section>;
  if (screen.kind === "dictationResult") {
    const toOverview = () => { load(); setScreen({ kind: "overview" }); };
    return <DictationResultView result={screen.result} onDone={toOverview} onNext={() => { void api.createDictationLesson().catch((e) => setDictNote(e instanceof Error ? e.message : String(e))).finally(toOverview); }} />;
  }

  if (screen.kind === "recall") {
    return <section className="typing-page" aria-label="Memory check"><TypingRecall sessionId={screen.result.sessionId} words={screen.words} onDone={(bonus) => setScreen({ kind: "result", result: screen.result, ...(screen.struggled ? { struggled: screen.struggled } : {}), ...(bonus ? { bonus } : {}) })} /></section>;
  }

  if (screen.kind === "result") {
    const mode = screen.result.mode;
    const toOverview = () => { load(); setScreen({ kind: "overview" }); };
    // Continue goes straight into the next level / next book passage; if that cannot start, fall back to the overview
    const next = async () => {
      const started = mode === "words" ? await startWords(setScreen, setError) : await startBook(setScreen, setError);
      if (!started) toOverview();
    };
    return <WordsResult result={screen.result} struggled={screen.struggled} bonus={screen.bonus} onContinue={() => void next()} onDone={toOverview} />;
  }

  return (
    <section className="typing-page" aria-label="Typing practice">
      {screen.kind === "overview" && (
        <>
          <h2 id="typing-h"><i className="pi pi-bullseye" aria-hidden="true" /> Typing practice</h2>
          <div className="typing-cards">
            <ModeCard
              image="/typing/words.jpg"
              icon="pi-bolt"
              title="Words"
              desc="Arcade training: type words to destroy falling meteors with your ship."
              action={overview.words.activeSessionId ? "Continue" : "Start Practice"}
              level={overview.words.nextLevel}
              disabled={overview.words.bankWords === 0}
              disabledNote={overview.words.bankWords === 0 ? "The word bank is empty. Run the typing seed first." : null}
              onStart={() => void startWords(setScreen, setError)}
            />
            <ModeCard
              image="/typing/books.jpg"
              icon="pi-book"
              title="Books"
              desc="Calm practice: type a classic book one sentence at a time. No way to lose."
              action={overview.books.activeSessionId ? "Continue" : overview.books.finished ? "Finished" : "Start Reading"}
              level={overview.books.level}
              subtitle={overview.books.available ? overview.books.title ?? undefined : undefined}
              disabled={!overview.books.available || overview.books.finished}
              disabledNote={!overview.books.available ? bookReason(overview.books.reason) : overview.books.finished ? "You have finished the book." : null}
              onStart={() => void startBook(setScreen, setError)}
            />
            <ModeCard
              image="/typing/dictation.jpg"
              icon="pi-volume-up"
              title="Audio Dictation"
              desc="Listen to an Australian English sentence and type it. Nothing is shown until you ask for a hint."
              action={dictationAction(overview.dictation)}
              level={overview.dictation.nextLevel}
              disabled={!overview.dictation.available && !overview.dictation.lesson || overview.dictation.lesson?.status === "generating"}
              disabledNote={dictNote ?? dictationNote(overview.dictation)}
              onStart={() => void runDictation(overview.dictation, setScreen, setDictNote, load)}
            />
          </div>
          {/* {onNavigate && (
            <p className="actions page-actions">
              <button className="btn" onClick={() => onNavigate("analytics")}><i className="pi pi-chart-line" aria-hidden="true" /> Typing analytics</button>
            </p>
          )} */}
        </>
      )}
      {screen.kind === "words" && <WordsGame screen={screen} setScreen={setScreen} onExit={() => setScreen({ kind: "overview" })} />}
      {screen.kind === "books" && <BooksGame sessionId={screen.sessionId} data={screen.data} onResult={(result, struggled) => setScreen({ kind: "result", result, struggled })} onExit={() => setScreen({ kind: "overview" })} />}
    </section>
  );
}

function dictationAction(d: TypingOverview["dictation"]): string {
  const l = d.lesson;
  if (!l) return "Generate Next Lesson";
  if (l.status === "generating") return `Generating… ${l.ready} / ${l.total} ready`;
  if (l.status === "failed") return "Retry";
  return l.started ? "Continue" : "Start";
}

function dictationNote(d: TypingOverview["dictation"]): string | null {
  if (d.lesson?.status === "failed") return "Generating this lesson failed. Retry makes only the missing sentences.";
  if (d.available) return null;
  if (d.reason === "asr_unavailable") return "No speech check is available: set a Groq key in .env or install the local Whisper large-v3 model.";
  return "Piper is not installed. Run `npm run dictation:setup`.";
}

async function runDictation(d: TypingOverview["dictation"], setScreen: (s: Screen) => void, setNote: (n: string | null) => void, reload: () => void): Promise<void> {
  setNote(null);
  try {
    const l = d.lesson;
    if (!l) await api.createDictationLesson();
    else if (l.status === "failed") await api.retryDictationLesson(l.id);
    else if (l.status === "ready") { setScreen({ kind: "dictation", state: await api.startDictationLesson(l.id) }); return; }
  } catch (e) {
    setNote(e instanceof Error ? e.message : String(e));
  }
  reload();
}

function bookReason(reason: string | null): string {
  if (reason === "file_missing" || reason === "file_changed") return "The book file is missing or changed. Run `npm run typing:prepare-book`.";
  if (reason === "no_book") return "No book is prepared yet. Run `npm run typing:prepare-book`.";
  return "The book is not available.";
}

function ModeCard({ image, icon, title, desc, action, level, subtitle, disabled, disabledNote, onStart, children }: { image: string; icon: string; title: string; desc: string; action: string; level: number; subtitle?: string; disabled: boolean; disabledNote: string | null; onStart: () => void; children?: React.ReactNode }) {
  return (
    <div className={`card typing-mode-card${disabled ? " disabled" : ""}`}>
      <img className="typing-card-image" src={image} alt="" loading="lazy" />
      <h3><i className={`pi ${icon}`} aria-hidden="true" /> {title}</h3>
      <p className="muted small">{desc}</p>
      {subtitle && <p className="muted small">Book: {subtitle}</p>}
      <p className="typing-level">{action} <span className="muted">(Level {String(level).padStart(2, "0")})</span></p>
      {disabledNote && <p className="notice notice-warning small" role="status">{disabledNote}</p>}
      {children}
      <button className="btn btn-primary typing-card-action" disabled={disabled} onClick={onStart} data-testid={`typing-${title.toLowerCase()}-start`}>{action}</button>
    </div>
  );
}

async function startWords(setScreen: (s: Screen) => void, setError: (e: string | null) => void): Promise<boolean> {
  try {
    const plan = await api.startTypingWords();
    setScreen({ kind: "words", sessionId: plan.sessionId, level: plan.level, plan, paused: false });
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function startBook(setScreen: (s: Screen) => void, setError: (e: string | null) => void): Promise<boolean> {
  try {
    const data = await api.startTypingBook();
    setScreen({ kind: "books", sessionId: data.sessionId, data, paused: false });
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Pronunciation of My Vocabulary words: the server serves the stored audio file (or asks the TTS service once and stores it), so the
 * clips are fetched when the level starts and played the moment the first letter of that meteor is typed. Never blocks the game.
 */
function useWordPronunciation(words: TypingWordsStartResponse["words"]): { speak: (planIndex: number) => void } {
  const clips = useRef(new Map<number, Promise<string | null>>());
  const current = useRef<HTMLAudioElement | null>(null);
  const urls = useRef<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const map = clips.current;
    void (async () => {
      let enabled = false;
      try { enabled = (await api.fetchVocabularySpeech()).enabled; } catch { /* no speech: the game goes on silently */ }
      if (!enabled) return;
      for (const w of words) {
        if (cancelled) return;
        if (w.source !== "vocabulary" || !w.vocabularyEntryId) continue;
        const id = w.vocabularyEntryId;
        const clip = api.vocabularyWordSpeech(id).then((blob) => {
          if (!blob || cancelled) return null;
          const url = URL.createObjectURL(blob);
          urls.current.push(url);
          return url;
        }).catch(() => null);
        map.set(w.planIndex, clip);
        await clip; // one at a time: stored files return at once, missing ones are generated gently
      }
    })();
    return () => {
      cancelled = true;
      current.current?.pause();
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
      map.clear();
    };
  }, [words]);
  const speak = useCallback((planIndex: number) => {
    void clips.current.get(planIndex)?.then((url) => {
      if (!url) return;
      current.current?.pause();
      const audio = new Audio(url);
      current.current = audio;
      void audio.play().catch(() => {});
    });
  }, []);
  return useMemo(() => ({ speak }), [speak]);
}

/* ---------------- Words ---------------- */

function WordsGame({ screen, setScreen, onExit }: { screen: Extract<Screen, { kind: "words" }>; setScreen: (s: Screen) => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WordsScene | null>(null);
  const engineRef = useRef<WordsEngineState | null>(null);
  const [paused, setPaused] = useState(screen.paused);
  const pausedRef = useRef(screen.paused);
  const [hud, setHud] = useState<{ destroyed: number; total: number }>({ destroyed: 0, total: screen.plan.targetCount });
  // the speed on this level so far (correct letters per minute of active time) and the combo, refreshed while the game runs
  const [live, setLive] = useState<{ wpm: number | null; score: number; streak: number }>({ wpm: null, score: 0, streak: 0 });
  const [layoutNotice, showLayoutNotice] = useToast();
  const finishing = useRef(false);
  const pronunciation = useWordPronunciation(screen.plan.words);
  const soundsRef = useRef(true);
  useEffect(() => {
    let active = true;
    void api.fetchSettings().then((settings) => { if (active) soundsRef.current = settings.values.typingSoundsEnabled ?? true; }).catch(() => {});
    return () => { active = false; };
  }, []);

  // build engine once
  if (!engineRef.current) {
    const engine = createWordsEngine({
      plan: screen.plan.words,
      fallMs: (len) => fallMs(len, screen.plan.speed.msPerChar),
      spawnGapMs: (len) => spawnGapMs(len, screen.plan.speed.msPerChar),
      maxActive: 4,
    });
    engineRef.current = engine;
  }

  const finish = useCallback((status: "completed" | "failed") => {
    if (finishing.current) return;
    finishing.current = true;
    const engine = engineRef.current!;
    void api.completeTypingWords(screen.sessionId, {
      status,
      activeMs: Math.round(engine.activeMs),
      charsTyped: engine.charsTyped,
      errors: engine.errors,
      appearances: engine.appearances,
      destroyedPlanIndexes: engine.destroyedPlanIndexes,
      wordErrors: engine.words.map((w) => ({ planIndex: w.planIndex, errors: w.mistakes })),
      keyStats: exportKeyStats(engine),
      bestCombo: engine.bestStreak,
    }).then(async (result) => {
      api.announceXp();
      // a won level may be followed by the optional memory check of up to three saved words
      if (status === "completed") {
        const recall = await api.fetchTypingRecall(result.sessionId).catch(() => null);
        if (recall && !recall.done && recall.words.length > 0) { setScreen({ kind: "recall", result, words: recall.words }); return; }
      }
      setScreen({ kind: "result", result });
    }).catch(() => setScreen({ kind: "overview" }));
  }, [screen.sessionId, setScreen]);

  const onEvents = useCallback((events: WordsEvent[]) => {
    const engine = engineRef.current!;
    const sound = (kind: Parameters<typeof playPracticeSound>[0]) => playPracticeSound(kind, soundsRef.current);
    for (const e of events) {
      if (e.type === "hit") {
        sound("shoot");
        if (e.word.progress === 1 && e.word.source === "vocabulary") pronunciation.speak(e.word.planIndex);
      } else if (e.type === "miss") {
        sound("incorrect");
      } else if (e.type === "appeared") {
        void api.typingWordAppearances(screen.sessionId, [{ planIndex: e.word.planIndex, order: engine.appearances.find((a) => a.planIndex === e.word.planIndex)?.order ?? engine.appearances.length }]);
      } else if (e.type === "destroyed") {
        window.setTimeout(() => sound("explode"), 150); // lands with the last bolt
        setHud({ destroyed: engine.destroyedCount, total: engine.plan.length });
      } else if (e.type === "won") {
        // let the last explosion play out before the result replaces the scene
        window.setTimeout(() => sound("complete"), 450);
        window.setTimeout(() => void finish("completed"), 1100);
      } else if (e.type === "failed") {
        sound("fail");
        window.setTimeout(() => void finish("failed"), 1100);
      }
    }
  }, [screen.sessionId, finish, pronunciation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (!canvas || !engine) return;
    const scene = new WordsScene(canvas, { config: { plan: screen.plan.words, fallMs: (len) => fallMs(len, screen.plan.speed.msPerChar), spawnGapMs: (len) => spawnGapMs(len, screen.plan.speed.msPerChar), maxActive: 4 }, engine, onEvents, level: screen.level, lanes: 4, paused: () => pausedRef.current });
    sceneRef.current = scene;
    scene.start();
    const onResize = () => scene.resize();
    window.addEventListener("resize", onResize);
    return () => {
      scene.stop();
      window.removeEventListener("resize", onResize);
    };
  }, [screen, onEvents]);

  const togglePause = useCallback(() => {
    setPaused((p) => { pausedRef.current = !p; return !p; });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.getModifierState("AltGraph") || e.isComposing) return;
      if (e.key === "Escape" || e.key === "F2") { e.preventDefault(); if (!e.repeat) togglePause(); return; }
      // F3: the Russian translation of the word being typed (or the most urgent one), also for general words
      if (e.key === "F3") { e.preventDefault(); if (!e.repeat && !pausedRef.current) { const eng = engineRef.current; if (eng) revealTranslation(eng); } return; }
      if (e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); return; } // wrong letters are never shown, nothing to delete
      if (e.key.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (/[Ѐ-ӿ]/.test(e.key)) { showLayoutNotice(); return; } // Russian layout: not an error
      sceneRef.current?.key(e.key);
    };
    const onBlur = () => { pausedRef.current = true; setPaused(true); };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("blur", onBlur); };
  }, [togglePause, showLayoutNotice]);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") { pausedRef.current = true; setPaused(true); } };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const abort = () => {
    const engine = engineRef.current!;
    void api.abortTypingWords(screen.sessionId, { activeMs: Math.round(engine.activeMs), charsTyped: engine.charsTyped, errors: engine.errors });
    onExit();
  };

  // the key hint follows the locked word, or the most urgent word before one is locked
  const [nextChar, setNextChar] = useState<string | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const locked = e.target !== null ? e.words[e.target] : undefined;
      let c: string | null = null;
      if (locked && !locked.destroying) c = locked.lemma[locked.progress] ?? null;
      else {
        const urgent = e.words.filter((w) => !w.destroying).sort((a, b) => b.y - a.y)[0];
        c = urgent ? urgent.lemma[0]! : null;
      }
      setNextChar((prev) => (prev === c ? prev : c));
    }, 80);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const correct = e.charsTyped - e.errors;
      const wpm = e.activeMs >= 4000 ? Math.round((correct / 5 / (e.activeMs / 60000)) * 10) / 10 : null;
      setLive((prev) => (prev.wpm === wpm && prev.score === e.score && prev.streak === e.streak ? prev : { wpm, score: e.score, streak: e.streak }));
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  const percent = hud.total > 0 ? (hud.destroyed / hud.total) * 100 : 0;
  const mult = comboMultiplier(live.streak);
  return (
    <div className="typing-game" data-no-word style={{ userSelect: "none" }}>
      <div className="typing-game-bar">
        <span>Words · Level {String(screen.level).padStart(2, "0")}</span>
        <span className="muted small" title="Meteors arrive at this typing speed: your estimated speed × the speed setting, eased after lost levels. Change the multiplier in Settings.">Pace ≈ {Math.round(screen.plan.speed.effectiveWpm)} WPM{screen.plan.speed.pressure < 1 ? ` (eased ${Math.round((1 - screen.plan.speed.pressure) * 100)}%)` : ""}</span>
        <span className="muted small typing-live" title="Your actual speed on this level so far: correct letters / 5 per minute of play. Updates all the time.">Speed: {live.wpm === null ? "—" : Math.round(live.wpm)} WPM</span>
        <span className="muted small typing-live" title="Game score: 10 per letter of a destroyed word, times the combo. It does not affect your speed, accuracy or word statistics.">Score {live.score}</span>
        {mult > 1 && <span className="typing-combo" title="Words in a row without a wrong key: 3 → ×1.1, 5 → ×1.2, 10 → ×1.5. A wrong key resets it.">Combo ×{mult} · {live.streak}</span>}
        <span className="actions">
          <button className="btn" onClick={togglePause} title="F2">{paused ? "Resume" : "Pause"} (F2)</button>
          <button className="btn" onClick={abort}>Exit</button>
        </span>
      </div>
      <div className="typing-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Meteors destroyed">
        <div className="typing-progress-fill" style={{ width: `${percent}%` }} />
        <span className="typing-progress-label">{hud.destroyed} / {hud.total} destroyed ({percent.toFixed(1)}%)</span>
      </div>
      <div className="typing-stage">
        <canvas ref={canvasRef} className="typing-canvas" aria-label="Words typing game" />
        {paused && <div className="typing-paused" role="status">Paused — press Resume, F2 or Esc to continue.</div>}
        {layoutNotice && <Toast text={LAYOUT_HINT} />}
      </div>
      <p className="muted small">Type the first letter of a word to lock it, then type the rest. A wrong key only shakes the word — just type the right letter. F3 shows the translation of the word you are typing.</p>
      <TypingKeyboard next={paused ? null : nextChar} />
    </div>
  );
}

/* ---------------- Result ---------------- */

const STAT_TIPS = {
  score: "Points for this session. They grow with correct characters, speed and accuracy (squared), a small level bonus, and +100 for finishing the level.\nОчки за сессию: зависят от верных символов, скорости, точности и уровня; +100 за пройденный уровень.",
  bestScore: "Your highest score so far in this mode.\nЛучший результат в этом режиме.",
  wpm: "Words per minute: correct characters ÷ 5, per minute of active time. One \"word\" is 5 characters, so long and short words count fairly.\nСлов в минуту: верные символы ÷ 5 за минуту активной игры.",
  bestWpm: "Your highest WPM so far in this mode.\nЛучшая скорость (WPM).",
  cpm: "Characters per minute: correct characters typed per minute of active time (WPM × 5).\nСимволов в минуту: верные символы за минуту активной игры (WPM × 5).",
  accuracy: "Share of keystrokes that were correct: (keystrokes − errors) ÷ keystrokes.\nДоля верных нажатий клавиш.",
  errors: "Wrong keys pressed. In Words each one shakes the word; it does not delete your progress.\nКоличество неверных нажатий.",
  shown: "Meteors that appeared on screen during the session.\nСколько метеоритов появилось.",
  destroyed: "Meteors you destroyed by typing their word.\nСколько метеоритов уничтожено.",
  time: "Active play time, without pauses.\nАктивное время игры, без пауз.",
};

/** words that went wrong while reading, offered for My Vocabulary (one click each) */
function TroubleWords({ words }: { words: string[] }) {
  const [state, setState] = useState<Record<string, "adding" | "added" | "failed">>({});
  const add = (w: string) => {
    setState((s) => ({ ...s, [w]: "adding" }));
    api.addVocabulary(w).then(() => setState((s) => ({ ...s, [w]: "added" }))).catch(() => setState((s) => ({ ...s, [w]: "failed" })));
  };
  return (
    <div data-testid="typing-trouble">
      <p className="small">Words that gave you trouble — save them to My Vocabulary to meet them again:</p>
      <div className="typing-trouble">
        {words.map((w) => (
          <button key={w} className="btn" disabled={state[w] === "adding" || state[w] === "added"} onClick={() => add(w)} title="Add to My Vocabulary">
            {w} {state[w] === "added" ? "✓" : state[w] === "failed" ? "— retry" : "+"}
          </button>
        ))}
      </div>
    </div>
  );
}

function WordsResult({ result, struggled, bonus, onContinue, onDone }: { result: TypingResult; struggled?: string[]; bonus?: { points: number } | undefined; onContinue: () => void; onDone: () => void }) {
  const m = result.metrics;
  const stats: Array<{ label: string; value: string; tip: string }> = [
    { label: "Score", value: String(m.score), tip: STAT_TIPS.score },
    { label: "Best score", value: result.best.score === null ? "—" : String(result.best.score), tip: STAT_TIPS.bestScore },
    { label: "WPM", value: String(Math.round(m.wpm)), tip: STAT_TIPS.wpm },
    { label: "Best WPM", value: result.best.wpm === null ? "—" : String(Math.round(result.best.wpm)), tip: STAT_TIPS.bestWpm },
    { label: "CPM", value: String(Math.round(m.cpm)), tip: STAT_TIPS.cpm },
    { label: "Accuracy", value: m.accuracy === null ? "—" : `${Math.round(m.accuracy)}%`, tip: STAT_TIPS.accuracy },
    { label: "Errors", value: String(m.errors), tip: STAT_TIPS.errors },
    ...(result.wordsShown !== undefined ? [{ label: "Words shown", value: String(result.wordsShown), tip: STAT_TIPS.shown }] : []),
    ...(result.wordsDestroyed !== undefined ? [{ label: "Destroyed", value: String(result.wordsDestroyed), tip: STAT_TIPS.destroyed }] : []),
    { label: "Time", value: fmtDuration(m.activeMs), tip: STAT_TIPS.time },
  ];
  const columns = Math.ceil(stats.length / 2); // exactly two rows
  const bookFinished = result.mode === "books" && result.book?.finished === true;
  return (
    <div className="card typing-result">
      <h3>{result.mode === "words" ? "Words" : "Books"} — {result.status === "completed" ? "Complete" : result.status === "failed" ? "Failed" : "Interrupted"}</h3>
      {result.mode === "words" && <p className="muted small">Level {String(result.level).padStart(2, "0")}</p>}
      {result.book && <p className="muted small">{result.book.title} · {result.book.chapter ?? "—"} · {result.book.percentRead}% read</p>}
      <div className="stat-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {stats.map((st) => <Stat key={st.label} label={st.label} value={st.value} tip={st.tip} />)}
      </div>
      {result.comparison && <p className={`small typing-compare ${result.comparison.faster ? "faster" : "slower"}`}>{result.comparison.percent}% {result.comparison.faster ? "faster" : "slower"} than last time</p>}
      {result.wordErrorBands && (
        <p className="small" data-testid="typing-error-bands">
          Words by mistakes: <span className="typing-compare faster">{result.wordErrorBands.clean} clean</span> · {result.wordErrorBands.one} with 1 error · <span className={result.wordErrorBands.many > 0 ? "typing-compare slower" : undefined}>{result.wordErrorBands.many} with 2+ errors</span>
        </p>
      )}
      <p className="small">Skill: <strong>{result.skill}</strong> · {result.xpAwarded} XP{bonus ? ` · memory check +${bonus.points} points` : ""}</p>
      {result.words && result.words.length > 0 && (
        <details>
          <summary>Words in this session ({result.words.length})</summary>
          <ul className="typing-word-list">
            {result.words.map((w) => (
              <li key={`${w.order}-${w.planIndex}`}>
                <strong>{w.lemma}</strong>
                {w.translationRu && <span className="muted"> — {firstTranslation(w.translationRu)}</span>}
                <span className="muted small"> · {w.source === "vocabulary" ? "My Vocabulary" : "General"}{w.unverified ? " (unverified)" : ""}{w.partOfSpeech ? ` · ${w.partOfSpeech}` : ""}{w.destroyed ? "" : " · not destroyed"}{w.errors ? ` · ${w.errors} ${w.errors === 1 ? "error" : "errors"}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {struggled && struggled.length > 0 && <TroubleWords words={struggled} />}
      <div className="actions">
        {!bookFinished && <button className="btn btn-primary" onClick={onContinue} data-testid="typing-continue" autoFocus>{result.mode === "words" ? (result.status === "completed" ? `Continue to level ${String(result.level + 1).padStart(2, "0")}` : `Try level ${String(result.level).padStart(2, "0")} again`) : "Continue reading"}</button>}
        <button className="btn" onClick={onDone} data-testid="typing-done">Back to Typing</button>
      </div>
    </div>
  );
}

function Stat({ label, value, tip }: { label: string; value: string; tip: string }) {
  return <div className="stat typing-stat" tabIndex={0} role="group" aria-label={`${label}: ${value}. ${tip.replace(/\n/g, " ")}`} data-tip={tip}><span className="stat-num">{value}</span><span className="stat-label">{label}</span></div>;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
