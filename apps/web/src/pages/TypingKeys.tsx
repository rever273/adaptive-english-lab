import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as api from "../api";
import type { TypingKeysResult, TypingKeysStartResponse, TypingKeyState, TypingKeyToken } from "../api";
import { firstTranslation } from "../format";
import { Chart } from "../components/Chart";
import { ErrorMeter, ProgressBar, SpeedMeter, fmtSpeed, readUnit, saveUnit, type SpeedUnit } from "../components/KeyMeters";
import { TypingKeyboard } from "../components/TypingKeyboard";
import { checkDailyGoal } from "../components/DailyGoalNotice";
import { HOTKEYS, useEnterContinue } from "../components/hotkeys";
import { playPracticeSound } from "../practiceSounds";
import { useTypingActivity } from "../typingActivity";
import { CYRILLIC, LAYOUT_HINT, Toast, useToast } from "./typingShared";
import { useDrillSpeech } from "./TypingDrills";

/** real words are read aloud when they become the word to type (once per lesson); the switch is remembered in this browser */
const SPEECH_KEY = "el_keys_speech";
const readSpeech = (): boolean => { try { return localStorage.getItem(SPEECH_KEY) !== "0"; } catch { return true; } };
const saveSpeech = (on: boolean): void => { try { localStorage.setItem(SPEECH_KEY, on ? "1" : "0"); } catch { /* unavailable */ } };

/**
 * Key Builder (keybr.com guided lessons): a short line of real words and pseudo-words made only of the open letters. A wrong key is not
 * accepted; it counts as a miss of the expected key. The time of a key is the interval since the previous correct key, only when the key
 * was hit at the first try and the interval is not a pause.
 */

/** an interval longer than this is a pause: it is neither key time nor active time */
const PAUSE_MS = 3000;
/** a letter-pair interval longer than this says nothing about the pair (as in Words and Drills) */
const MAX_PAIR_INTERVAL_MS = 2000;

interface Fact {
  hits: number;
  misses: number;
  ms: number;
  timed: number;
}

/** one press of an expected letter in a lesson: its time since the previous key (null = not timed) and whether it was a wrong key */
export interface KeyPress { ms: number | null; miss: boolean }
export type KeyPresses = Record<string, KeyPress[]>;

interface Engine {
  /** every press of each letter in order, for the per-key chart of the report */
  presses: Map<string, KeyPress[]>;
  pos: number;
  charsTyped: number;
  errors: number;
  activeMs: number;
  lastKeyAt: number | null;
  missedHere: boolean;
  facts: Map<string, Fact>;
  /** positions typed with at least one miss */
  missed: Set<number>;
  /** letter pairs inside words, as in Words and Books */
  pairs: Map<string, { count: number; totalMs: number; errors: number }>;
  charStreak: number;
  bestCharStreak: number;
}

export function KeyChips({ keys, targetCpm, numbered = false }: { keys: TypingKeyState[]; targetCpm: number; numbered?: boolean }) {
  return (
    <div className="keys-chips" aria-label="Keys in the order they open">
      {keys.map((k, idx) => {
        // readiness = best speed against the target and recent accuracy together; 1 = the key has reached the target
        const c = k.readiness;
        const speedOk = (k.bestConfidence ?? 0) >= 1;
        const acc = k.errorRate == null ? null : Math.round((1 - k.errorRate) * 1000) / 10;
        const why = !k.included ? "" : c >= 1 ? " · reached" : !speedOk ? " · needs speed" : " · needs accuracy";
        const title = k.included
          ? `${k.letter.toUpperCase()}: ${k.cpm == null ? "no data yet" : `${k.cpm} CPM (best ${Math.round((k.bestConfidence ?? 0) * targetCpm)})`}, accuracy ${acc == null ? "—" : `${acc}%`}, target ${targetCpm} CPM${why}${k.focused ? " · focused key" : ""}`
          : `${k.letter.toUpperCase()}: opens later`;
        // the chip fills from the bottom as the key's best speed nears the target; the colour goes from red (half the target) to green
        const fill = Math.round(Math.min(1, Math.max(0, c)) * 100);
        const hue = Math.round(Math.min(1, Math.max(0, (c - 0.5) / 0.5)) * 120);
        const style = k.included ? ({ "--fill": `${fill}%`, "--hue": hue } as CSSProperties) : undefined;
        const chip = (
          <span className={`keys-chip${k.included ? "" : " off"}${k.focused ? " focused" : ""}`} style={style} title={title}>
            {k.letter}
          </span>
        );
        if (!numbered) return <span key={k.letter} className="keys-chip-solo">{chip}</span>;
        return (
          <span key={k.letter} className="keys-chip-cell">
            {chip}
            <span className="keys-chip-num">{idx + 1}</span>
          </span>
        );
      })}
    </div>
  );
}

/** a word of the project's word bank: it has a translation, is read aloud and shown in its own colour */
const isBank = (t: TypingKeyToken | undefined): t is TypingKeyToken => t?.kind === "word" && t.translationRu != null;

