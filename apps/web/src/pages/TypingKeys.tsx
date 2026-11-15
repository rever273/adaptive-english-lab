import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as api from "../api";
import type { TypingKeysResult, TypingKeysStartResponse, TypingKeyState, TypingKeyToken } from "../api";
import { firstTranslation } from "../format";
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

interface Engine {
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

export function KeyChips({ keys, targetCpm }: { keys: TypingKeyState[]; targetCpm: number }) {
  return (
    <div className="keys-chips" aria-label="Keys in the order they open">
      {keys.map((k) => {
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
        return (
          <span key={k.letter} className={`keys-chip${k.included ? "" : " off"}${k.focused ? " focused" : ""}`} style={style} title={title}>
            {k.letter}
          </span>
        );
      })}
    </div>
  );
}

/** a word of the project's word bank: it has a translation, is read aloud and shown in its own colour */
const isBank = (t: TypingKeyToken | undefined): t is TypingKeyToken => t?.kind === "word" && t.translationRu != null;

export function KeysGame({ plan, onResult, onExit }: { plan: TypingKeysStartResponse; onResult: (result: TypingKeysResult, tokens: TypingKeyToken[]) => void; onExit: () => void }) {
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
  const engine = useRef<Engine>({ pos: 0, charsTyped: 0, errors: 0, activeMs: 0, lastKeyAt: null, missedHere: false, facts: new Map(), missed: new Set(), pairs: new Map(), charStreak: 0, bestCharStreak: 0 });
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
      onResult(result, plan.tokens);
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
      if (!e.missedHere && expected !== " ") fact(expected).misses++;
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
      if (!e.missedHere && delta != null && delta <= PAUSE_MS && e.pos > 0) {
        f.ms += delta;
        f.timed++;
      }
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

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.getModifierState("AltGraph") || ev.isComposing) return;
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
    const onBlur = () => { pausedRef.current = true; engine.current.lastKeyAt = null; setPaused(true); };
    const onHide = () => { if (document.visibilityState === "hidden") onBlur(); };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHide);
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onHide); };
  }, [press, togglePause, showLayoutNotice]);

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
        <span className="muted small" title="Every open key must reach the target (speed and accuracy) before the next letter opens. The target is fixed when a letter opens, at your speed then, never above your goal (Settings).">Target {plan.targetCpm} CPM ({Math.round(plan.targetCpm / 5)} WPM) · goal {Math.round(plan.goalCpm / 5)} WPM{focused ? <> · Focus: <b className="keys-focus-letter">{focused}</b></> : null}</span>
        <span className="muted small typing-live">Speed: {cpm === null ? "—" : `${cpm} CPM`}</span>
        <span className="actions">
          <button className="btn" onClick={toggleSpeech} aria-pressed={speechOn} title="Say each real word aloud when it comes up"><i className={`pi ${speechOn ? "pi-volume-up" : "pi-volume-off"}`} aria-hidden="true" /></button>
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

/** a bar from empty to full; the colour runs from red to green with the fill */
function ProgressBar({ value, mini = false, label }: { value: number; mini?: boolean; label: string }) {
  const v = Math.min(1, Math.max(0, value));
  const style = { "--w": `${Math.round(v * 100)}%`, "--hue": Math.round(Math.min(1, Math.max(0, (v - 0.4) / 0.6)) * 120) } as CSSProperties;
  return (
    <span className={`keys-bar${mini ? " mini" : ""}`} style={style} role="img" aria-label={`${label}: ${Math.round(v * 100)}%`}>
      <i />
    </span>
  );
}

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

