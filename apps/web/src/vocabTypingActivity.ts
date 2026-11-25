import { useEffect } from "react";
import * as api from "./api";
import { IDLE_MS, activeInterval } from "./practiceActivity";

type Interval = { runId: string; id: string; tabId: string; startMs: number; endMs: number };
const KEY = "el_vocab_typing_activity_v1";
let sending = false;
function read(): Interval[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v as Interval[]) : [];
  } catch {
    return [];
  }
}
function write(items: Interval[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* time may be lost if storage is unavailable */
  }
}
async function drain() {
  if (sending) return;
  sending = true;
  try {
    for (;;) {
      const item = read()[0];
      if (!item) break;
      try {
        await api.recordVocabActivity(item.runId, { id: item.id, tabId: item.tabId, startMs: item.startMs, endMs: item.endMs }); // only these four: the server refuses anything else (400)
      } catch (e) {
        if (!(e instanceof api.ApiRequestError) || e.status === 0 || e.status >= 500 || e.status === 403) break;
        // an interval the server refuses (overlap, a closed run) must never block the ones after it
      }
      write(read().filter((x) => x.id !== item.id));
    }
  } finally {
    sending = false;
  }
}

/** Vocabulary Typing (TASK_038, D171): visible session time until two minutes without interaction: the same rule as practice time (`usePracticeActivity`), recorded for the Journey and the daily plan. */
export function useVocabTypingActivity(runId: string | null, tabId: string, enabled: boolean): void {
  useEffect(() => {
    if (!runId || !enabled) return;
    let lastWall = Date.now();
    let lastMono = performance.now();
    let lastInteraction = lastWall;
    let visible = !document.hidden;
    const tick = () => {
      const now = Date.now();
      const mono = performance.now();
      const interval = activeInterval(lastWall, now, mono - lastMono, lastInteraction, visible);
      if (interval) {
        write([...read(), { runId, id: crypto.randomUUID(), tabId, ...interval }]);
        void drain();
      }
      lastWall = now;
      lastMono = mono;
    };
    const activity = () => {
      if (Date.now() > lastInteraction + IDLE_MS) tick();
      lastInteraction = Date.now();
    };
    const visibility = () => {
      tick();
      visible = !document.hidden;
      lastInteraction = Date.now();
    };
    const timer = window.setInterval(tick, 5000);
    const events = ["keydown", "pointerdown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, activity, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    const pagehide = () => {
      tick();
      for (const item of read()) void api.sendKeepalive(`/api/v1/typing/vocab/sessions/${encodeURIComponent(item.runId)}/activity`, { id: item.id, tabId: item.tabId, startMs: item.startMs, endMs: item.endMs });
    };
    window.addEventListener("pagehide", pagehide);
    void drain();
    return () => {
      tick();
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, activity);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [runId, tabId, enabled]);
}
