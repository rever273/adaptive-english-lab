import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { TypingBookStartResponse, TypingOverview, TypingResult, TypingWordsStartResponse } from "../api";
import { createBooksEngine, handleBookKey, keysForRange, nextKey, tickBooks, type BooksEngineState } from "../game/booksEngine";
import { WordsScene } from "../game/scene";
import { createWordsEngine, type WordsEngineState, type WordsEvent } from "../game/wordsEngine";

type Screen = { kind: "overview" } | { kind: "words"; sessionId: string; level: number; plan: TypingWordsStartResponse; paused: boolean } | { kind: "books"; sessionId: string; data: TypingBookStartResponse; paused: boolean } | { kind: "result"; result: TypingResult };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const fallMs = (len: number, msPerChar: number) => Math.round(clamp(3 * len * msPerChar + 2500, 5000, 22000));
const spawnGapMs = (len: number, msPerChar: number) => Math.round(len * msPerChar + 350);

export function Typing({ onNavigate }: { onNavigate?: (page: "analytics") => void }) {
  const [overview, setOverview] = useState<TypingOverview | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "overview" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.fetchTypingOverview().then(setOverview).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  if (error && screen.kind === "overview") return <p role="alert">{error}</p>;
  if (!overview) return <p className="muted">Loading typing practice…</p>;

  if (screen.kind === "result") return <WordsResult result={screen.result} onDone={() => { load(); setScreen({ kind: "overview" }); }} />;

  return (
    <section className="typing-page" aria-label="Typing practice">
      {screen.kind === "overview" && (
        <>
          <h2 id="typing-h"><i className="pi pi-bullseye" aria-hidden="true" /> Typing practice</h2>
          <div className="typing-cards">
            <ModeCard
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
          </div>
          {onNavigate && (
            <p className="actions page-actions">
              <button className="btn" onClick={() => onNavigate("analytics")}><i className="pi pi-chart-line" aria-hidden="true" /> Typing analytics</button>
            </p>
          )}
        </>
      )}
      {screen.kind === "words" && <WordsGame screen={screen} setScreen={setScreen} onExit={() => setScreen({ kind: "overview" })} />}
      {screen.kind === "books" && <BooksGame screen={screen} setScreen={setScreen} onExit={() => setScreen({ kind: "overview" })} />}
    </section>
  );
}

function bookReason(reason: string | null): string {
  if (reason === "file_missing" || reason === "file_changed") return "The book file is missing or changed. Run `npm run typing:prepare-book`.";
  if (reason === "no_book") return "No book is prepared yet. Run `npm run typing:prepare-book`.";
  return "The book is not available.";
}

function ModeCard({ icon, title, desc, action, level, subtitle, disabled, disabledNote, onStart }: { icon: string; title: string; desc: string; action: string; level: number; subtitle?: string; disabled: boolean; disabledNote: string | null; onStart: () => void }) {
  return (
    <div className={`card typing-mode-card${disabled ? " disabled" : ""}`}>
      <h3><i className={`pi ${icon}`} aria-hidden="true" /> {title}</h3>
      <p className="muted small">{desc}</p>
      {subtitle && <p className="muted small">Book: {subtitle}</p>}
      <p className="typing-level">{action} <span className="muted">(Level {String(level).padStart(2, "0")})</span></p>
      {disabledNote && <p className="notice notice-warning small" role="status">{disabledNote}</p>}
      <button className="btn btn-primary" disabled={disabled} onClick={onStart} data-testid={`typing-${title.toLowerCase()}-start`}>{action}</button>
    </div>
  );
}