export interface KeysReport { result: TypingKeysResult; tokens: TypingKeyToken[]; presses: KeyPresses }

export function KeysGame({ plan, onResult, onExit, showStats, onShowStats, lastReport }: { plan: TypingKeysStartResponse; onResult: (result: TypingKeysResult, tokens: TypingKeyToken[], presses: KeyPresses) => void; onExit: () => void; showStats: boolean; onShowStats: (on: boolean) => void; lastReport: KeysReport | null }) {
  // the last report is opened over the lesson, which waits (paused) until it is closed
  const [reportOpen, setReportOpen] = useState(false);
  const reportOpenRef = useRef(false);
  const text = useMemo(() => plan.tokens.map((t) => t.text).join(" "), [plan.tokens]);
  // token index of every character (spaces belong to the following token)
  const tokenAt = useMemo(() => {
    const out: number[] = [];
    plan.tokens.forEach((t, i) => {
      if (i > 0) out.push(i);
      for (let k = 0; k < t.text.length; k++) out.push(i);
    });
    return out;
  }, [plan.tokens]);
  const engine = useRef<Engine>({ presses: new Map(), pos: 0, charsTyped: 0, errors: 0, activeMs: 0, lastKeyAt: null, missedHere: false, facts: new Map(), missed: new Set(), pairs: new Map(), charStreak: 0, bestCharStreak: 0 });
  const flushActivity = useTypingActivity(plan.lessonId, "words", () => engine.current.activeMs);
  const [, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [wrongFlash, setWrongFlash] = useState(false);
  const [layoutNotice, showLayoutNotice] = useToast();
  const finishing = useRef(false);
  const soundsRef = useRef(true);
  useEffect(() => {
    void api.fetchSettings().then((s) => { soundsRef.current = s.values.typingSoundsEnabled ?? true; }).catch(() => {});
  }, []);
  const [speechOn, setSpeechOn] = useState(readSpeech);
  const spoken = useMemo(() => [...new Set(plan.tokens.filter(isBank).map((t) => t.text))].map((lemma) => ({ lemma, speak: true })), [plan.tokens]);
  const speak = useDrillSpeech(spoken, speechOn);
  const said = useRef(new Set<string>());

  const fact = (letter: string): Fact => {
    const f = engine.current.facts.get(letter) ?? { hits: 0, misses: 0, ms: 0, timed: 0 };
    engine.current.facts.set(letter, f);
    return f;
  };

  const pressesOf = (letter: string): KeyPress[] => {
    const m = engine.current.presses;
    return m.get(letter) ?? m.set(letter, []).get(letter)!;
  };

  const finish = useCallback(() => {
    if (finishing.current) return;
    finishing.current = true;
    const e = engine.current;
    flushActivity();
    playPracticeSound("complete", soundsRef.current);
    void api.completeTypingKeys(plan.lessonId, {
      activeMs: Math.round(e.activeMs),
      charsTyped: e.charsTyped,
      errors: e.errors,
      keys: [...e.facts].filter(([l]) => /^[a-z]$/.test(l)).map(([letter, f]) => ({ letter, hits: f.hits, misses: f.misses, meanMs: f.timed > 0 ? Math.round(f.ms / f.timed) : 0 })),
      keyStats: [...e.pairs].filter(([, f]) => f.count > 0 || f.errors > 0).map(([pair, f]) => ({ pair, ...f })),
      bestCharStreak: e.bestCharStreak,
    }).then((result) => {
      checkDailyGoal("words");
      api.announceXp();
      onResult(result, plan.tokens, Object.fromEntries(e.presses));
    }).catch(() => onExit());
  }, [plan.lessonId, plan.tokens, flushActivity, onResult, onExit]);

  const press = useCallback((key: string) => {
    const e = engine.current;
    if (e.pos >= text.length) return;
    const now = performance.now();
    const delta = e.lastKeyAt == null ? null : now - e.lastKeyAt;
    if (delta != null && delta <= PAUSE_MS) e.activeMs += delta;
    e.lastKeyAt = now;
    e.charsTyped++;
    const expected = text[e.pos]!;
    const prev = e.pos > 0 ? text[e.pos - 1]! : " ";
    const pair = expected !== " " && prev !== " " ? prev + expected : null;
    const pairFacts = (p: string) => e.pairs.get(p) ?? e.pairs.set(p, { count: 0, totalMs: 0, errors: 0 }).get(p)!;
    if (key.toLowerCase() !== expected) {
      e.errors++;
      e.charStreak = 0;
      if (pair) pairFacts(pair).errors++;
      if (!e.missedHere && expected !== " ") { fact(expected).misses++; pressesOf(expected).push({ ms: null, miss: true }); }
      e.missedHere = true;
      e.missed.add(e.pos);
      playPracticeSound("incorrect", soundsRef.current);
      setWrongFlash(true);
      window.setTimeout(() => setWrongFlash(false), 150);
      setTick((t) => t + 1);
      return;
    }
    playPracticeSound("shoot", soundsRef.current, 0.05); // the soft key sound of Books
    e.charStreak++;
    e.bestCharStreak = Math.max(e.bestCharStreak, e.charStreak);
    if (pair && delta != null && delta > 0 && delta <= MAX_PAIR_INTERVAL_MS) {
      const pf = pairFacts(pair);
      pf.count++;
      pf.totalMs += Math.round(delta);
    }
    if (expected !== " ") {
      const f = fact(expected);
      f.hits++;
      const timed = !e.missedHere && delta != null && delta <= PAUSE_MS && e.pos > 0;
      if (timed) {
        f.ms += delta;
        f.timed++;
      }
      pressesOf(expected).push({ ms: timed ? Math.round(delta) : null, miss: false });
    }
    e.missedHere = false;
    e.pos++;
    setTick((t) => t + 1);
    if (e.pos >= text.length) finish();
  }, [text, finish]);

  const togglePause = useCallback(() => setPaused((p) => {
    pausedRef.current = !p;
    engine.current.lastKeyAt = null; // the interval across a pause is never key time
    return !p;
  }), []);

  const openReport = useCallback(() => {
    pausedRef.current = true;
    engine.current.lastKeyAt = null;
    setPaused(true);
    reportOpenRef.current = true;
    setReportOpen(true);
  }, []);
  const closeReport = useCallback(() => { reportOpenRef.current = false; setReportOpen(false); }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.getModifierState("AltGraph") || ev.isComposing) return;
      if (reportOpenRef.current) {
        if (ev.key === "Escape") { ev.preventDefault(); closeReport(); }
        return;
      }
      if (ev.key === "Escape" || ev.key === HOTKEYS.pause) { ev.preventDefault(); if (!ev.repeat) togglePause(); return; }
      if (ev.key === "Backspace") { ev.preventDefault(); return; } // a wrong key is never accepted: nothing to delete
      if (ev.key.length !== 1) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.repeat || finishing.current) return;
      if (CYRILLIC.test(ev.key)) { showLayoutNotice(); return; }
      if (pausedRef.current) return;
      press(ev.key);
    };
    // before the first key of the lesson no time runs, so leaving the window does not need a pause
    const onBlur = () => { engine.current.lastKeyAt = null; if (engine.current.charsTyped === 0) return; pausedRef.current = true; setPaused(true); };
    const onHide = () => { if (document.visibilityState === "hidden") onBlur(); };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHide);
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onHide); };
  }, [press, togglePause, showLayoutNotice, closeReport]);

  const abort = () => {
    const e = engine.current;
    flushActivity();
    void api.abortTypingKeys(plan.lessonId, { activeMs: Math.round(e.activeMs), charsTyped: e.charsTyped, errors: e.errors }).catch(() => {});
    onExit();
  };

  const currentIndex = tokenAt[Math.min(engine.current.pos, text.length - 1)] ?? 0;
  useEffect(() => {
    const t = plan.tokens[currentIndex];
    if (!speechOn || !isBank(t) || said.current.has(t.text)) return;
    said.current.add(t.text);
    // the first clip may still be loading: it is played only while its word is still the one to type
    window.setTimeout(() => speak(t.text, () => (tokenAt[Math.min(engine.current.pos, text.length - 1)] ?? 0) === currentIndex), 120);
  }, [currentIndex, speechOn, speak, plan.tokens, tokenAt, text.length]);
  const toggleSpeech = () => setSpeechOn((on) => { saveSpeech(!on); return !on; });

  const e = engine.current;
  const correct = e.charsTyped - e.errors;
  const cpm = e.activeMs >= 3000 ? Math.round(correct / (e.activeMs / 60000)) : null;
  const focused = plan.keys.find((k) => k.focused)?.letter ?? null;
  const next = e.pos < text.length ? text[e.pos]! : null;
  let offset = 0;

  return (
    <div className="typing-game keys-game" data-no-word style={{ userSelect: "none" }}>
      <div className="typing-game-bar">
        <span>Key Builder · Lesson {String(plan.lessonNumber).padStart(2, "0")}</span>
        <span className="muted small" title="Every open key must reach the target speed, and all open keys together the accuracy limit, before the next letter opens. The target is set in Settings and does not change by itself (as in keybr).">Target {plan.targetCpm} CPM ({Math.round(plan.targetCpm / 5)} WPM) · goal {Math.round(plan.goalCpm / 5)} WPM{focused ? <> · Focus: <b className="keys-focus-letter">{focused}</b></> : null}</span>
        <span className="muted small typing-live">Speed: {cpm === null ? "—" : `${cpm} CPM`}</span>
        <span className="actions">
          <button className="btn" onClick={toggleSpeech} aria-pressed={speechOn} title="Say each real word aloud when it comes up"><i className={`pi ${speechOn ? "pi-volume-up" : "pi-volume-off"}`} aria-hidden="true" /></button>
          <ShowStatsToggle checked={showStats} onChange={onShowStats} />
          <button className="btn" onClick={openReport} disabled={!lastReport} title={lastReport ? "Open the report of the previous lesson (the lesson is paused)" : "No report yet: finish a lesson first"} data-testid="keys-last-report">Last report</button>
          <button className="btn" onClick={togglePause} title="F2">{paused ? "Resume" : "Pause"} (F2)</button>
          <button className="btn" onClick={abort}>Exit</button>
        </span>
      </div>
      <KeyChips keys={plan.keys} targetCpm={plan.targetCpm} />
      <div className="typing-stage">
        <div className={`keys-text${wrongFlash ? " wrong" : ""}`} aria-label="Text to type">
          {plan.tokens.map((t, i) => {
            const start = offset;
            offset = start + t.text.length + 1;
            const last = i === plan.tokens.length - 1;
            const kind = t.kind === "pseudo" ? "pseudo" : isBank(t) ? "bank" : "plain";
            const cls = (p: number) => `keys-char${p === e.pos ? " cursor" : ""}${p < e.pos ? (e.missed.has(p) ? " typed missed" : " typed") : ""}`;
            return (
              <span key={i} className={`keys-token ${kind}${i === currentIndex ? " current" : ""}`} title={kind === "pseudo" ? "Pseudo-word: trains a letter sequence" : kind === "plain" ? "A real word outside your word bank: typed, not read aloud" : undefined}>
                <span className="keys-word">
                  <span className="keys-letters">
                    {[...t.text].map((ch, k) => <span key={k} className={cls(start + k)}>{ch}</span>)}
                    {kind === "bank" && <span className="keys-tr">{firstTranslation(t.translationRu)}</span>}
                  </span>
                  {!last && <span className={`${cls(start + t.text.length)} space`}>{"\u00a0"}</span>}
                </span>
              </span>
            );
          })}
        </div>
        {paused && <div className="typing-paused" role="status">Paused — press Resume, F2 or Esc to continue.</div>}
        {layoutNotice && <Toast text={LAYOUT_HINT} />}
      </div>
      <p className="muted small">Type the line; Space between words. A wrong key is not accepted — just type the right one. <span className="keys-legend bank">Words from your word bank</span> are read aloud with their translation; <span className="keys-legend pseudo">pseudo-words</span> train letter sequences; plain words are other real English words.</p>
      <TypingKeyboard next={paused ? null : next} />
      {reportOpen && lastReport && (
        <div className="keys-report-backdrop" role="dialog" aria-modal="true" aria-label="Report of the previous lesson">
          <KeysResultView result={lastReport.result} tokens={lastReport.tokens} presses={lastReport.presses} onNext={null} onDone={closeReport} showStats={showStats} onShowStats={onShowStats} />
        </div>
      )}
    </div>
  );
}

