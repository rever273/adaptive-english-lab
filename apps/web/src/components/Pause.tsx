import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_MS } from "../practiceActivity";
import { HOTKEYS, Kbd, useKeys } from "./hotkeys";

/** F2 pauses and resumes (Esc also resumes), like the Typing games. While paused the screen is covered and no practice time is counted. */
export function usePauseKeys(paused: boolean, setPaused: (p: boolean) => void, enabled = true): void {
  useKeys((e) => {
    if (!enabled || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === HOTKEYS.pause) { e.preventDefault(); setPaused(!paused); }
    else if (e.key === "Escape" && paused) { e.preventDefault(); setPaused(false); }
  });
}

export type AutoPauseReason = "hidden" | "idle";

/**
 * Pauses by itself when the tab is hidden or there has been no key, click, scroll or touch for two minutes (the same rule that stops the practice
 * clock). The caller turns its time recording off while a reason is set. Resuming is explicit: `resume()` (the overlay does it on any key or click).
 */
export function useAutoPause(enabled: boolean, idleMs = IDLE_MS): { reason: AutoPauseReason | null; resume: () => void } {
  const [reason, setReason] = useState<AutoPauseReason | null>(null);
  const last = useRef(Date.now());
  useEffect(() => {
    if (!enabled) { setReason(null); return; }
    last.current = Date.now();
    if (document.hidden) setReason("hidden");
    const touch = () => { last.current = Date.now(); };
    const hide = () => { if (document.hidden) setReason("hidden"); };
    const timer = window.setInterval(() => { if (Date.now() - last.current > idleMs) setReason((r) => r ?? "idle"); }, 5000);
    const events = ["keydown", "pointerdown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, touch);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [enabled, idleMs]);
  const resume = useCallback(() => { last.current = Date.now(); setReason(null); }, []);
  return { reason: enabled ? reason : null, resume };
}

export function PauseButton({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="btn btn-small has-kbd" onClick={onToggle} title={`Pause: practice time stops counting (${HOTKEYS.pause})`} data-testid="pause-toggle">
      <Kbd k={HOTKEYS.pause} /><i className={`pi ${paused ? "pi-play" : "pi-pause"}`} aria-hidden="true" /> {paused ? "Resume" : "Pause"}
    </button>
  );
}

const WHY: Record<AutoPauseReason, string> = {
  hidden: "This tab was in the background, so practice paused.",
  idle: "There was no activity for 2 minutes, so practice paused.",
};

/**
 * Covers the practice screen while paused, so nothing can be answered or read by accident. An automatic pause (tab hidden / idle) swallows the
 * first key or click and resumes with it, so that key never answers a task by mistake.
 */
export function PauseOverlay({ onResume, auto }: { onResume: () => void; auto?: AutoPauseReason | null }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    if (!auto) return;
    const take = (e: Event) => { e.preventDefault(); e.stopPropagation(); onResume(); };
    window.addEventListener("keydown", take, true);
    window.addEventListener("pointerdown", take, true);
    return () => { window.removeEventListener("keydown", take, true); window.removeEventListener("pointerdown", take, true); };
  }, [auto, onResume]);
  return (
    <div className="pause-overlay" role="dialog" aria-modal="true" aria-label="Paused" data-testid="pause-overlay">
      <div className="pause-box">
        <h2><i className="pi pi-pause" aria-hidden="true" /> Paused</h2>
        <p className="muted">{auto ? WHY[auto] : "Your practice time is not counted while you are paused."}</p>
        <p className="muted small">Time is not counted while paused.</p>
        <button ref={ref} type="button" className="btn btn-primary" onClick={onResume}>{auto ? "Press any key or click to continue" : `Resume (${HOTKEYS.pause} or Esc)`}</button>
      </div>
    </div>
  );
}
