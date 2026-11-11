import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { TypingDrillsStartResponse, TypingResult } from "../api";
import { TypingKeyboard } from "../components/TypingKeyboard";
import { checkDailyGoal } from "../components/DailyGoalNotice";
import { HOTKEYS } from "../components/hotkeys";
import { createDrillsEngine, LOW_LIVES, exportDrillKeyStats, exportDrillWords, revealDrillTranslation, type DrillsConfig, type DrillsEngineState, type DrillsEvent } from "../game/drillsEngine";
import { DrillsScene } from "../game/drillsScene";
import { playPracticeSound } from "../practiceSounds";
import { useTypingActivity } from "../typingActivity";
import { LAYOUT_HINT, Toast, useToast } from "./typingShared";

/**
 * A word is read aloud on its first showing and every seventh after it. The clips are fetched one at a time when the level starts, in the
 * order the words are first spoken: the stored word pronunciation of the word panel (ElevenLabs, each word made once), else Piper (which
 * says bare single words badly, so it is only the fallback). Without a clip the game goes on silently.
 */
function useDrillSpeech(plan: TypingDrillsStartResponse["words"], enabled: boolean): (lemma: string, stillWanted: () => boolean) => void {
  const clips = useRef(new Map<string, Promise<string | null>>());
  const playing = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const map = clips.current;
    const urls: string[] = [];
    const lemmas = enabled ? [...new Set(plan.filter((w) => w.speak).map((w) => w.lemma))] : [];
    void (async () => {
      for (const lemma of lemmas) {
        if (cancelled) return;
        const clip = api.vocabularyTextSpeech(lemma)
          .then((blob) => blob ?? api.fetchDrillSpeech(lemma))
          .catch(() => api.fetchDrillSpeech(lemma))
          .then((blob) => {
            if (cancelled) return null;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            return url;
          })
          .catch(() => null);
        map.set(lemma, clip);
        await clip;
      }
    })();
    return () => {
      cancelled = true;
      playing.current?.pause();
      for (const u of urls) URL.revokeObjectURL(u);
      map.clear();
    };
  }, [plan, enabled]);
  return useCallback((lemma: string, stillWanted: () => boolean) => {
    void clips.current.get(lemma)?.then((url) => {
      // a clip that comes too late would sound over a later word: skip it this time
      if (!url || !stillWanted()) return;
      playing.current?.pause();
      const audio = new Audio(url);
      playing.current = audio;
      void audio.play().catch(() => {});
    });
  }, []);
}