const STAT_TIPS = {
  wpm: "Words per minute: correct characters ÷ 5, per minute of active time.\nСлов в минуту: верные символы ÷ 5 за минуту активного времени.",
  cpm: "Characters per minute of active time (WPM × 5).\nСимволов в минуту (WPM × 5).",
  accuracy: "Share of keystrokes that were correct.\nДоля верных нажатий.",
  errors: "Wrong keys pressed; a wrong key is not accepted.\nНеверные нажатия.",
  time: "Active typing time, without pauses.\nАктивное время, без пауз.",
  xp: "Typing XP: one per 10 characters of the text.\nОпыт: 1 за 10 символов текста.",
  current: "Median speed of your last 10 lessons; the next stage's target is fixed at it when a letter opens, never above your goal.\nМедиана последних 10 уроков; цель следующего этапа фиксируется по ней при открытии буквы, не выше вашей цели.",
  today: "Key Builder lessons finished today.\nУроков сегодня.",
};

function Stat({ label, value, tip }: { label: string; value: string; tip: string }) {
  return <div className="stat typing-stat" tabIndex={0} role="group" aria-label={`${label}: ${value}. ${tip.replace(/\n/g, " ")}`} data-tip={tip}><span className="stat-num">{value}</span><span className="stat-label">{label}</span></div>;
}

