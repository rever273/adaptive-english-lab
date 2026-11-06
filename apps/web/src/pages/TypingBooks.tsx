import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { splitSentences } from "@english-lab/contracts";
import * as api from "../api";
import type { TypingBookStartResponse, TypingResult } from "../api";
import { TypingKeyboard } from "../components/TypingKeyboard";
import { createBooksEngine, handleBookKey, type BooksEngineState } from "../game/booksEngine";
import { firstTranslation, normalizeBookWord } from "../format";
import { BooksScene } from "../game/booksScene";
import { playPracticeSound } from "../practiceSounds";
import { CYRILLIC, LAYOUT_HINT, Toast, useToast } from "./typingShared";

/** the key the learner must press next, as a character for the keyboard hint (capital letters keep their case, so Shift lights up) */
function hintChar(engine: BooksEngineState): string | null {
  const k = engine.remaining[0];
  if (!k) return null;
  if (/^[a-z]$/.test(k.key)) {
    const shown = engine.text.charAt(k.offset).normalize("NFD").replace(/[̀-ͯ]/g, "");
    return /^[A-Za-z]$/.test(shown) ? shown : k.key;
  }
  return k.key;
}

const pct = (n: number) => Math.max(0, Math.min(100, n));

function Progress({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="typing-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}>
      <div className="typing-progress-fill" style={{ width: `${percent}%` }} />
      <span className="typing-progress-label">{label} ({percent.toFixed(1)}%)</span>
    </div>
  );
}

interface Gloss {
  text: string;
  lemma: string | null;
  x: number;
  y: number;
  below: boolean;
}

