import { useTypingActivity } from "../typingActivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { DictationResult, DictationState, TypingRecallWord, TypingBookStartResponse, TypingDrillsStartResponse, TypingKeysResult, TypingKeysStartResponse, TypingKeyToken, TypingOverview, TypingResult, TypingWordsStartResponse } from "../api";
import { TypingKeyboard } from "../components/TypingKeyboard";
import { WordsTargetImage } from "../components/WordsTargetImage";
import { checkDailyGoal, DailyGoalCheck } from "../components/DailyGoalNotice";
import { Chart } from "../components/Chart";
import type { BookSpeedSample } from "../game/bookSpeedSamples";
import { WordsScene } from "../game/scene";
import { firstTranslation } from "../format";
import { playPracticeSound } from "../practiceSounds";
import { HOTKEYS, useEnterContinue } from "../components/hotkeys";
import { BooksGame } from "./TypingBooks";
import { DictationGame, DictationResultView } from "./TypingDictation";
import { TypingRecall } from "./TypingRecall";
import { DrillsGame } from "./TypingDrills";
import { KeysGame, KeysResultView, readShowStats, saveShowStats, type KeysReport, type KeyPresses } from "./TypingKeys";
import { LAYOUT_HINT, Toast, useToast } from "./typingShared";
import { comboMultiplier, createWordsEngine, exportKeyStats, revealTranslation, type WordsEngineState, type WordsEvent } from "../game/wordsEngine";
import { wordAccuracy } from "../typingWordAccuracy";
import type { VtOverview, VtSessionState } from "@english-lab/contracts";
import { VocabScreening, VocabTypingCard } from "./TypingVocabulary";
import { VocabLearning } from "./TypingVocabLearning";

type Screen = { kind: "overview" } | { kind: "words"; sessionId: string; level: number; plan: TypingWordsStartResponse; paused: boolean } | { kind: "drills"; plan: TypingDrillsStartResponse } | { kind: "keys"; plan: TypingKeysStartResponse } | { kind: "keysResult"; result: TypingKeysResult; tokens: TypingKeyToken[]; presses: KeyPresses } | { kind: "books"; sessionId: string; data: TypingBookStartResponse; paused: boolean } | { kind: "result"; result: TypingResult; struggled?: string[]; bonus?: { points: number }; bookSamples?: BookSpeedSample[] } | { kind: "recall"; result: TypingResult; struggled?: string[]; words: TypingRecallWord[] } | { kind: "dictation"; state: DictationState } | { kind: "dictationResult"; result: DictationResult } | { kind: "vocab"; stage: "screening" | "learning"; sessionId: string; tabId: string; state: VtSessionState };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const fallMs = (len: number, msPerChar: number) => Math.round(clamp(3 * len * msPerChar + 2500, 5000, 22000));
/** a new meteor arrives after the time to type the previous word plus 60% (reading and aiming) and 0.6 s */
const spawnGapMs = (len: number, msPerChar: number) => Math.round(1.6 * len * msPerChar + 600);