const fmtDuration = (ms: number): string => {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
};

const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;
const lessonsText = (n: number): string => `${n} lesson${n === 1 ? "" : "s"}`;
/** an estimate needs this many lessons with the key (keybr's learning-rate fit) */
const MIN_ESTIMATE_LESSONS = 5;

/** the two goals (all 26 keys, the goal speed) and the next letter, each as a bar */
function GoalBars({ result }: { result: TypingKeysResult }) {
  const open = result.keys.filter((k) => k.included).length;
  const next = result.nextKey;
  return (
    <div className="keys-goals" data-testid="keys-goals">
      <div className="keys-goal">
        <span>All keys</span>
        <ProgressBar value={open / 26} label="Keys open" />
        <b>{open} of 26</b>
      </div>
      <div className="keys-goal">
        <span>Speed goal</span>
        <ProgressBar value={result.currentCpm / result.goalCpm} label="Speed against the goal" />
        <b>
          {Math.round(result.currentCpm / 5)} of {Math.round(result.goalCpm / 5)} WPM
        </b>
      </div>
      {next.letter != null && (
        <div className="keys-goal">
          <span>
            Next key <b className="keys-focus-letter">{next.letter}</b>
          </span>
          <ProgressBar value={next.progress} label="Progress to the next key" />
          <b>{Math.round(next.progress * 100)}%</b>
        </div>
      )}
    </div>
  );
}