/** words with a mistake in them, that are not saved yet: worth adding to My Vocabulary */
function struggledWords(engine: BooksEngineState, known: Map<string, unknown>): string[] {
  const out: string[] = [];
  for (const tok of engine.tokens) {
    let slipped = false;
    for (let o = tok.startOffset; o < tok.endOffset && !slipped; o++) slipped = engine.slipped.has(o);
    if (!slipped) continue;
    const w = normalizeBookWord(engine.text.slice(tok.startOffset, tok.endOffset));
    if (w.length >= 4 && /^[a-z'-]+$/.test(w) && !known.has(w) && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 8);
}

export function BooksGame({ sessionId, data, onResult, onExit }: { sessionId: string; data: TypingBookStartResponse; onResult: (r: TypingResult, struggled: string[]) => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BooksScene | null>(null);
  const engineRef = useRef<BooksEngineState | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [version, setVersion] = useState(0);
  const [layoutNotice, showLayoutNotice] = useToast();
  const [capitalNotice, showCapitalNotice] = useToast(1800);
  const lastCheckpoint = useRef(0);
  const finishing = useRef(false);
  const soundsRef = useRef(true);
  const kbRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState({ canvas: 220, text: 220 });
  /** translations of the learner's own saved words found in this text, by normalised word */
  const knownRef = useRef(new Map<string, { lemma: string; translationRu: string }>());
  const [gloss, setGloss] = useState<Gloss | null>(null);
  // the speed on this level so far (correct characters / 5 per minute of active time), refreshed while the game runs
  const [liveWpm, setLiveWpm] = useState<number | null>(null);
  // offsets of the letters that belong to my saved words (coloured differently); set once the server has answered
  const [vocabOffsets, setVocabOffsets] = useState<Set<number>>(new Set());
  const glossTimer = useRef<number | undefined>(undefined);
  const glossShown = useRef(new Set<number>());
  // F3: a quick Russian translation of the sentence being typed, shown on the strip where the ship flies
  const sentences = useMemo(() => splitSentences(data.text), [data.text]);
  const [translation, setTranslation] = useState<{ start: number; end: number; status: "loading" | "ready" | "error"; text: string } | null>(null);
  const translationRef = useRef(translation);
  translationRef.current = translation;
  const translationCache = useRef(new Map<number, string>());

  // F4: hear the previous sentence in a Piper voice (one voice per paragraph). The audio is made on the spot and kept only in this page's memory.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechClips = useRef(new Map<number, Promise<string>>());
  const speechOff = useRef(false);
  const [speechMsg, setSpeechMsg] = useState<string | null>(null);
  const speechTimer = useRef<number | undefined>(undefined);
  const say = useCallback((text: string | null, ms = 3000) => {
    setSpeechMsg(text);
    window.clearTimeout(speechTimer.current);
    if (text) speechTimer.current = window.setTimeout(() => setSpeechMsg(null), ms);
  }, []);
  const paragraphOf = useCallback((start: number) => Math.max(0, data.text.slice(0, start).split(/\n\s*\n/).length - 1), [data.text]);
  const clipFor = useCallback((s: { start: number; end: number }): Promise<string> => {
    let clip = speechClips.current.get(s.start);
    if (!clip) {
      clip = api.fetchBookSpeech({ text: data.text.slice(s.start, s.end), sessionId, paragraph: paragraphOf(s.start) }).then((b) => URL.createObjectURL(b));
      clip.catch(() => speechClips.current.delete(s.start));
      speechClips.current.set(s.start, clip);
    }
    return clip;
  }, [data.text, sessionId, paragraphOf]);
  /** the sentence before the one being typed (null while the first one is still being typed) */
  const previousSentence = useCallback(() => {
    const off = engineRef.current?.offset ?? 0;
    const i = sentences.findIndex((s) => off <= s.end);
    const current = i < 0 ? sentences.length : i;
    return current > 0 ? sentences[current - 1]! : null;
  }, [sentences]);
  const speakPrevious = useCallback(async () => {
    if (speechOff.current) { say("Piper is not available. Run npm run dictation:setup."); return; }
    const prev = previousSentence();
    if (!prev) { say("Finish the first sentence, then press F4 to hear it."); return; }
    const ready = speechClips.current.has(prev.start);
    if (!ready) say("Preparing the voice…", 6000);
    try {
      const url = await clipFor(prev);
      // pressing again restarts the sentence instead of layering a second voice over it
      audioRef.current?.pause();
      const a = new Audio(url);
      audioRef.current = a;
      say(null);
      await a.play();
    } catch (e) {
      if (e instanceof api.ApiRequestError && e.status === 409) speechOff.current = true;
      say(e instanceof Error ? e.message : "Could not read this sentence aloud.");
    }
  }, [clipFor, previousSentence, say]);
  const speakRef = useRef(speakPrevious);
  speakRef.current = speakPrevious;
  useEffect(() => {
    void api.warmBookSpeech();
    const clips = speechClips.current;
    return () => {
      audioRef.current?.pause();
      window.clearTimeout(speechTimer.current);
      for (const c of clips.values()) void c.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      clips.clear();
    };
  }, []);

  // the text is the important block: it gets half of the room below the bars, the field takes the rest, and together with the keyboard
  // they fill the window down to its bottom edge without scrolling
  useLayoutEffect(() => {
    const fit = () => {
      const c = canvasRef.current;
      const k = kbRef.current;
      if (!c || !k) return;
      const room = window.innerHeight - c.getBoundingClientRect().top - k.offsetHeight - 24;
      const text = Math.max(150, Math.min(520, Math.round(room * 0.5)));
      setHeights({ text, canvas: Math.max(120, Math.round(room - text)) });
    };
    window.scrollTo(0, 0);
    fit();
    window.addEventListener("resize", fit);
    const ro = new ResizeObserver(fit);
    if (kbRef.current) ro.observe(kbRef.current);
    return () => { window.removeEventListener("resize", fit); ro.disconnect(); };
  }, []);

  // which words of this level are my saved words (asked once, answered by the server's own matching rules)
  useEffect(() => {
    let active = true;
    const words = [...new Set(engineRef.current!.tokens.map((t) => normalizeBookWord(data.text.slice(t.startOffset, t.endOffset))).filter(Boolean))];
    void api.matchVocabulary(words).then((r) => {
      if (!active) return;
      knownRef.current = new Map(r.matches.map((m) => [m.word, { lemma: m.lemma, translationRu: m.translationRu }]));
      const offsets = new Set<number>();
      for (const t of engineRef.current!.tokens) {
        if (!knownRef.current.has(normalizeBookWord(data.text.slice(t.startOffset, t.endOffset)))) continue;
        for (let o = t.startOffset; o < t.endOffset; o++) offsets.add(o);
      }
      setVocabOffsets(offsets);
    }).catch(() => {});
    return () => { active = false; window.clearTimeout(glossTimer.current); };
  }, [data]);

  if (!engineRef.current) {
    engineRef.current = createBooksEngine({
      text: data.text,
      startOffset: data.startOffset,
      initialOffset: data.currentOffset,
      initialActiveMs: data.activeMs,
      initialCharsTyped: data.charsTyped,
      initialErrors: data.errors,
    });
  }
  const engine = engineRef.current;

  useEffect(() => {
    let active = true;
    void api.fetchSettings().then((settings) => { if (active) soundsRef.current = settings.values.typingSoundsEnabled ?? true; }).catch(() => {});
    return () => { active = false; };
  }, []);

  const togglePause = useCallback(() => {
    setPaused((p) => { pausedRef.current = !p; return !p; });
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const correct = e.charsTyped - e.errorCount;
      const wpm = e.activeMs >= 4000 ? Math.round((correct / 5 / (e.activeMs / 60000)) * 10) / 10 : null;
      setLiveWpm((prev) => (prev === wpm ? prev : wpm));
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const counters = useCallback(() => ({ offset: data.startOffset + engine.offset, activeMs: Math.round(engine.activeMs), charsTyped: engine.charsTyped, errors: engine.errorCount }), [data.startOffset, engine]);

  const checkpoint = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastCheckpoint.current < 2000) return;
    lastCheckpoint.current = now;
    void api.checkpointTypingBook(sessionId, counters());
  }, [sessionId, counters]);

  const complete = useCallback(() => {
    if (finishing.current) return;
    finishing.current = true;
    void api.completeTypingBook(sessionId, { ...counters(), offset: data.endOffset, bestCombo: engine.bestCombo, keyStats: [...engine.keyStats].map(([pair, f]) => ({ pair, count: f.count, totalMs: f.totalMs, errors: f.errors })).filter((f) => f.count > 0 || f.errors > 0) }).then((result) => {
      api.announceXp();
      onResult(result, struggledWords(engine, knownRef.current));
    }).catch(() => onExit());
  }, [sessionId, counters, data.endOffset, onResult, onExit, engine]);

  // the scene
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new BooksScene(canvas, { engine, level: data.level, paused: () => pausedRef.current });
    sceneRef.current = scene;
    scene.start();
    const onResize = () => scene.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);
    return () => { scene.stop(); ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, [engine, data.level]);

  // keyboard input and saving progress
  useEffect(() => {
    const sound = (kind: Parameters<typeof playPracticeSound>[0], volume?: number) => playPracticeSound(kind, soundsRef.current, volume);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.getModifierState("AltGraph") || e.isComposing) return;
      // typing into the "add word" panel or any field is not game input
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true], .word-panel")) return;
      if (e.key === "Escape" || e.key === "F2") { e.preventDefault(); if (!e.repeat) togglePause(); return; }
      if (e.key === "F3") { e.preventDefault(); if (!e.repeat && !pausedRef.current) toggleTranslationRef.current(); return; }
      if (e.key === "F4") { e.preventDefault(); if (!e.repeat && !pausedRef.current) void speakRef.current(); return; }
      if (e.key !== "Backspace" && e.key.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && e.key !== "Backspace") return;
      if (pausedRef.current || finishing.current) return;
      if (CYRILLIC.test(e.key)) { showLayoutNotice(); return; }
      const before = engine.offset;
      const r = handleBookKey(engine, e.key);
      if (r.kind === "ignored") return;
      const fired = sceneRef.current?.keyResult(r.kind, before) ?? { shot: false, wordDone: false };
      if (r.kind === "error") sound("incorrect");
      else if (r.kind === "capital") showCapitalNotice();
      if (fired.shot) sound("shoot", 0.05);
      if (fired.wordDone) window.setTimeout(() => sound("explode", 0.12), 130);
      setVersion((v) => v + 1);
      if (fired.wordDone || r.tokenComplete) checkpoint();
      if (r.finished) {
        window.setTimeout(() => sound("complete"), 450);
        window.setTimeout(() => complete(), 1100);
      }
    };
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      pausedRef.current = true;
      setPaused(true);
      checkpoint(true);
      void api.sendKeepalive(`/api/v1/typing/books/${encodeURIComponent(sessionId)}/checkpoint`, counters());
    };
    const onPageHide = () => { void api.sendKeepalive(`/api/v1/typing/books/${encodeURIComponent(sessionId)}/checkpoint`, counters()); };
    window.addEventListener("keydown", onKey, { capture: true });
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [engine, checkpoint, complete, counters, sessionId, togglePause, showLayoutNotice, showCapitalNotice]);

  const toggleTranslation = useCallback(() => {
    const off = engine.offset;
    const sent = sentences.find((s) => off <= s.end) ?? sentences[sentences.length - 1];
    if (!sent) return;
    if (translationRef.current?.start === sent.start) { setTranslation(null); return; }
    const cached = translationCache.current.get(sent.start);
    if (cached !== undefined) { setTranslation({ start: sent.start, end: sent.end, status: "ready", text: cached }); return; }
    setTranslation({ start: sent.start, end: sent.end, status: "loading", text: "" });
    void api.translateSentence(engine.text.slice(sent.start, sent.end)).then((r) => {
      translationCache.current.set(sent.start, r.text);
      setTranslation((cur) => (cur?.start === sent.start ? { ...cur, status: "ready", text: r.text } : cur));
    }).catch(() => {
      setTranslation((cur) => (cur?.start === sent.start ? { ...cur, status: "error", text: "Translation unavailable right now." } : cur));
    });
  }, [engine, sentences]);
  const toggleTranslationRef = useRef(toggleTranslation);
  toggleTranslationRef.current = toggleTranslation;

  const abort = () => {
    void api.abortTypingBook(sessionId, { activeMs: Math.round(engine.activeMs), charsTyped: engine.charsTyped, errors: engine.errorCount });
    onExit();
  };

  // the translation of one of my words pops up over it when I reach it, and goes away by itself
  useEffect(() => {
    if (pausedRef.current) return;
    const tok = engine.tokens.find((t) => engine.offset >= t.startOffset && engine.offset < t.endOffset);
    if (!tok || glossShown.current.has(tok.startOffset)) return;
    const word = normalizeBookWord(engine.text.slice(tok.startOffset, tok.endOffset));
    const hit = knownRef.current.get(word);
    if (!hit) return;
    const first = document.querySelector<HTMLElement>(`.books-text [data-o="${tok.startOffset}"]`)?.getBoundingClientRect();
    const last = document.querySelector<HTMLElement>(`.books-text [data-o="${tok.endOffset - 1}"]`)?.getBoundingClientRect();
    if (!first || !last) return;
    glossShown.current.add(tok.startOffset);
    const below = first.top < 70;
    setGloss({ text: firstTranslation(hit.translationRu), lemma: hit.lemma !== word ? hit.lemma : null, x: (first.left + last.right) / 2, y: below ? first.bottom + 8 : first.top - 8, below });
    window.clearTimeout(glossTimer.current);
    glossTimer.current = window.setTimeout(() => setGloss(null), 3000);
  }, [version, engine]);

  const currentSentenceStart = (() => { const i = sentences.findIndex((s) => engine.offset <= s.end); return i < 0 ? sentences.length : i; })();
  useEffect(() => {
    if (speechOff.current || currentSentenceStart < 1) return;
    const prev = sentences[currentSentenceStart - 1];
    if (prev) void clipFor(prev).catch((e) => { if (e instanceof api.ApiRequestError && e.status === 409) speechOff.current = true; });
  }, [currentSentenceStart, sentences, clipFor]);

  const absolute = data.startOffset + engine.offset;
  const chapter = data.chapters.find((c) => absolute >= c.startOffset && absolute < c.endOffset)?.title ?? data.chapters.find((c) => absolute >= c.startOffset && absolute <= c.endOffset)?.title ?? null;
  const levelPercent = pct(engine.allKeys.length > 0 ? ((engine.allKeys.length - engine.remaining.length) / engine.allKeys.length) * 100 : 100);
  const bookPercent = pct(data.textLength > 0 ? (absolute / data.textLength) * 100 : 0);

  return (
    <div className="typing-game typing-books">
      <div data-no-word style={{ userSelect: "none" }}>
        <div className="typing-game-bar">
          <span className="books-title">
            <span>{data.title} · Level {String(data.level).padStart(2, "0")}</span>
            {chapter && <span className="muted small" title="Current chapter">{chapter}</span>}
          </span>
          <span className="muted small typing-live" title="Your actual speed on this level so far: correct characters / 5 per minute of play. Updates all the time.">Speed: {liveWpm === null ? "—" : Math.round(liveWpm)} WPM</span>
          <span className="actions">
            <button className="btn" onClick={() => void speakPrevious()} title="Hear the previous sentence (F4)">Hear previous (F4)</button>
            <button className="btn" onClick={() => toggleTranslation()} title="Russian translation of this sentence (F3)">Translate (F3)</button>
            <button className="btn" onClick={togglePause} title="F2">{paused ? "Resume" : "Pause"} (F2)</button>
            <button className="btn" onClick={abort}>Exit</button>
          </span>
        </div>
        <div className="typing-progress-row">
          <Progress label="This level" percent={levelPercent} />
          <Progress label="Whole book" percent={bookPercent} />
        </div>
        <div className="typing-stage">
          <canvas ref={canvasRef} className="typing-canvas books-canvas" style={{ height: heights.canvas }} aria-label="Books typing game" />
          {paused && <div className="typing-paused" role="status">Paused — press Resume, F2 or Esc to continue.</div>}
          {translation && engine.offset <= translation.end && (
            <div className={`books-translation${translation.status === "error" ? " error" : ""}`} role="status" lang="ru">
              {translation.status === "loading" ? "Translating…" : translation.text}
            </div>
          )}
          {layoutNotice && <Toast text={LAYOUT_HINT} />}
          {speechMsg && <Toast text={speechMsg} />}
          {capitalNotice && <Toast text="Capital letter — hold Shift" />}
        </div>
      </div>
      <BookText engine={engine} version={version} height={heights.text} vocab={vocabOffsets} />
      {gloss && <div className={`books-gloss${gloss.below ? " below" : ""}`} style={{ left: gloss.x, top: gloss.y }} role="status" data-no-word><strong>{gloss.text}</strong>{gloss.lemma && <span> · {gloss.lemma}</span>}</div>}
      <div ref={kbRef} data-no-word style={{ userSelect: "none" }}>
        <TypingKeyboard next={paused || engine.errors.length > 0 ? null : hintChar(engine)} />
        <p className="muted small">Type the text left to right; F3 translates the sentence; F4 reads the previous sentence aloud; select a word with the mouse to save it. Your saved words are tinted. Backspace removes a wrong letter. Quotes, long dashes and other marks in dark blue are skipped for you.</p>
      </div>
    </div>
  );
}

