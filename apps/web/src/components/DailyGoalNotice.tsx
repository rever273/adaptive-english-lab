import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { playPracticeSound } from "../practiceSounds";

const EVENT = "englishlab:daily-goal-check";
const labels: Record<api.JourneyMode, string> = {
  grammar: "Grammar", vocabulary: "Vocabulary", wordLesson: "One Word", contextLoop: "Context Loop", vocabTyping: "Typing Vocabulary", grammarCloze: "Grammar Cloze", words: "Typing Words", books: "Typing Books", dictation: "Audio Dictation", conversation: "Conversation",
};
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
type Notice = { key: string; mode: api.JourneyMode; actualMs: number; targetMs: number };
const SHOWN_KEY = "el_daily_goal_notices_v1";
function previouslyShown(day: string, mode: api.JourneyMode): boolean {
  try { const stored = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "null") as { day?: unknown; modes?: unknown } | null; return stored?.day === day && Array.isArray(stored.modes) && stored.modes.includes(mode); }
  catch { return false; }
}
function rememberShown(day: string, mode: api.JourneyMode): void {
  try {
    const stored = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "null") as { day?: unknown; modes?: unknown } | null;
    const modes = stored?.day === day && Array.isArray(stored.modes) ? stored.modes.filter((v): v is string => typeof v === "string") : [];
    localStorage.setItem(SHOWN_KEY, JSON.stringify({ day, modes: [...new Set([...modes, mode])] }));
  } catch { /* In-memory deduplication still works when storage is unavailable. */ }
}

export function checkDailyGoal(mode: api.JourneyMode): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

export function DailyGoalCheck({ mode, trigger }: { mode: api.JourneyMode; trigger?: unknown }) {
  useEffect(() => { checkDailyGoal(mode); }, [mode, trigger]);
  return null;
}

/** A result arms the check until the recorded activity reaches the target, even after navigating away. */
export function DailyGoalNotice() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const message = notices[0];
  const dismiss = () => setNotices(current => current.slice(1));
  const shown = useRef(new Set<string>());
  // a unique chime when the notice appears; typing modes follow the typing sound setting, the others the practice one
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!message || announced.current === message.key) return;
    announced.current = message.key;
    void api.fetchSettings().then((s) => {
      const typing = message.mode === "words" || message.mode === "books" || message.mode === "dictation";
      playPracticeSound("goal", (typing ? s.values.typingSoundsEnabled : s.values.practiceSoundsEnabled) ?? true);
    }).catch(() => playPracticeSound("goal", true));
  }, [message]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setNotices(current => current.slice(1)), 9000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    let active = true;
    let checking = false;
    let initialized = false;
    const pending = new Set<api.JourneyMode>();
    const check = async () => {
      if (checking || (initialized && pending.size === 0)) return;
      checking = true;
      try {
        const data = await api.fetchJourney();
        if (!active) return;
        // A goal already reached before this page opened is not a new achievement.
        // This also seeds old installations where no notification marker was saved.
        if (!initialized) {
          initialized = true;
          for (const mode of Object.keys(data.dailyMinutes) as api.JourneyMode[]) {
            if (data.dailyMinutes[mode] > 0 && data.todayMs[mode] >= data.dailyMinutes[mode] * 60000) {
              shown.current.add(`${data.today}:${mode}`);
              rememberShown(data.today, mode);
            }
          }
        }
        for (const mode of pending) {
          const key = `${data.today}:${mode}`;
          if (shown.current.has(key) || previouslyShown(data.today, mode) || data.dailyMinutes[mode] <= 0) { pending.delete(mode); continue; }
          if (data.todayMs[mode] >= data.dailyMinutes[mode] * 60000) {
            shown.current.add(key);
            rememberShown(data.today, mode);
            pending.delete(mode);
            setNotices(current => [...current, { key, mode, actualMs: data.todayMs[mode], targetMs: data.dailyMinutes[mode] * 60000 }]);
          }
        }
      } catch { /* Retry when the server is available. */ }
      finally { checking = false; }
    };
    const onCheck = (event: Event) => {
      pending.add((event as CustomEvent<api.JourneyMode>).detail);
      void check();
    };
    window.addEventListener(EVENT, onCheck);
    void check();
    const timer = window.setInterval(() => { if (!document.hidden) void check(); }, 3000);
    return () => { active = false; window.removeEventListener(EVENT, onCheck); window.clearInterval(timer); };
  }, []);
  return message ? <div role="status"><button type="button" className="daily-goal-notice" onClick={dismiss} aria-label={`${labels[message.mode]} daily goal completed. ${duration(message.actualMs)} of ${duration(message.targetMs)} today. Dismiss notification.`}><i className="pi pi-check-circle" aria-hidden="true" /><span><strong>{labels[message.mode]}: daily goal completed!</strong><small>{duration(message.actualMs)} / {duration(message.targetMs)} today · Click to dismiss</small></span><i className="pi pi-times daily-goal-close" aria-hidden="true" /></button></div> : null;
}