/** one key in one lesson: the speed of each press (line), its running average (thick line) and the wrong presses (red bars) */
function KeyPressChart({ letter, presses, targetCpm, unit }: { letter: string; presses: KeyPress[]; targetCpm: number; unit: SpeedUnit }) {
  if (presses.length === 0) return <p className="muted small">The key {letter.toUpperCase()} was not typed in this lesson.</p>;
  let sum = 0;
  let count = 0;
  const points = presses.map((p, i) => {
    const cpm = p.ms != null && p.ms > 0 ? Math.round(60000 / p.ms) : null;
    if (p.ms != null && p.ms > 0) { sum += p.ms; count++; }
    const avg = count > 0 ? Math.round(60000 / (sum / count)) : null;
    return {
      key: String(i),
      label: String(i + 1),
      bar: p.miss ? 1 : null,
      line: cpm,
      line2: targetCpm,
      line3: avg,
      tip: [`Press ${i + 1} of ${letter.toUpperCase()}`, p.miss ? "Wrong key first" : cpm == null ? "Hit, not timed" : fmtSpeed(cpm, unit), avg == null ? "Average: —" : `Average so far: ${fmtSpeed(avg, unit)}`],
    };
  });
  const top = Math.max(targetCpm, ...points.map((p) => p.line ?? 0)) * 1.1;
  return (
    <div className="keys-press-chart" onClick={(e) => e.stopPropagation()}>
      <h4 className="chart-title">Key {letter.toUpperCase()} in this lesson</h4>
      <Chart
        ariaLabel={`Speed of each press of key ${letter} in this lesson`}
        height={220}
        bars={{ color: "#ef7777", format: (v) => (v >= 1 ? "wrong" : v === 0 ? "0" : ""), max: 1 }}
        line={{ color: "#6ab7ff", format: (v) => fmtSpeed(v, unit), max: top }}
        line2={{ color: "#f3c94d", format: (v) => fmtSpeed(v, unit) }}
        line3={{ color: "#1d4ed8" }}
        connectGaps
        points={points}
        legend={`Light blue: speed of each press · dark blue: average of this lesson so far · red bars: presses where a wrong key came first · yellow dashed: the target of ${fmtSpeed(targetCpm, unit)}. Presses after a mistake or a pause are not timed.`}
      />
    </div>
  );
}

/** how to read the bars of the table */
function MeterLegend() {
  return (
    <p className="muted small keys-meter-legend">
      <b>Speed bars</b> run from 0 to the largest speed shown (at least the goal): <span className="kmeter-key target" /> target, <span className="kmeter-key goal" /> goal. <b>Wrong-press bars</b> run from 0% (the aim) to the largest share shown: green up to <span className="kmeter-key limit" /> the limit from Settings, red beyond it.
    </p>
  );
}