async function startWords(setScreen: (s: Screen) => void, setError: (e: string | null) => void) {
  try {
    const plan = await api.startTypingWords();
    setScreen({ kind: "words", sessionId: plan.sessionId, level: plan.level, plan, paused: false });
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}

async function startBook(setScreen: (s: Screen) => void, setError: (e: string | null) => void) {
  try {
    const data = await api.startTypingBook();
    setScreen({ kind: "books", sessionId: data.sessionId, data, paused: false });
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}

/* ---------------- Words ---------------- */

function WordsGame({ screen, setScreen, onExit }: { screen: Extract<Screen, { kind: "words" }>; setScreen: (s: Screen) => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WordsScene | null>(null);
  const engineRef = useRef<WordsEngineState | null>(null);
  const [paused, setPaused] = useState(screen.paused);
  const pausedRef = useRef(screen.paused);
  const [hud, setHud] = useState<{ destroyed: number; total: number }>({ destroyed: 0, total: screen.plan.targetCount });
  const [finished, setFinished] = useState(false);

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
    const engine = engineRef.current!;
    void api.completeTypingWords(screen.sessionId, {
      status,
      activeMs: Math.round(engine.activeMs),
      charsTyped: engine.charsTyped,
      errors: engine.errors,
      appearances: engine.appearances,
      destroyedPlanIndexes: engine.destroyedPlanIndexes,
    }).then((result) => {
      api.announceXp();
      setScreen({ kind: "result", result });
    }).catch(() => setScreen({ kind: "overview" }));
  }, [screen.sessionId, setScreen]);

  const onEvents = useCallback((events: WordsEvent[]) => {
    const engine = engineRef.current!;
    for (const e of events) {
      if (e.type === "appeared") {
        void api.typingWordAppearances(screen.sessionId, [{ planIndex: e.word.planIndex, order: engine.appearances.find((a) => a.planIndex === e.word.planIndex)?.order ?? engine.appearances.length }]);
      } else if (e.type === "destroyed") {
        setHud({ destroyed: engine.destroyedCount, total: engine.plan.length });
      } else if (e.type === "won") {
        setFinished(true);
        void finish("completed");
      } else if (e.type === "failed") {
        setFinished(true);
        void finish("failed");
      }
    }
  }, [screen.sessionId, finish]);

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
      if (e.key === "Escape") { e.preventDefault(); togglePause(); return; }
      if (e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); sceneRef.current?.key("Backspace"); return; }
      if (e.key.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (/[Ѐ-ӿ]/.test(e.key)) { return; } // Russian layout: not an error
      sceneRef.current?.key(e.key);
    };
    const onBlur = () => { pausedRef.current = true; setPaused(true); };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("blur", onBlur); };
  }, [togglePause]);

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

  return (
    <div className="typing-game" data-no-word style={{ userSelect: "none" }}>
      <div className="typing-game-bar">
        <span>Words · Level {String(screen.level).padStart(2, "0")}</span>
        <span>{hud.destroyed} / {hud.total} destroyed</span>
        <span className="actions">
          <button className="btn" onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>
          <button className="btn" onClick={abort}>Exit</button>
        </span>
      </div>
      {paused && <div className="typing-paused" role="status">Paused — press Resume or Esc to continue.</div>}
      <canvas ref={canvasRef} className="typing-canvas" aria-label="Words typing game" />
      <p className="muted small">Type the first letter of a word to lock it, then type the word. Backspace fixes mistakes.</p>
    </div>
  );
}

/* ---------------- Books ---------------- */

function BooksGame({ screen, setScreen, onExit }: { screen: Extract<Screen, { kind: "books" }>; setScreen: (s: Screen) => void; onExit: () => void }) {
  const engineRef = useRef<BooksEngineState | null>(null);
  const [paused, setPaused] = useState(screen.paused);
  const [version, setVersion] = useState(0);
  const lastCheckpoint = useRef(0);

  if (!engineRef.current) {
    engineRef.current = createBooksEngine({
      text: screen.data.text,
      startOffset: screen.data.startOffset,
      initialOffset: screen.data.currentOffset,
      initialActiveMs: screen.data.activeMs,
      initialCharsTyped: screen.data.charsTyped,
      initialErrors: screen.data.errors,
    });
  }
  const engine = engineRef.current;

  const checkpoint = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastCheckpoint.current < 2000) return;
    lastCheckpoint.current = now;
    void api.checkpointTypingBook(screen.sessionId, { offset: screen.data.startOffset + engine.offset, activeMs: Math.round(engine.activeMs), charsTyped: engine.charsTyped, errors: engine.errorCount });
  }, [screen, engine]);

  const complete = useCallback(() => {
    const eng = engineRef.current!;
    void api.completeTypingBook(screen.sessionId, { offset: screen.data.endOffset, activeMs: Math.round(eng.activeMs), charsTyped: eng.charsTyped, errors: eng.errorCount }).then((result) => {
      api.announceXp();
      setScreen({ kind: "result", result });
    }).catch(() => setScreen({ kind: "overview" }));
  }, [screen, setScreen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.getModifierState("AltGraph") || e.isComposing) return;
      if (e.key === "Escape") { e.preventDefault(); setPaused((p) => !p); return; }
      if (e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); handleBookKey(engine, "Backspace"); setVersion((v) => v + 1); checkpoint(); return; }
      if (e.key.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (/[Ѐ-ӿ]/.test(e.key)) return;
      const r = handleBookKey(engine, e.key);
      setVersion((v) => v + 1);
      if (r.tokenComplete) checkpoint();
      if (r.finished) { void complete(); }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const onHide = () => { if (document.visibilityState === "hidden") { checkpoint(true); void api.sendKeepalive(`/api/v1/typing/books/${encodeURIComponent(screen.sessionId)}/checkpoint`, { offset: screen.data.startOffset + engine.offset, activeMs: Math.round(engine.activeMs), charsTyped: engine.charsTyped, errors: engine.errorCount }); } };
    const onPageHide = () => { void api.sendKeepalive(`/api/v1/typing/books/${encodeURIComponent(screen.sessionId)}/checkpoint`, { offset: screen.data.startOffset + engine.offset, activeMs: Math.round(engine.activeMs), charsTyped: engine.charsTyped, errors: engine.errorCount }); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onPageHide); };
  }, [engine, checkpoint, complete, screen]);

  const abort = () => {
    void api.abortTypingBook(screen.sessionId, { activeMs: Math.round(engine.activeMs), charsTyped: engine.charsTyped, errors: engine.errorCount });
    onExit();
  };

  // tokens for the current sentence window
  const tokens = splitIntoTokens(screen.data.text);
  const cursor = engine.offset;
  const next = nextKey(engine);

  return (
    <div className="typing-game typing-books" data-no-word style={{ userSelect: "none" }}>
      <div className="typing-game-bar">
        <span>{screen.data.title} · Level {screen.data.level}</span>
        <span>{Math.round(screen.data.percentRead)}% read</span>
        <span className="actions">
          <button className="btn" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
          <button className="btn" onClick={abort}>Exit</button>
        </span>
      </div>
      {paused && <div className="typing-paused" role="status">Paused — press Resume or Esc to continue.</div>}
      <div className="books-meteors">
        {tokens.filter((t) => t.endOffset >= cursor - 1 && t.startOffset <= cursor + 40).slice(0, 12).map((t) => (
          <span key={t.startOffset} className={`books-meteor${cursor >= t.endOffset ? " done" : cursor >= t.startOffset ? " active" : ""}`}>{screen.data.text.slice(t.startOffset, t.endOffset)}</span>
        ))}
      </div>
      <div className="books-line">
        <span className="books-done">{renderDone(screen.data.text, cursor, engine)}</span>
        {next !== null && <span className="books-cursor">{screen.data.text[cursor] ?? " "}</span>}
        <span className="books-rest">{screen.data.text.slice(cursor)}</span>
      </div>
      <p className="muted small">Type the text left to right. Backspace fixes mistakes. Quotes and dashes are skipped automatically.</p>
    </div>
  );
}

