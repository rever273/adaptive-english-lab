import type { Db } from "../../db/open.js";

/** Periods select conversations by start date; aggregate counters survive text deletion. */
export function conversationAnalytics(db: Db, days: "7" | "30" | "90" | "all", now = Date.now()) {
  const cutoff = days === "all" ? "" : new Date(now - Number(days) * 86400000).toISOString();
  const sessions = db.prepare("SELECT id,topic,started_at AS startedAt,updated_at AS updatedAt,active_ms AS activeMs,answer_count AS answers,history_deleted AS historyDeleted FROM conversation_sessions WHERE started_at >= ? ORDER BY started_at DESC,rowid DESC").all(cutoff) as Array<{id:string;topic:string;startedAt:string;updatedAt:string;activeMs:number;answers:number;historyDeleted:number}>;
  const messages = db.prepare("SELECT m.text,a.status,a.text AS analysis FROM conversation_messages m LEFT JOIN conversation_analyses a ON a.message_id=m.id WHERE m.session_id=? AND m.role='user'");
  let sentences = 0, good = 0, suggestions = 0, unclassified = 0, availableAnswers = 0;
  const series: Array<{startedAt:string;answers:number;activeMs:number;good:number;suggestions:number}> = [];
  for (const s of sessions) {
    let sessionGood = 0, sessionSuggestions = 0;
    for (const m of messages.all(s.id) as Array<{text:string;status:string|null;analysis:string|null}>) {
    availableAnswers++;
    sentences += m.text.split(/[.!?]+(?:\s+|$)|\n+/u).filter(x => x.trim()).length;
    let verdict: boolean | null = null;
    if (m.status === "ready" && m.analysis) try { const a = JSON.parse(m.analysis) as {version?:unknown;ok?:unknown}; if (a.version === "conversation-feedback-v2" && typeof a.ok === "boolean") verdict = a.ok; } catch { /* legacy text has no reliable structured verdict */ }
    if (verdict === true) { good++; sessionGood++; } else if (verdict === false) { suggestions++; sessionSuggestions++; } else unclassified++;
    }
    series.push({startedAt:s.startedAt,answers:s.answers,activeMs:s.activeMs,good:sessionGood,suggestions:sessionSuggestions});
  }
  return { conversations:sessions.length, answers:sessions.reduce((n,s) => n+s.answers,0), activeMs:sessions.reduce((n,s) => n+s.activeMs,0), sentences, availableAnswers, good, suggestions, unclassified, deletedSessions:sessions.filter(s => s.historyDeleted).length, series:series.reverse(), sessions:sessions.slice(0,20).map(({id: _id,...s}) => s) };
}