/** what the next letter waits for: each open key's speed and accuracy against the stage, this lesson's numbers and an outlook */
function NextKeyPanel({ next, presses, goalCpm, unit, onUnit }: { next: TypingKeysResult["nextKey"]; presses: KeyPresses; goalCpm: number; unit: SpeedUnit; onUnit: (u: SpeedUnit) => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const sp = (cpm: number) => fmtSpeed(cpm, unit);
  const target = next.targetCpm;
  const limit = 1 - next.minAccuracy;
  const blockers = next.keys.filter((k) => !k.speedReached);
  const acc = next.accuracy;
  // the keys that pull the overall accuracy down: above the limit themselves, most wrong first
  const sloppy = next.keys.filter((k) => k.errorRate != null && k.errorRate > limit + 1e-9).sort((a, b) => b.errorRate! - a.errorRate!);
  const lessonRateOf = (k: (typeof next.keys)[number]) => (k.lesson && k.lesson.hits + k.lesson.misses > 0 ? k.lesson.misses / (k.lesson.hits + k.lesson.misses) : null);
  // one scale for all the speed bars, and one for each kind of error bars: the biggest value of the table fills its bar
  const speedMax = Math.max(goalCpm, ...next.keys.flatMap((k) => [k.bestCpm ?? 0, k.lesson?.cpm ?? 0]));
  const judgedErrMax = Math.max(limit, acc.errorRate ?? 0, ...next.keys.map((k) => k.errorRate ?? 0));
  const lessonErrMax = Math.max(limit, ...next.keys.map((k) => lessonRateOf(k) ?? 0));
  const sloppyText = sloppy.map((k) => `${k.letter.toUpperCase()} ${pct(k.errorRate!)}`).join(", ");
  return (
    <div className="keys-next" data-testid="keys-next-key">
      {next.letter == null ? (
        <p className="small">All 26 keys are open; every key is now judged against your goal of {sp(target)}.</p>
      ) : blockers.length === 0 && acc.reached ? (
        <p className="small">
          <b>Every open key has reached the target, so the next key opens with the next lesson.</b>
        </p>
      ) : (
        <>
          <p className="small">
            <b>
              To open <span className="keys-focus-letter">{next.letter}</span> every open key needs:
            </b>
          </p>
          <ul className="small keys-need">
            <li>
              an average speed (the best it has reached) of at least <b>{sp(target)}</b>, over at least <b>3 lessons</b> with the key, and
            </li>
            <li>
              at most <b>{pct(limit)}</b> wrong presses over all open keys together (one key's mistakes are carried by the others).
            </li>
          </ul>
          <p className="small">
            <b>Still to do:</b>
          </p>
          <ul className="small keys-waiting" data-testid="keys-waiting">
            {!acc.reached && (
              <li>
                <b>All open keys</b> — accuracy: {acc.errorRate == null ? "—" : pct(acc.errorRate)} wrong
                {acc.errorBound != null && <> (surely at least {pct(acc.errorBound)}, which must be ≤ {pct(limit)})</>}
                {sloppyText && <span className="muted"> · most mistakes on {sloppyText}</span>}
              </li>
            )}
            {blockers.map((k) => {
              const parts = [`speed: average ${k.bestCpm == null ? "—" : fmtSpeed(k.bestCpm, unit, false)} (best so far) of ${sp(target)}`];
              const est =
                k.lessonsNeeded > 0
                  ? `${lessonsText(k.lessonsNeeded)} more with this key needed (at least 3 in all)`
                  : k.lessonsLeft != null
                  ? `about ${lessonsText(k.lessonsLeft)} at this pace`
                  : k.lessons < MIN_ESTIMATE_LESSONS
                      ? `no estimate yet (${k.lessons} of ${MIN_ESTIMATE_LESSONS} lessons with this key)`
                      : "no estimate: the speed is not rising";
              return (
                <li key={k.letter}>
                  <b className="keys-focus-letter">{k.letter}</b> — {parts.join("; ")} · <span className="muted">{est}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="keys-table-tools">
        <MeterLegend />
        <div className="actions keys-unit-switch" role="group" aria-label="Speed unit">
          <button type="button" className={`btn${unit === "cpm" ? " btn-primary" : ""}`} aria-pressed={unit === "cpm"} onClick={() => onUnit("cpm")} title="Characters per minute">CPM</button>
          <button type="button" className={`btn${unit === "wpm" ? " btn-primary" : ""}`} aria-pressed={unit === "wpm"} onClick={() => onUnit("wpm")} title="Words per minute = CPM ÷ 5">WPM</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table small keys-next-table">
          <thead>
            <tr>
              <th rowSpan={2}>Key</th>
              <th colSpan={2} className="keys-th-group">
                Judged (all lessons, smoothed)
              </th>
              <th colSpan={2} className="keys-th-group">
                This lesson only
              </th>
              <th colSpan={2} className="keys-th-group">
                Done?
              </th>
            </tr>
            <tr>
              <th title="the key's speed averaged over lessons (recent lessons weigh more); the best that average ever reached is judged, not the fastest single lesson">
                Average speed, best
              </th>
              <th title="average share of wrong presses on this key (recent lessons weigh more)">Wrong, average</th>
              <th>Speed</th>
              <th>Wrong</th>
              <th title="each key on its own: its best average speed must reach the target">
                Speed
                <br />
                <span className="muted">each key ≥ {sp(target)}</span>
              </th>
              <th title="all open keys together: the share of wrong presses, after allowing for chance, must not be above the limit; a single key's share is shown only to see which keys raise the total">
                Accuracy
                <br />
                <span className="muted">all keys together ≤ {pct(limit)}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {next.keys.flatMap((k) => {
              const l = k.lesson;
              const lessonRate = lessonRateOf(k);
              const above = sloppy.includes(k);
              const left =
                k.lessonsNeeded > 0
                  ? `${lessonsText(k.lessonsNeeded)} more needed (min 3)`
                  : k.lessonsLeft != null
                  ? `~${lessonsText(k.lessonsLeft)} at this pace`
                  : k.lessons < MIN_ESTIMATE_LESSONS
                    ? `estimate after ${MIN_ESTIMATE_LESSONS} lessons (${k.lessons} so far)`
                    : "no estimate: the speed is not rising";
              const row = (
                <tr key={k.letter} className={`${k.speedReached ? "keys-row-ok" : "keys-row-blocked"} keys-row-click${openKey === k.letter ? " open" : ""}`} onClick={() => setOpenKey(openKey === k.letter ? null : k.letter)} title="Click to show or hide this key's presses in the lesson">
                  <td>
                    <b className="keys-focus-letter">{k.letter}</b>
                  </td>
                  <td>
                    {k.bestCpm == null ? "—" : fmtSpeed(k.bestCpm, unit, false)}
                    {k.cpm != null && <span className="keys-sub">average now {fmtSpeed(k.cpm, unit, false)}</span>}
                    {k.bestCpm != null && <SpeedMeter cpm={k.bestCpm} targetCpm={target} goalCpm={goalCpm} max={speedMax} unit={unit} label={`Key ${k.letter} best average speed`} />}
                  </td>
                  <td>
                    {k.errorRate == null ? "—" : pct(k.errorRate)}
                    {k.errorRate != null && <ErrorMeter rate={k.errorRate} limit={limit} max={judgedErrMax} label={`Key ${k.letter} average wrong presses`} />}
                  </td>
                  <td>
                    {l?.cpm != null ? sp(l.cpm) : "—"}
                    {l?.cpm != null && <SpeedMeter cpm={l.cpm} targetCpm={target} goalCpm={goalCpm} max={speedMax} unit={unit} label={`Key ${k.letter} speed in this lesson`} />}
                  </td>
                  <td>
                    {l ? `${l.misses} of ${l.hits + l.misses}${lessonRate != null ? ` (${pct(lessonRate)})` : ""}` : "not in the text"}
                    {lessonRate != null && <ErrorMeter rate={lessonRate} limit={limit} max={lessonErrMax} label={`Key ${k.letter} wrong presses in this lesson`} />}
                  </td>
                  <td className={k.speedReached ? "ok" : "bad"}>
                    <b>
                      {k.speedReached ? "✓" : "✗"} {k.bestCpm == null ? "—" : fmtSpeed(k.bestCpm, unit, false)} {k.bestCpm != null && k.bestCpm >= target ? "≥" : "<"} {fmtSpeed(target, unit, false)}
                    </b>
                    {!k.speedReached && <span className="keys-sub">{left}</span>}
                    {k.bestCpm != null && <SpeedMeter cpm={k.bestCpm} targetCpm={target} goalCpm={goalCpm} max={speedMax} unit={unit} label={`Key ${k.letter} best average speed`} />}
                  </td>
                  <td className={above ? "warn" : "muted"}>
                    {k.errorRate == null ? "—" : `${pct(k.errorRate)} ${above ? ">" : "≤"} ${pct(limit)}`}
                    <span className="keys-sub">{above ? "raises the total" : "helps the total"}</span>
                    {k.errorRate != null && <ErrorMeter rate={k.errorRate} limit={limit} max={judgedErrMax} label={`Key ${k.letter} average wrong presses`} />}
                  </td>
                </tr>
              );
              return openKey === k.letter ? [row, (
                <tr key={`${k.letter}-chart`} className="keys-press-row">
                  <td colSpan={7}><KeyPressChart letter={k.letter} presses={presses[k.letter] ?? []} targetCpm={target} unit={unit} /></td>
                </tr>
              )] : [row];
            })}
            <tr className={`keys-total-row ${acc.reached && blockers.length === 0 ? "keys-row-ok" : "keys-row-blocked"}`} data-testid="keys-total-row">
              <td>
                <b>All</b>
              </td>
              <td>
                {next.keys.length - blockers.length} of {next.keys.length} keys fast enough
              </td>
              <td>
                {acc.errorRate == null ? "—" : pct(acc.errorRate)}
                <span className="keys-sub">of all presses wrong</span>
                {acc.errorRate != null && <ErrorMeter rate={acc.errorRate} limit={limit} max={judgedErrMax} label="All keys wrong presses" />}
              </td>
              <td colSpan={2} className="muted">
                not judged
              </td>
              <td className={blockers.length === 0 ? "ok" : "bad"}>
                <b>{blockers.length === 0 ? "✓ every key" : `✗ waiting for ${blockers.map((k) => k.letter.toUpperCase()).join(", ")}`}</b>
              </td>
              <td className={acc.reached ? "ok" : "bad"}>
                <b>
                  {acc.reached ? "✓" : "✗"} {acc.errorBound == null ? "—" : pct(acc.errorBound)} {acc.reached ? "≤" : ">"} {pct(limit)}
                </b>
                {acc.errorBound != null && <ErrorMeter rate={acc.errorBound} limit={limit} max={judgedErrMax} label="All keys wrong presses after allowing for chance" />}
                {acc.errorRate != null && acc.errorBound != null && (
                  <>
                    <span className="keys-sub">{pct(acc.errorRate)} measured</span>
                    <span className="keys-sub">{pct(acc.errorBound)} after chance: counts</span>
                    {!acc.reached && sloppy.length > 0 && <span className="keys-sub">fewer mistakes on {sloppy.map((k) => k.letter.toUpperCase()).join(", ")}</span>}
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted small">
        A key passes when its average speed reaches the target (the best that average ever reached; one fast lesson moves it only a little: a tenth after the first 10 lessons with the key, 1/n before). Accuracy is judged over all open keys together, not key by key: a key meets only 10–40 times in a lesson, so a few wrong presses on one key say little. The
        wrong presses of all open keys are added up (recent lessons weigh more), and the “surely at least” margin for chance is compared with {pct(limit)}. The “This lesson only” columns are not judged; they show where today was worse. There is no minimum number of lessons per key: the next letter opens as soon as every open key is fast enough and the keys together are accurate enough.
      </p>
    </div>
  );
}

/** whether the report opens after each lesson; kept in this browser. Off: the next lesson starts at once and the last report stays one click away */
const STATS_KEY = "el_keys_show_stats";
export const readShowStats = (): boolean => { try { return localStorage.getItem(STATS_KEY) !== "0"; } catch { return true; } };
export const saveShowStats = (on: boolean): void => { try { localStorage.setItem(STATS_KEY, on ? "1" : "0"); } catch { /* unavailable */ } };

export function ShowStatsToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="keys-show-stats" title="When off, the next lesson starts right after a lesson ends; open the last report with its button">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="keys-show-stats" /> Show report after each lesson
    </label>
  );
}

/** `onNext` null = the report is only being looked at (the last one, opened during a lesson): it has a Close button and no next lesson */
export function KeysResultView({ result, tokens, presses, onNext, onDone, showStats, onShowStats }: { result: TypingKeysResult; tokens: TypingKeyToken[]; presses: KeyPresses; onNext: (() => void) | null; onDone: () => void; showStats: boolean; onShowStats: (on: boolean) => void }) {
  useEnterContinue(onNext);
  const [unit, setUnit] = useState<SpeedUnit>(readUnit);
  const changeUnit = (u: SpeedUnit) => { saveUnit(u); setUnit(u); };
  const diff = result.previousCpm != null ? result.cpm - result.previousCpm : null;
  const g = result.goalForecast;
  const open = result.keys.filter((k) => k.included).length;
  const focus = result.keys.find((k) => k.focused)?.letter ?? null;
  const words = [...new Map(tokens.filter(isBank).map((t) => [t.text, t])).values()];
  const stats = [
    { label: "WPM", value: String(result.wpm), tip: STAT_TIPS.wpm },
    { label: "CPM", value: String(result.cpm), tip: STAT_TIPS.cpm },
    { label: "Accuracy", value: `${Math.round(result.accuracy * 1000) / 10}%`, tip: STAT_TIPS.accuracy },
    { label: "Errors", value: String(result.errors), tip: STAT_TIPS.errors },
    { label: "Time", value: fmtDuration(result.activeMs), tip: STAT_TIPS.time },
    { label: "Your speed now", value: `${Math.round(result.currentCpm / 5)} WPM`, tip: STAT_TIPS.current },
    { label: "XP", value: `+${result.xpAwarded}`, tip: STAT_TIPS.xp },
    { label: "Lessons today", value: String(result.lessonsToday), tip: STAT_TIPS.today },
  ];
  return (
    <div className="card typing-result keys-result-card">
      {!onNext && <button type="button" className="keys-report-x" onClick={onDone} aria-label="Close report" title="Close (Esc)"><i className="pi pi-times" aria-hidden="true" /></button>}
      <h3>Key Builder — Complete</h3>
      <p className="muted small">Lesson {String(result.lessonNumber).padStart(2, "0")} · {open} of 26 keys open{focus ? ` · next focus ${focus.toUpperCase()}` : ""} · target {fmtSpeed(result.targetCpm, unit)} · goal {fmtSpeed(result.goalCpm, unit)}</p>
      <div className="stat-grid" style={{ gridTemplateColumns: `repeat(${Math.ceil(stats.length / 2)}, minmax(0, 1fr))` }}>
        {stats.map((st) => <Stat key={st.label} label={st.label} value={st.value} tip={st.tip} />)}
      </div>
      {diff != null && <p className={`small typing-compare ${diff >= 0 ? "faster" : "slower"}`}>{diff >= 0 ? `+${diff}` : diff} CPM against the previous lesson</p>}
      {result.newKeys.length > 0 && <p className="small typing-compare faster" data-testid="keys-new">New key: {result.newKeys.map((k) => k.toUpperCase()).join(", ")} — every open key reached the target of {result.targetCpm} CPM and the keys together were accurate enough.</p>}
      {g && <p className="small">{g.lessonsToGoal === 0 ? "Goal reached by your recent lessons." : g.lessonsToGoal != null ? `At this pace: about ${g.lessonsToGoal} lessons (${g.hoursToGoal} h of typing) to ${Math.round(result.goalCpm / 5)} WPM.` : "No upward trend yet in the recent lessons."}</p>}
      <GoalBars result={result} />
      <KeyChips keys={result.keys} targetCpm={result.targetCpm} numbered />
      <NextKeyPanel next={result.nextKey} presses={presses} goalCpm={result.goalCpm} unit={unit} onUnit={changeUnit} />
      {words.length > 0 && (
        <details>
          <summary>Words from your word bank ({words.length})</summary>
          <ul className="typing-word-list">
            {words.map((w) => <li key={w.text}><strong>{w.text}</strong><span className="muted"> — {firstTranslation(w.translationRu)}</span></li>)}
          </ul>
        </details>
      )}
      <div className="actions">
        {onNext ? (
          <>
            <button className="btn btn-primary" onClick={onNext} data-testid="keys-next" autoFocus>Next lesson</button>
            <button className="btn" onClick={onDone} data-testid="typing-done">Back to Typing</button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={onDone} data-testid="keys-report-close" autoFocus>Close report</button>
        )}
        <ShowStatsToggle checked={showStats} onChange={onShowStats} />
      </div>
    </div>
  );
}