/** what the next letter waits for: each open key's speed and accuracy against the stage, this lesson's numbers and an outlook */
function NextKeyPanel({ next }: { next: TypingKeysResult["nextKey"] }) {
  const limit = 1 - next.minAccuracy;
  const blockers = next.keys.filter((k) => !k.speedReached || !k.accuracyReached);
  return (
    <div className="keys-next" data-testid="keys-next-key">
      {next.letter == null ? (
        <p className="small">All 26 keys are open; every key is now judged against your goal of {next.targetCpm} CPM.</p>
      ) : blockers.length === 0 ? (
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
              an average speed (the best it has reached) of at least <b>{next.targetCpm} CPM</b>, and
            </li>
            <li>
              at most <b>{pct(limit)}</b> wrong presses.
            </li>
          </ul>
          <p className="small">
            <b>Still to do:</b>
          </p>
          <ul className="small keys-waiting" data-testid="keys-waiting">
            {blockers.map((k) => {
              const parts = [
                !k.speedReached ? `speed: average ${k.bestCpm ?? "—"} (best so far) of ${next.targetCpm} CPM` : null,
                !k.accuracyReached ? `accuracy: ${k.errorRate == null ? "—" : pct(k.errorRate)} wrong, limit ${pct(limit)}` : null,
              ].filter(Boolean);
              const est =
                k.lessonsLeft != null
                  ? `about ${lessonsText(k.lessonsLeft)} at this pace`
                  : !k.accuracyReached && k.cleanLessonsLeft != null
                    ? `${lessonsText(k.cleanLessonsLeft)} without mistakes on it would be enough`
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
              <th rowSpan={2}>Status</th>
            </tr>
            <tr>
              <th title="the key's speed averaged over lessons (recent lessons weigh more); the table judges the best that average ever reached, not the fastest single lesson">
                Average speed, best
                <br />
                <span className="muted">needs ≥ {next.targetCpm} CPM</span>
              </th>
              <th title="average share of wrong presses when this key was the one to type; the line under it is what is compared with the limit">
                Wrong, average
                <br />
                <span className="muted">limit {pct(limit)}</span>
              </th>
              <th>Speed</th>
              <th>Wrong</th>
            </tr>
          </thead>
          <tbody>
            {next.keys.map((k) => {
              const l = k.lesson;
              const reached = k.speedReached && k.accuracyReached;
              const lessonRate = l && l.hits + l.misses > 0 ? l.misses / (l.hits + l.misses) : null;
              const what = !k.speedReached && !k.accuracyReached ? "Needs speed and accuracy" : !k.speedReached ? "Needs speed" : "Needs accuracy";
              const clean = !k.accuracyReached && k.cleanLessonsLeft != null ? `${lessonsText(k.cleanLessonsLeft)} if no mistakes on it` : null;
              const left =
                k.lessonsLeft != null
                  ? `~${lessonsText(k.lessonsLeft)}${clean ? ` (${clean})` : ""}`
                  : clean ?? (k.lessons < MIN_ESTIMATE_LESSONS ? `estimate after ${MIN_ESTIMATE_LESSONS} lessons (${k.lessons} so far)` : "no estimate: the speed is not rising");
              return (
                <tr key={k.letter} className={reached ? "keys-row-ok" : "keys-row-blocked"}>
                  <td>
                    <b className="keys-focus-letter">{k.letter}</b>
                  </td>
                  <td className={k.speedReached ? "ok" : "bad"}>
                    {k.bestCpm ?? "—"}
                    {k.cpm != null && <span className="keys-sub">average now {k.cpm}</span>}
                    <ProgressBar value={k.speedProgress} mini label={`Key ${k.letter} speed`} />
                  </td>
                  <td className={k.accuracyReached ? "ok" : "bad"}>
                    {k.errorRate == null ? "—" : pct(k.errorRate)}
                    {k.errorBound != null && <span className="keys-sub">surely at least {pct(k.errorBound)}</span>}
                    <ProgressBar value={k.accuracyProgress} mini label={`Key ${k.letter} accuracy`} />
                  </td>
                  <td>{l?.cpm != null ? `${l.cpm} CPM` : "—"}</td>
                  <td className={lessonRate != null && lessonRate > limit + 1e-9 ? "bad" : ""}>
                    {l ? `${l.misses} of ${l.hits + l.misses}${lessonRate != null ? ` (${pct(lessonRate)})` : ""}` : "not in the text"}
                  </td>
                  <td className={reached ? "ok" : "bad"}>
                    <b>{reached ? "✓ Reached" : what}</b>
                    {!reached && <span className="keys-sub">{left}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        A key passes when its average speed reaches the target (the best that average ever reached; one fast lesson moves it only a little: a tenth after the first 10 lessons with the key, 1/n before) and its wrong presses are surely not above the limit. A key meets only 10–40 times in a lesson, so the
        “surely at least” figure (the average minus a margin for chance) is what is compared with {pct(limit)}: a couple of unlucky presses do not hold a key back. The “This
        lesson only” columns are not judged; they show where today was worse. There is no minimum number of lessons per key: the next letter opens as soon as every open key
        passes.
      </p>
    </div>
  );
}

export function KeysResultView({ result, tokens, onNext, onDone }: { result: TypingKeysResult; tokens: TypingKeyToken[]; onNext: () => void; onDone: () => void }) {
  useEnterContinue(onNext);
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
    <div className="card typing-result">
      <h3>Key Builder — Complete</h3>
      <p className="muted small">Lesson {String(result.lessonNumber).padStart(2, "0")} · {open} of 26 keys open{focus ? ` · next focus ${focus.toUpperCase()}` : ""} · target {result.targetCpm} CPM · goal {Math.round(result.goalCpm / 5)} WPM</p>
      <div className="stat-grid" style={{ gridTemplateColumns: `repeat(${Math.ceil(stats.length / 2)}, minmax(0, 1fr))` }}>
        {stats.map((st) => <Stat key={st.label} label={st.label} value={st.value} tip={st.tip} />)}
      </div>
      {diff != null && <p className={`small typing-compare ${diff >= 0 ? "faster" : "slower"}`}>{diff >= 0 ? `+${diff}` : diff} CPM against the previous lesson</p>}
      {result.newKeys.length > 0 && <p className="small typing-compare faster" data-testid="keys-new">New key: {result.newKeys.map((k) => k.toUpperCase()).join(", ")} — every open key reached the stage target with enough accuracy; the new stage target is {result.targetCpm} CPM.</p>}
      {g && <p className="small">{g.lessonsToGoal === 0 ? "Goal reached by your recent lessons." : g.lessonsToGoal != null ? `At this pace: about ${g.lessonsToGoal} lessons (${g.hoursToGoal} h of typing) to ${Math.round(result.goalCpm / 5)} WPM.` : "No upward trend yet in the recent lessons."}</p>}
      <GoalBars result={result} />
      <KeyChips keys={result.keys} targetCpm={result.targetCpm} />
      <NextKeyPanel next={result.nextKey} />
      {words.length > 0 && (
        <details>
          <summary>Words from your word bank ({words.length})</summary>
          <ul className="typing-word-list">
            {words.map((w) => <li key={w.text}><strong>{w.text}</strong><span className="muted"> — {firstTranslation(w.translationRu)}</span></li>)}
          </ul>
        </details>
      )}
      <div className="actions">
        <button className="btn btn-primary" onClick={onNext} data-testid="keys-next" autoFocus>Next lesson</button>
        <button className="btn" onClick={onDone} data-testid="typing-done">Back to Typing</button>
      </div>
    </div>
  );
}