export function DrillsGame({ plan, onResult, onExit }: { plan: TypingDrillsStartResponse; onResult: (result: TypingResult) => void; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<DrillsScene | null>(null);
  const configRef = useRef<DrillsConfig>({ plan: plan.words, lives: plan.lives });
  const engineRef = useRef<DrillsEngineState | null>(null);
  if (!engineRef.current) engineRef.current = createDrillsEngine(configRef.current);
  const flushActivity = useTypingActivity(plan.sessionId, "words", () => engineRef.current?.activeMs ?? 0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [hud, setHud] = useState({ done: 0, lives: plan.lives, wpm: null as number | null, next: plan.words[0]?.lemma[0] ?? null as string | null });
  const [layoutNotice, showLayoutNotice] = useToast();
  const finishing = useRef(false);
  const [speechOn, setSpeechOn] = useState(false);
  const speak = useDrillSpeech(plan.words, speechOn);
  const soundsRef = useRef(true);
  useEffect(() => {
    let active = true;
    void api.fetchSettings().then((s) => {
      if (!active) return;
      soundsRef.current = s.values.typingSoundsEnabled ?? true;
      setSpeechOn(s.values.typingDrillSpeech ?? false);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const finish = useCallback((status: "completed" | "failed") => {
    if (finishing.current) return;
    finishing.current = true;
    const e = engineRef.current!;
    flushActivity();
    void api.completeTypingDrills(plan.sessionId, {
      status,
      activeMs: Math.round(e.activeMs),
      charsTyped: e.charsTyped,
      errors: e.errors,
      words: exportDrillWords(e),
      keyStats: exportDrillKeyStats(e),
      bestCombo: e.bestStreak,
      bestCharStreak: e.bestCharStreak,
    }).then((result) => {
      checkDailyGoal("words");
      api.announceXp();
      onResult(result);
    }).catch(() => onExit());
  }, [plan.sessionId, flushActivity, onResult, onExit]);

  const onEvents = useCallback((events: DrillsEvent[]) => {
    const sound = (kind: Parameters<typeof playPracticeSound>[0]) => playPracticeSound(kind, soundsRef.current);
    for (const ev of events) {
      if (ev.type === "miss") sound("incorrect");
      else if (ev.type === "done") {
        sound("explode");
        // the next word is read aloud as it becomes the word to type, while it still is
        const next = plan.words[ev.word.planIndex + 1];
        if (next?.speak && speechOn) window.setTimeout(() => speak(next.lemma, () => engineRef.current?.current === next.planIndex && (engineRef.current.words[next.planIndex]?.progress ?? 0) < next.lemma.length), 150);
      } else if (ev.type === "won") {
        window.setTimeout(() => sound("complete"), 300);
        window.setTimeout(() => finish("completed"), 900);
      } else if (ev.type === "failed") {
        sound("fail");
        window.setTimeout(() => finish("failed"), 900);
      }
    }
  }, [finish, speak, speechOn, plan.words]);

  // the first word is read as soon as its clip is ready, while it is still being typed
  useEffect(() => {
    const first = plan.words[0];
    if (speechOn && first?.speak) speak(first.lemma, () => engineRef.current?.current === 0);
  }, [speechOn, speak, plan.words]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new DrillsScene(canvas, { config: configRef.current, engine: engineRef.current!, level: plan.level, onEvents, paused: () => pausedRef.current });
    sceneRef.current = scene;
    scene.start();
    const onResize = () => scene.resize();
    window.addEventListener("resize", onResize);
    return () => { scene.stop(); window.removeEventListener("resize", onResize); };
  }, [plan.level, onEvents]);

  const togglePause = useCallback(() => setPaused((p) => { pausedRef.current = !p; return !p; }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.getModifierState("AltGraph") || e.isComposing) return;
      if (e.key === "Escape" || e.key === HOTKEYS.pause) { e.preventDefault(); if (!e.repeat) togglePause(); return; }
      if (e.key === HOTKEYS.translate) { e.preventDefault(); if (!e.repeat && !pausedRef.current && engineRef.current) revealDrillTranslation(engineRef.current); return; }
      if (e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); return; } // a wrong key is never accepted: nothing to delete
      if (e.key.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (/[Ѐ-ӿ]/.test(e.key)) { showLayoutNotice(); return; } // Russian layout: not an error
      sceneRef.current?.key(e.key);
    };
    const onBlur = () => { pausedRef.current = true; setPaused(true); };
    const onHide = () => { if (document.visibilityState === "hidden") onBlur(); };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHide);
    return () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onHide); };
  }, [togglePause, showLayoutNotice]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const w = e.words[e.current];
      const next = w ? (w.progress < w.lemma.length ? w.lemma[w.progress]! : " ") : null;
      const correct = e.charsTyped - e.errors;
      const wpm = e.activeMs >= 4000 ? Math.round(correct / 5 / (e.activeMs / 60000)) : null;
      setHud((h) => (h.done === e.current && h.lives === e.lives && h.wpm === wpm && h.next === next ? h : { done: e.current, lives: e.lives, wpm, next }));
    }, 80);
    return () => window.clearInterval(id);
  }, []);

  const abort = () => {
    const e = engineRef.current!;
    flushActivity();
    void api.abortTypingWords(plan.sessionId, { activeMs: Math.round(e.activeMs), charsTyped: e.charsTyped, errors: e.errors });
    onExit();
  };

  const total = plan.words.length;
  const percent = total > 0 ? (hud.done / total) * 100 : 0;
  return (
    <div className="typing-game" data-no-word style={{ userSelect: "none" }}>
      <div className="typing-game-bar">
        <span>Finger Drills · Level {String(plan.level).padStart(2, "0")}</span>
        <span className="muted small" title={`Open keys: ${plan.stageKeys}`}>Stage {plan.stage} · {plan.learned} learned</span>
        <span className="muted small typing-live">Speed: {hud.wpm === null ? "—" : hud.wpm} WPM</span>
        <span className={`drills-lives${hud.lives <= LOW_LIVES ? " low" : ""}`} aria-label={`${hud.lives} of ${plan.lives} lives left`} title="Every wrong key costs one life; the level ends when none are left. The number of lives comes from your recent accuracy and the length of the level.">
          <i className="pi pi-heart-fill" aria-hidden="true" /> {hud.lives} / {plan.lives}
        </span>
        <span className="actions">
          <button className="btn" onClick={togglePause} title="F2">{paused ? "Resume" : "Pause"} (F2)</button>
          <button className="btn" onClick={abort}>Exit</button>
        </span>
      </div>
      <div className="typing-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Words typed">
        <div className="typing-progress-fill" style={{ width: `${percent}%` }} />
        <span className="typing-progress-label">{hud.done} / {total} words</span>
      </div>
      <div className="typing-stage">
        <canvas ref={canvasRef} className="typing-canvas" aria-label="Finger Drills typing game" />
        {paused && <div className="typing-paused" role="status">Paused — press Resume, F2 or Esc to continue.</div>}
        {!paused && hud.lives > 0 && hud.lives <= LOW_LIVES && <div className="drills-low-lives" role="alert">{hud.lives === 1 ? "Last life! The next wrong key ends the level." : `Only ${hud.lives} lives left — slow down and type carefully.`}</div>}
        {layoutNotice && <Toast text={LAYOUT_HINT} />}
      </div>
      <p className="muted small">Type each word and press Space after it. Nothing hurries you: take your time. A wrong key is not accepted and costs one life — just type the right one. F3 shows the translation of the current word.</p>
      <TypingKeyboard next={paused ? null : hud.next} />
    </div>
  );
}