interface Token { startOffset: number; endOffset: number }

function splitIntoTokens(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && !/[A-Za-z0-9]/.test(text[i]!)) i++;
    if (i >= text.length) break;
    let j = i;
    while (j < text.length && /[A-Za-z0-9'-]/.test(text[j]!)) j++;
    while (j < text.length && /[.,;:!?)"']/.test(text[j]!)) j++;
    out.push({ startOffset: i, endOffset: j });
    i = j;
  }
  return out;
}

function renderDone(text: string, cursor: number, engine: BooksEngineState): string {
  const done = text.slice(0, cursor);
  if (engine.errors.length === 0) return done;
  // show pending red errors at the cursor
  return done + engine.errors.join("");
}

/* ---------------- Result ---------------- */

function WordsResult({ result, onDone }: { result: TypingResult; onDone: () => void }) {
  const [showWords, setShowWords] = useState(false);
  const m = result.metrics;
  return (
    <div className="card typing-result">
      <h3>{result.mode === "words" ? "Words" : "Books"} — {result.status === "completed" ? "Complete" : result.status === "failed" ? "Failed" : "Interrupted"}</h3>
      {result.mode === "words" && <p className="muted small">Level {String(result.level).padStart(2, "0")}</p>}
      {result.book && <p className="muted small">{result.book.title} · {result.book.chapter ?? "—"} · {result.book.percentRead}% read</p>}
      <div className="stat-grid">
        <Stat label="Score" value={String(m.score)} />
        <Stat label="Best score" value={result.best.score === null ? "—" : String(result.best.score)} />
        <Stat label="WPM" value={String(Math.round(m.wpm))} />
        <Stat label="Best WPM" value={result.best.wpm === null ? "—" : String(Math.round(result.best.wpm))} />
        <Stat label="CPM" value={String(Math.round(m.cpm))} />
        <Stat label="Accuracy" value={m.accuracy === null ? "—" : `${Math.round(m.accuracy)}%`} />
        <Stat label="Errors" value={String(m.errors)} />
        {result.wordsShown !== undefined && <Stat label="Words shown" value={String(result.wordsShown)} />}
        {result.wordsDestroyed !== undefined && <Stat label="Destroyed" value={String(result.wordsDestroyed)} />}
        <Stat label="Time" value={fmtDuration(m.activeMs)} />
      </div>
      {result.comparison && <p className="muted small">{result.comparison.faster ? "" : "slower "}{result.comparison.percent}% {result.comparison.faster ? "faster" : "slower"} than last time</p>}
      <p className="small">Skill: <strong>{result.skill}</strong> · {result.xpAwarded} XP</p>
      {result.words && result.words.length > 0 && (
        <details>
          <summary>Words in this session ({result.words.length})</summary>
          <ul className="typing-word-list">
            {result.words.map((w) => (
              <li key={`${w.order}-${w.planIndex}`}>
                <strong>{w.lemma}</strong>
                {w.translationRu && <span className="muted"> — {w.translationRu}</span>}
                <span className="muted small"> · {w.source === "vocabulary" ? "My Vocabulary" : "General"}{w.unverified ? " (unverified)" : ""}{w.partOfSpeech ? ` · ${w.partOfSpeech}` : ""}{w.destroyed ? "" : " · not destroyed"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="actions">
        <button className="btn btn-primary" onClick={onDone} data-testid="typing-done">Continue</button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><span className="stat-num">{value}</span><span className="stat-label">{label}</span></div>;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