export function Typing({ onNavigate, dailyStart, onDailyDone }: { onNavigate?: (page: "analytics") => void; dailyStart?: "words" | "books" | "dictation" | "vocabTyping"; onDailyDone?: () => void }) {
  const [overview, setOverview] = useState<TypingOverview | null>(null);
  const [vocab, setVocab] = useState<VtOverview | null>(null);
  const [vocabError, setVocabError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "overview" });
  const [error, setError] = useState<string | null>(null);
  // Key Builder: the report after each lesson can be switched off; the last one stays available
  const [showKeysStats, setShowKeysStats] = useState(readShowStats);
  const showKeysStatsRef = useRef(showKeysStats);
  const [lastKeysReport, setLastKeysReport] = useState<KeysReport | null>(null);
  const changeShowKeysStats = useCallback((on: boolean) => { showKeysStatsRef.current = on; saveShowStats(on); setShowKeysStats(on); }, []);

  const load = useCallback(() => {
    api.fetchTypingOverview().then(setOverview).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api.fetchVocabTypingOverview().then((v) => { setVocab(v); setVocabError(null); }).catch((e) => setVocabError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  const [dictNote, setDictNote] = useState<string | null>(null);
  const [dailyDictation, setDailyDictation] = useState<"preparing" | "error" | "done">(dailyStart === "dictation" ? "preparing" : "done");
  const dailyDictationBusy = useRef(false);
  const dailyDictationCancelled = useRef(false);
  const dailyDictationToken = useRef(0);
  useEffect(() => { dailyDictationCancelled.current = false; return () => { dailyDictationCancelled.current = true; dailyDictationToken.current++; }; }, []);
  // while dictation tracks are being made (a lesson or prepared ones) the card follows the progress
  const generating = overview?.dictation.lesson?.status === "generating" || (overview?.dictation.pool.generating ?? 0) > 0;
  useEffect(() => {
    if (!generating || screen.kind !== "overview") return;
    const id = window.setInterval(load, 2500);
    return () => window.clearInterval(id);
  }, [generating, screen.kind, load]);

  const dailyStarted = useRef(false);
  useEffect(() => {
    if (dailyStart !== "books" || !overview || dailyStarted.current) return;
    dailyStarted.current = true;
    if (overview.books.available && !overview.books.finished) void startBook(setScreen, setError);
  }, [dailyStart, overview, load]);

  // Daily Practice: Learning when something is waiting for it (a check is due or a word is being learned), else Screening
  useEffect(() => {
    if (dailyStart !== "vocabTyping" || !overview || !vocab || dailyStarted.current) return;
    dailyStarted.current = true;
    void startVocab(vocab.learning.playable > 0 || vocab.learning.dueNow > 0 ? "learning" : "screening", setScreen, setVocabError);
  }, [dailyStart, overview, vocab]);

  // A requested dictation may need to be created or finish generating before it can start.
  useEffect(() => {
    if (dailyDictation !== "preparing" || !overview || screen.kind !== "overview" || dailyDictationBusy.current) return;
    const d = overview.dictation;
    if (d.lesson?.status === "generating") return;
    if (d.lesson?.status === "failed" || (!d.lesson && !d.available)) {
      setDictNote(dictationNote(d));
      setDailyDictation("error");
      return;
    }
    dailyDictationBusy.current = true;
    const token = dailyDictationToken.current;
    const current = () => !dailyDictationCancelled.current && dailyDictationToken.current === token;
    const start = async () => {
      try {
        if (!d.lesson) {
          await api.createDictationLesson();
          const fresh = await api.fetchTypingOverview();
          if (current()) setOverview(fresh);
        } else {
          const state = await api.startDictationLesson(d.lesson.id);
          if (current()) { setDailyDictation("done"); setScreen({ kind: "dictation", state }); }
        }
      } catch (e) {
        if (current()) { setDictNote(e instanceof Error ? e.message : String(e)); setDailyDictation("error"); }
      } finally { dailyDictationBusy.current = false; if (!dailyDictationCancelled.current && dailyDictationToken.current !== token) load(); }
    };
    void start();
  }, [dailyStart, dailyDictation, overview, screen.kind, load]);

  const beginDictation = async (currentOverview = overview) => {
    const token = ++dailyDictationToken.current;
    dailyDictationCancelled.current = false;
    setDictNote(null);
    try {
      if (currentOverview?.dictation.lesson?.status === "failed") {
        await api.retryDictationLesson(currentOverview.dictation.lesson.id);
        const fresh = await api.fetchTypingOverview();
        if (dailyDictationCancelled.current || dailyDictationToken.current !== token) return;
        setOverview(fresh);
      }
      if (!dailyDictationCancelled.current && dailyDictationToken.current === token) setDailyDictation("preparing");
    } catch (e) {
      if (!dailyDictationCancelled.current && dailyDictationToken.current === token) { setDictNote(e instanceof Error ? e.message : String(e)); setDailyDictation("error"); }
    }
  };

  if (error && screen.kind === "overview") return <p role="alert">{error}</p>;
  if (!overview) return <p className="muted">Loading typing practice…</p>;

  if (dailyDictation !== "done" && screen.kind === "overview") {
    const lesson = overview.dictation.lesson;
    const retry = async () => {
      try { const fresh = await api.fetchTypingOverview(); setOverview(fresh); await beginDictation(fresh); }
      catch (e) { setDictNote(e instanceof Error ? e.message : String(e)); }
    };
    return <section className="card" aria-label="Preparing Audio Dictation">
      <h2><i className="pi pi-volume-up" aria-hidden="true" /> Audio Dictation</h2>
      {dailyDictation === "preparing" ? <p role="status">{lesson?.status === "generating" ? `Preparing the lesson: ${lesson.ready} / ${lesson.total} ready…` : "Opening your lesson…"}</p> : <><p className="notice notice-warning" role="alert">{dictNote ?? "Could not prepare the lesson."}</p><button className="btn btn-primary" onClick={() => void retry()}>Retry</button></>}
      <button className="btn" onClick={() => { dailyDictationCancelled.current = true; dailyDictationToken.current++; setDailyDictation("done"); }}>Back to Typing</button>
    </section>;
  }

  if (screen.kind === "dictation") return <section className="typing-page" aria-label="Audio Dictation"><DictationGame state={screen.state} onResult={(result) => setScreen({ kind: "dictationResult", result })} onExit={() => { load(); setScreen({ kind: "overview" }); }} /></section>;
  if (screen.kind === "dictationResult") {
    const toOverview = () => { load(); setScreen({ kind: "overview" }); };
    return <DictationResultView result={screen.result} onDailyDone={onDailyDone} onDone={toOverview} onNext={() => {
      dailyDictationCancelled.current = false;
      dailyDictationToken.current++;
      setDictNote(null);
      setError(null);
      setOverview(null);
      setDailyDictation("preparing");
      setScreen({ kind: "overview" });
      load();
    }} />;
  }

  if (screen.kind === "recall") {
    return <section className="typing-page" aria-label="Memory check"><TypingRecall sessionId={screen.result.sessionId} words={screen.words} onDone={(bonus) => setScreen({ kind: "result", result: screen.result, ...(screen.struggled ? { struggled: screen.struggled } : {}), ...(bonus ? { bonus } : {}) })} /></section>;
  }

  if (screen.kind === "keysResult") {
    const toOverview = () => { load(); setScreen({ kind: "overview" }); };
    return <><DailyGoalCheck mode="words" /><KeysResultView result={screen.result} tokens={screen.tokens} presses={screen.presses} onNext={() => void startKeys(setScreen, setError).then((ok) => { if (!ok) toOverview(); })} onDone={toOverview} showStats={showKeysStats} onShowStats={changeShowKeysStats} /></>;
  }

  if (screen.kind === "result") {
    const mode = screen.result.mode;
    const toOverview = () => { load(); setScreen({ kind: "overview" }); };
    // Continue goes straight into the next level / next book passage; if that cannot start, fall back to the overview
    const next = async () => {
      const started = mode === "words" ? await (screen.result.variant === "drills" ? startDrills(setScreen, setError) : startWords(setScreen, setError)) : await startBook(setScreen, setError);
      if (!started) toOverview();
    };
    return <><DailyGoalCheck mode={mode === "words" ? "words" : "books"} /><WordsResult onDailyDone={onDailyDone} result={screen.result} struggled={screen.struggled} bonus={screen.bonus} bookSamples={screen.bookSamples} onContinue={() => void next()} onDone={toOverview} /></>;
  }

  return (
    <section className="typing-page" aria-label="Typing practice">
      {screen.kind === "overview" && (
        <>
          <h2 id="typing-h"><i className="pi pi-bullseye" aria-hidden="true" /> {dailyStart === "words" ? "Choose your Words practice" : "Typing practice"}</h2>
          <div className={`typing-cards${dailyStart === "words" ? " typing-cards-single" : ""}`}>
            <ModeCard
              image="/typing/words.jpg"
              icon="pi-bolt"
              title="Words"
              desc="Meteor Rain: type words to destroy falling meteors. Finger Drills: a few comfortable words many times, so your fingers learn them. Key Builder: letters open one by one as you reach the target speed."
              action="Meteor Rain"
              level={overview.words.nextLevel}
              disabled={overview.words.bankWords === 0}
              disabledNote={overview.words.bankWords === 0 ? "The word bank is empty. Run the typing seed first." : null}
              onStart={() => void startWords(setScreen, setError)}
              second={{ action: "Finger Drills", level: overview.words.drills.nextLevel, note: `Stage ${overview.words.drills.stage} · ${overview.words.drills.learned} learned`, onStart: () => void startDrills(setScreen, setError) }}
              third={overview.words.keys ? { action: "Key Builder", level: overview.words.keys.nextLesson, note: `${overview.words.keys.openKeys} keys${overview.words.keys.focused ? ` · focus ${overview.words.keys.focused.toUpperCase()}` : ""}`, onStart: () => void startKeys(setScreen, setError) } : undefined}
            />
            {dailyStart !== "words" && <><ModeCard
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
              disabled={!overview.dictation.available && !overview.dictation.lesson}
              disabledNote={dictNote ?? dictationNote(overview.dictation)}
              onStart={() => void beginDictation()}
            />
            <VocabTypingCard overview={vocab} error={vocabError} onScreening={() => void startVocab("screening", setScreen, setVocabError)} onLearning={() => void startVocab("learning", setScreen, setVocabError)} /></>}
          </div>
          {/* {onNavigate && (
            <p className="actions page-actions">
              <button className="btn" onClick={() => onNavigate("analytics")}><i className="pi pi-chart-line" aria-hidden="true" /> Typing analytics</button>
            </p>
          )} */}
        </>
      )}
      {screen.kind === "vocab" && screen.stage === "screening" && <VocabScreening key={screen.sessionId} sessionId={screen.sessionId} tabId={screen.tabId} initial={screen.state} onNext={() => void startVocab("screening", setScreen, setVocabError)} onDone={() => { load(); setScreen({ kind: "overview" }); }} {...(onDailyDone ? { onDailyDone } : {})} />}
      {screen.kind === "vocab" && screen.stage === "learning" && <VocabLearning key={screen.sessionId || "empty"} sessionId={screen.sessionId} tabId={screen.tabId} initial={screen.state} onNext={() => void startVocab("learning", setScreen, setVocabError).then((ok) => { if (!ok) { load(); setScreen({ kind: "overview" }); } })} onDone={() => { load(); setScreen({ kind: "overview" }); }} {...(onDailyDone ? { onDailyDone } : {})} />}
      {screen.kind === "keys" && <KeysGame key={screen.plan.lessonId} plan={screen.plan} showStats={showKeysStats} onShowStats={changeShowKeysStats} lastReport={lastKeysReport} onExit={() => { load(); setScreen({ kind: "overview" }); }} onResult={(result, tokens, presses) => {
        setLastKeysReport({ result, tokens, presses });
        if (showKeysStatsRef.current) { setScreen({ kind: "keysResult", result, tokens, presses }); return; }
        void startKeys(setScreen, setError).then((ok) => { if (!ok) { load(); setScreen({ kind: "overview" }); } });
      }} />}
      {screen.kind === "drills" && <DrillsGame plan={screen.plan} onResult={(result) => setScreen({ kind: "result", result })} onExit={() => { load(); setScreen({ kind: "overview" }); }} />}
      {screen.kind === "words" && <WordsGame screen={screen} setScreen={setScreen} onExit={() => setScreen({ kind: "overview" })} />}
      {screen.kind === "books" && <BooksGame sessionId={screen.sessionId} data={screen.data} onResult={(result, struggled, bookSamples) => setScreen({ kind: "result", result, struggled, bookSamples })} onExit={() => setScreen({ kind: "overview" })} />}
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
  if (d.reason === "real_speech_unavailable") return "No checked real-voice recordings are available yet. Switch to Piper in Settings or prepare more real recordings.";
  if (d.reason === "asr_unavailable") return "No speech check is available: set a Groq key in .env or install the local Whisper large-v3 model.";
  return "Piper is not installed. Run `npm run dictation:setup`.";
}

function bookReason(reason: string | null): string {
  if (reason === "file_missing" || reason === "file_changed") return "The book file is missing or changed. Run `npm run typing:prepare-book`.";
  if (reason === "no_book") return "No book is prepared yet. Run `npm run typing:prepare-book`.";
  return "The book is not available.";
}

function ModeCard({ image, icon, title, desc, action, level, subtitle, disabled, disabledNote, onStart, second, third, children }: { image: string; icon: string; title: string; desc: string; action: string; level: number; subtitle?: string; disabled: boolean; disabledNote: string | null; onStart: () => void; second?: { action: string; level: number; note: string; onStart: () => void }; third?: { action: string; level: number; note: string; onStart: () => void }; children?: React.ReactNode }) {
  return (
    <div className={`card typing-mode-card${disabled ? " disabled" : ""}`}>
      <img className="typing-card-image" src={image} alt="" loading="lazy" />
      <h3><i className={`pi ${icon}`} aria-hidden="true" /> {title}</h3>
      <p className="muted small">{desc}</p>
      {subtitle && <p className="muted small">Book: {subtitle}</p>}
      <p className="typing-level">{action} <span className="muted">(Level {String(level).padStart(2, "0")})</span></p>
      {second && <p className="typing-level">{second.action} <span className="muted">(Level {String(second.level).padStart(2, "0")} · {second.note})</span></p>}
      {third && <p className="typing-level">{third.action} <span className="muted">(Lesson {String(third.level).padStart(2, "0")} · {third.note})</span></p>}
      {disabledNote && <p className="notice notice-warning small" role="status">{disabledNote}</p>}
      {children}
      {second ? (
        <div className="typing-card-actions">
          <button className="btn btn-primary" disabled={disabled} onClick={onStart} data-testid={`typing-${title.toLowerCase()}-start`}>{action}</button>
          <button className="btn btn-primary" disabled={disabled} onClick={second.onStart} data-testid="typing-drills-start">{second.action}</button>
          {third && <button className="btn btn-primary" onClick={third.onStart} data-testid="typing-keys-start">{third.action}</button>}
        </div>
      ) : (
        <button className="btn btn-primary typing-card-action" disabled={disabled} onClick={onStart} data-testid={`typing-${title.toLowerCase()}-start`}>{action}</button>
      )}
    </div>
  );
}

async function startVocab(stage: "screening" | "learning", setScreen: (s: Screen) => void, setError: (e: string | null) => void): Promise<boolean> {
  const tabId = crypto.randomUUID();
  try {
    const r = await (stage === "screening" ? api.startVocabScreening(tabId) : api.startVocabLearning(tabId));
    setScreen({ kind: "vocab", stage, sessionId: r.sessionId, tabId, state: r.state });
    setError(null);
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
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

async function startDrills(setScreen: (s: Screen) => void, setError: (e: string | null) => void): Promise<boolean> {
  try {
    const plan = await api.startTypingDrills();
    setScreen({ kind: "drills", plan });
    return true;
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** a start already on its way: Enter pressed again meanwhile joins it instead of starting (and interrupting) another lesson */
let keysStarting: Promise<boolean> | null = null;
function startKeys(setScreen: (s: Screen) => void, setError: (e: string | null) => void): Promise<boolean> {
  keysStarting ??= (async () => {
    try {
      const plan = await api.startTypingKeys();
      setScreen({ kind: "keys", plan });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      keysStarting = null;
    }
  })();
  return keysStarting;
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
  const flushActivity = useTypingActivity(screen.sessionId, "words", () => engineRef.current?.activeMs ?? 0);
  const [paused, setPaused] = useState(screen.paused);
  const [imageWord, setImageWord] = useState<string | null>(null);
  const [imageTranslation, setImageTranslation] = useState<string | null>(null);
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
    flushActivity();
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
      bestCharStreak: engine.bestCharStreak,
    }).then(async (result) => {
      checkDailyGoal("words");
      api.announceXp();
      // a won level may be followed by the optional memory check of up to three saved words
      if (status === "completed") {
        const recall = await api.fetchTypingRecall(result.sessionId).catch(() => null);
        if (recall && !recall.done && recall.words.length > 0) { setScreen({ kind: "recall", result, words: recall.words }); return; }
      }
      setScreen({ kind: "result", result });
    }).catch(() => setScreen({ kind: "overview" }));
  }, [screen.sessionId, setScreen, flushActivity]);

  const onEvents = useCallback((events: WordsEvent[]) => {
    const engine = engineRef.current!;
    const sound = (kind: Parameters<typeof playPracticeSound>[0]) => playPracticeSound(kind, soundsRef.current);
    for (const e of events) {
      if (e.type === "hit") {
        sound("shoot");
        if (e.word.progress === 1) {
          setImageWord(e.word.lemma);
          const planWord = engine.plan[e.word.planIndex];
          setImageTranslation(planWord?.source === "general" ? firstTranslation(planWord.translationRu) || null : null);
        }
        if (e.word.progress === 1 && e.word.source === "vocabulary") pronunciation.speak(e.word.planIndex);
      } else if (e.type === "miss") {
        sound("incorrect");
      } else if (e.type === "appeared") {
        void api.typingWordAppearances(screen.sessionId, [{ planIndex: e.word.planIndex, order: engine.appearances.find((a) => a.planIndex === e.word.planIndex)?.order ?? engine.appearances.length }]);
      } else if (e.type === "destroyed") {
        setImageWord(null);
        window.setTimeout(() => sound("explode"), 150); // lands with the last bolt
        setHud({ destroyed: engine.destroyedCount, total: engine.plan.length });
      } else if (e.type === "won") {
        // let the last explosion play out before the result replaces the scene
        window.setTimeout(() => sound("complete"), 450);
        window.setTimeout(() => void finish("completed"), 1100);
      } else if (e.type === "failed") {
        setImageWord(null);
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
      if (e.key === "Escape" || e.key === HOTKEYS.pause) { e.preventDefault(); if (!e.repeat) togglePause(); return; }
      // F3: the Russian translation of the word being typed (or the most urgent one), also for general words
      if (e.key === HOTKEYS.translate) { e.preventDefault(); if (!e.repeat && !pausedRef.current) { const eng = engineRef.current; if (eng) revealTranslation(eng); } return; }
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
        <WordsTargetImage word={imageWord} translation={imageTranslation} />
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

function WordsResult({ result, struggled, bonus, bookSamples, onContinue, onDone, onDailyDone }: { result: TypingResult; struggled?: string[]; bonus?: { points: number } | undefined; bookSamples?: BookSpeedSample[]; onContinue: () => void; onDone: () => void; onDailyDone?: () => void }) {
  const m = result.metrics;
  const wordStats = wordAccuracy(result);
  const stats: Array<{ label: string; value: string; tip: string }> = [
    { label: "Score", value: String(m.score), tip: STAT_TIPS.score },
    { label: "Best score", value: result.best.score === null ? "—" : String(result.best.score), tip: STAT_TIPS.bestScore },
    { label: "WPM", value: String(Math.round(m.wpm)), tip: STAT_TIPS.wpm },
    { label: "Best WPM", value: result.best.wpm === null ? "—" : String(Math.round(result.best.wpm)), tip: STAT_TIPS.bestWpm },
    { label: "CPM", value: String(Math.round(m.cpm)), tip: STAT_TIPS.cpm },
    ...(wordStats ? [{ label: "Word accuracy", value: wordStats.accuracy === null ? "—" : `${Math.round(wordStats.accuracy)}%`, tip: "Completed words typed without any wrong keys, divided by all completed words. Missing per-word records are not counted as clean.\nДоля завершённых слов без ошибок." }, { label: "Words with errors", value: `${wordStats.withErrors} / ${wordStats.shown - wordStats.unknown}`, tip: "Words with at least one wrong key after selecting the word, out of words with recorded error details. Mistakes before selecting a word are separate.\nСлова хотя бы с одной ошибкой после выбора слова." }, { label: "Not completed", value: `${wordStats.unfinished} / ${wordStats.shown}`, tip: "Words shown but not destroyed before the session ended.\nПоказанные, но не завершённые слова." }] : []),
    ...(result.mode === "books" && result.bookWords ? [{label:"Word accuracy",value:result.bookWords.completed ? `${Math.round((result.bookWords.completed-result.bookWords.withErrors)/result.bookWords.completed*100)}%` : "—",tip:"Completed words without a wrong key, among the words covered by tracking. Punctuation and spaces are not words."},{label:"Words with errors",value:`${result.bookWords.withErrors} / ${result.bookWords.completed}`,tip:"Completed word occurrences with at least one wrong key. Repeated occurrences count separately."}] : []),
    { label: result.mode === "words" ? "Key accuracy" : "Accuracy", value: m.accuracy === null ? "—" : `${Math.round(m.accuracy)}%`, tip: STAT_TIPS.accuracy },
    { label: result.mode === "words" ? "Wrong keys" : "Errors", value: String(m.errors), tip: STAT_TIPS.errors },
    ...(result.wordsShown !== undefined ? [{ label: "Words shown", value: String(result.wordsShown), tip: STAT_TIPS.shown }] : []),
    ...(result.wordsDestroyed !== undefined ? [{ label: "Destroyed", value: String(result.wordsDestroyed), tip: STAT_TIPS.destroyed }] : []),
    { label: "Time", value: fmtDuration(m.activeMs), tip: STAT_TIPS.time },
  ];
  const columns = Math.ceil(stats.length / 2); // exactly two rows
  const bookFinished = result.mode === "books" && result.book?.finished === true;
  // Enter continues THIS training (next level / reading on); a finished book has nothing to continue
  useEnterContinue(bookFinished ? null : onContinue);
  const drills = result.variant === "drills";
  // Drills repeat a few words many times: the list groups the showings of each word
  const drillWords = drills && result.words ? [...result.words.reduce((m, w) => {
    const cur = m.get(w.lemma) ?? { lemma: w.lemma, translationRu: w.translationRu, typed: 0, withErrors: 0 };
    if (w.destroyed) cur.typed++;
    if (w.errors) cur.withErrors++;
    return m.set(w.lemma, cur);
  }, new Map<string, { lemma: string; translationRu: string | null; typed: number; withErrors: number }>()).values()] : null;
  return (
    <div className="card typing-result">
      <h3>{result.mode === "words" ? (drills ? "Finger Drills" : "Meteor Rain") : "Books"} — {result.status === "completed" ? "Complete" : result.status === "failed" ? "Failed" : "Interrupted"}</h3>
      {result.mode === "words" && <p className="muted small">Level {String(result.level).padStart(2, "0")}{result.drills ? ` · Stage ${result.drills.stage} · ${result.drills.learned} words learned` : ""}</p>}
      {result.drills && result.drills.newlyLearned.length > 0 && <p className="small typing-compare faster" data-testid="drills-newly-learned">Learned on this level: {result.drills.newlyLearned.join(", ")}</p>}
      {result.book && <p className="muted small">{result.book.title} · {result.book.chapter ?? "—"} · {result.book.percentRead}% read</p>}
      <div className="stat-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {stats.map((st) => <Stat key={st.label} label={st.label} value={st.value} tip={st.tip} />)}
      </div>
      {result.comparison && <p className={`small typing-compare ${result.comparison.faster ? "faster" : "slower"}`}>{result.comparison.percent}% {result.comparison.faster ? "faster" : "slower"} than last time</p>}
      {wordStats && <p className="muted small">{wordStats.unknown > 0 ? "At least " : ""}{wordStats.clean} of {wordStats.completed} completed words were typed without errors.{wordStats.unknown > 0 && ` Error details are unavailable for ${wordStats.unknown} shown ${wordStats.unknown === 1 ? "word" : "words"}.`}{wordStats.unassigned !== null && wordStats.unassigned > 0 && ` ${wordStats.unassigned} wrong ${wordStats.unassigned === 1 ? "key was" : "keys were"} pressed without a selected word.`}</p>}
      {result.mode === "books" && (result.bookWords ? <p className="muted small">{result.bookWords.partial ? "Partial word tracking: earlier typing was not recorded. " : ""}Words are counted by occurrence; mistakes on spaces are counted only as wrong keys.</p> : <p className="muted small">Word-level error tracking was not available for this session.</p>)}
      {result.wordErrorBands && (
        <p className="small" data-testid="typing-error-bands">
          Words by mistakes: <span className="typing-compare faster">{result.wordErrorBands.clean} clean</span> · {result.wordErrorBands.one} with 1 error · <span className={result.wordErrorBands.many > 0 ? "typing-compare slower" : undefined}>{result.wordErrorBands.many} with 2+ errors</span>
        </p>
      )}
      <p className="small">Skill: <strong>{result.skill}</strong> · {result.xpAwarded} XP{bonus ? ` · memory check +${bonus.points} points` : ""}</p>
      {drillWords && drillWords.length > 0 && (
        <details>
          <summary>Words in this level ({drillWords.length})</summary>
          <ul className="typing-word-list">
            {drillWords.map((w) => (
              <li key={w.lemma}>
                <strong>{w.lemma}</strong>
                {w.translationRu && <span className="muted"> — {firstTranslation(w.translationRu)}</span>}
                <span className="muted small"> · typed {w.typed}×{w.withErrors ? ` · ${w.withErrors} with errors` : " · all clean"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!drills && result.words && result.words.length > 0 && (
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
      {bookSamples && bookSamples.length > 0 && <div className="books-session-chart" data-testid="books-session-chart">
        <h4 className="chart-title">Typing during this level</h4>
        <Chart ariaLabel="Typing speed and errors during this level" bars={{ color: "#e78e8e", format: (v) => `${Math.round(v)}` }} line={{ color: "#6ab7ff", format: (v) => `${Math.round(v)} WPM` }} legend="Line: typing speed in each 5-second interval (right axis); bars: errors in that interval. Pauses are excluded. Only this uninterrupted visit is shown; this chart is not saved." points={bookSamples.map((sample, i) => ({ key: `${sample.elapsedMs}-${i}`, label: fmtDuration(sample.elapsedMs), bar: sample.errors, line: sample.wpm, tip: [fmtDuration(sample.elapsedMs), `Speed: ${sample.wpm} WPM`, `Errors: ${sample.errors}`, `Interval: ${(sample.intervalMs / 1000).toFixed(1)} s`] }))} />
      </div>}
      {struggled && struggled.length > 0 && <TroubleWords words={struggled} />}
      <div className="actions">
        {!bookFinished && <button className="btn btn-primary" onClick={onContinue} data-testid="typing-continue" autoFocus>{result.mode === "words" ? (result.status === "completed" ? `${drills ? "Next drill: level" : "Continue to level"} ${String(result.level + 1).padStart(2, "0")}` : `Try level ${String(result.level).padStart(2, "0")} again`) : "Continue reading"}</button>}
        {onDailyDone && <button className="btn btn-primary" onClick={onDailyDone}>Continue Daily Practice</button>}
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