/** the level text, one span per character so the colours can follow the typing without disturbing a mouse selection */
function BookText({ engine, version, height, vocab }: { engine: BooksEngineState; version: number; height: number; vocab: ReadonlySet<number> }) {
  const box = useRef<HTMLDivElement>(null);
  // the text uses the room it has: the largest size between 18 and 34 px at which the whole level fits the block (a longer text keeps 18 px and scrolls)
  const [fontPx, setFontPx] = useState(18);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      let size = 34;
      el.style.fontSize = `${size}px`;
      while (size > 18 && el.scrollHeight > el.clientHeight + 1) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
      el.style.fontSize = "";
      setFontPx((prev) => (prev === size ? prev : size));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height, engine.text]);
  const keyOffsets = useMemo(() => new Set(engine.allKeys.map((k) => k.offset)), [engine]);
  const cursor = engine.offset;

  // keep the line being typed in view
  useEffect(() => {
    const el = box.current;
    const cur = el?.querySelector<HTMLElement>(".bk-cursor");
    if (el && cur) el.scrollTop = Math.max(0, cur.offsetTop - el.clientHeight * 0.4);
  }, [version]);

  const out: ReactNode[] = [];
  const text = engine.text;
  const errors = () => engine.errors.map((ch, n) => <span key={`e${n}`} className="bk-err">{ch}</span>);
  for (let i = 0; i < text.length; i++) {
    if (i === cursor) out.push(...errors());
    const isKey = keyOffsets.has(i);
    let cls: string;
    if (!isKey) cls = "bk-skip";
    else if (i < cursor) cls = (engine.slipped.has(i) ? "bk-slip" : vocab.has(i) ? "bk-vocab-ok" : "bk-ok") + (engine.capsMissed.has(i) ? " bk-cap" : "");
    else if (i === cursor) cls = "bk-cursor";
    else cls = vocab.has(i) ? "bk-vocab-rest" : "bk-rest";
    out.push(<span key={i} data-o={i} className={cls}>{text.charAt(i)}</span>);
  }
  if (cursor >= text.length) out.push(...errors());
  return <div ref={box} className="books-text" style={{ height, fontSize: `${fontPx}px` }} aria-label="Book text">{out}</div>;
}
