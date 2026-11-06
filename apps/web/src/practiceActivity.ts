import { useEffect } from "react";
import * as api from "./api";

type Interval = { sessionId: string; id: string; tabId: string; startMs: number; endMs: number };
const KEY = "el_practice_activity_v1";
export const IDLE_MS = 120_000;
/** Do not infer elapsed practice across a suspended timer, clock change, hidden tab or idle gap. */
export function activeInterval(lastWall: number, now: number, monotonicElapsed: number, lastInteraction: number, visible: boolean): { startMs: number; endMs: number } | null {
  const elapsed = now - lastWall;
  const endMs = Math.min(now, lastInteraction + IDLE_MS);
  return visible && elapsed > 0 && elapsed <= 10_000 && Math.abs(elapsed - monotonicElapsed) < 2000 && endMs > lastWall ? { startMs: lastWall, endMs } : null;
}
let sending = false;
function read(): Interval[] { try { const v: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v as Interval[] : []; } catch { return []; } }
function write(items: Interval[]) { try { sessionStorage.setItem(KEY, JSON.stringify(items)); } catch { /* time may be lost if storage is unavailable */ } }
async function drain() {
  if (sending) return; sending = true;
  try {
    for (;;) {
      const item = read()[0]; if (!item) break;
      try { await api.recordPracticeActivity(item.sessionId, item); }
      catch (e) {
        if (!(e instanceof api.ApiRequestError) || e.status === 0 || e.status >= 500 || e.status === 403) break;
        // A conflicting or no-longer-owned interval must never block later intervals.
      }
      write(read().filter(x => x.id !== item.id));
    }
  } finally { sending = false; }
}
/** Visible exercise/feedback time until two minutes without learner interaction. */
export function usePracticeActivity(sessionId: string | null, tabId: string, enabled: boolean): void {
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let lastWall = Date.now(); let lastMono = performance.now(); let lastInteraction = lastWall; let visible = !document.hidden;
    const tick = () => {
      const now = Date.now(), mono = performance.now();
      const interval = activeInterval(lastWall, now, mono - lastMono, lastInteraction, visible);
      if (interval) {
        const item = { sessionId, id: crypto.randomUUID(), tabId, ...interval };
        write([...read(), item]); void drain();
      }
      lastWall = now; lastMono = mono;
    };
    const activity = () => { if (Date.now() > lastInteraction + IDLE_MS) tick(); lastInteraction = Date.now(); };
    const visibility = () => { tick(); visible = !document.hidden; lastInteraction = Date.now(); };
    const timer = window.setInterval(tick, 5000);
    for (const event of ["keydown", "pointerdown", "wheel", "touchstart"] as const) window.addEventListener(event, activity, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    const pagehide = () => {
      tick();
      for (const item of read()) void api.sendKeepalive(`/api/v1/sessions/${encodeURIComponent(item.sessionId)}/activity`, { id: item.id, tabId: item.tabId, startMs: item.startMs, endMs: item.endMs });
    };
    window.addEventListener("pagehide", pagehide);
    void drain();
    return () => { tick(); window.clearInterval(timer); for (const event of ["keydown", "pointerdown", "wheel", "touchstart"] as const) window.removeEventListener(event, activity); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide); };
  }, [sessionId, tabId, enabled]);
}
