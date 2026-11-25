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

/**
 * conversation-insights-v1: what the retained answers show, per conversation in time order. Counted by code from the text (words, variety,
 * time to answer, saved words used) plus the tentative local-model figures stored with each answer (level ok/tip/error, issue type, and from
 * analysis v3 an estimated CEFR level). None of it is a grade or feeds Mastery; deleted text simply drops out.
 */
export const CONVERSATION_INSIGHTS_VERSION = "conversation-insights-v1";
const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
const ISSUES = ["grammar", "vocabulary", "spelling", "word_order", "naturalness"] as const;
/** a reply after this long is a pause, not thinking time */
const REPLY_CAP_MS = 10 * 60_000;
const wordsOf = (t: string) => t.toLowerCase().match(/[a-z]+(?:['’-][a-z]+)*/g) ?? [];
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function conversationInsights(db: Db, days: "7" | "30" | "90" | "all", now = Date.now()) {
  const cutoff = days === "all" ? "" : new Date(now - Number(days) * 86400000).toISOString();
  const sessions = db.prepare("SELECT id, topic, started_at AS startedAt FROM conversation_sessions WHERE started_at >= ? AND history_deleted = 0 ORDER BY started_at, rowid").all(cutoff) as Array<{ id: string; topic: string; startedAt: string }>;
  const msgs = db.prepare("SELECT m.role, m.text, m.created_at AS at, a.status, a.text AS analysis FROM conversation_messages m LEFT JOIN conversation_analyses a ON a.message_id = m.id WHERE m.session_id = ? ORDER BY m.rowid");
  const saved = (db.prepare("SELECT lemma FROM vocabulary_entries").all() as Array<{ lemma: string }>).map((r) => r.lemma.toLowerCase().trim()).filter(Boolean);
  const escape = (l: string) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const savedRe = saved.map((l) => ({ l, re: new RegExp(`(?<![a-z])${escape(l)}(?:s|es|ed|d|ing)?(?![a-z])`, "i") }));
  const skillLabel = new Map((db.prepare("SELECT sr.skill_id AS id, sr.label_en AS label FROM skill_revisions sr WHERE sr.active = 1").all() as Array<{ id: string; label: string }>).map((r) => [r.id, r.id.includes(".") ? `${r.id.split(".")[0]!.replace(/_/g, " ")}: ${r.label}` : r.label]));

  const allWords = new Set<string>();
  const usedSaved = new Set<string>();
  const levels = { ok: 0, tip: 0, error: 0 };
  const issues = Object.fromEntries(ISSUES.map((k) => [k, 0])) as Record<(typeof ISSUES)[number], number>;
  const cefrCounts = Object.fromEntries(CEFR.map((k) => [k, 0])) as Record<(typeof CEFR)[number], number>;
  const skills = new Map<string, number>();
  let totalWords = 0;
  let answers = 0;
  let longest = 0;
  const per = sessions.map((s) => {
    const rows = msgs.all(s.id) as Array<{ role: "user" | "assistant"; text: string; at: string; status: string | null; analysis: string | null }>;
    let lastAssistant: number | null = null;
    const lens: number[] = [];
    const replies: number[] = [];
    const cefrs: number[] = [];
    const lv = { ok: 0, tip: 0, error: 0 };
    const words = new Set<string>();
    const savedHere = new Set<string>();
    for (const m of rows) {
      if (m.role === "assistant") {
        lastAssistant = Date.parse(m.at);
        continue;
      }
      const w = wordsOf(m.text);
      lens.push(w.length);
      longest = Math.max(longest, w.length);
      totalWords += w.length;
      answers++;
      for (const x of w) {
        words.add(x);
        allWords.add(x);
      }
      for (const { l, re } of savedRe) if (re.test(m.text)) {
        savedHere.add(l);
        usedSaved.add(l);
      }
      if (lastAssistant !== null) {
        const d = Date.parse(m.at) - lastAssistant;
        if (d > 0 && d <= REPLY_CAP_MS) replies.push(d);
      }
      if (m.status !== "ready" || !m.analysis) continue;
      try {
        const a = JSON.parse(m.analysis) as { version?: string; ok?: boolean; level?: string; cefr?: string | null; issueType?: string; grammarSkillId?: string | null };
        if (a.version !== "conversation-feedback-v2" || typeof a.ok !== "boolean") continue;
        const level = a.ok ? "ok" : a.level === "tip" ? "tip" : "error";
        lv[level]++;
        levels[level]++;
        const issue = !a.ok ? (a.issueType && (ISSUES as readonly string[]).includes(a.issueType) ? a.issueType : level === "tip" ? "naturalness" : "grammar") : null;
        if (issue) issues[issue as (typeof ISSUES)[number]]++;
        if (a.cefr && (CEFR as readonly string[]).includes(a.cefr)) {
          cefrs.push(CEFR.indexOf(a.cefr as (typeof CEFR)[number]) + 1);
          cefrCounts[a.cefr as (typeof CEFR)[number]]++;
        }
        if (a.grammarSkillId) skills.set(a.grammarSkillId, (skills.get(a.grammarSkillId) ?? 0) + 1);
      } catch {
        /* plain-text feedback of older versions has no figures */
      }
    }
    const sum = lens.reduce((a, b) => a + b, 0);
    return {
      startedAt: s.startedAt,
      topic: s.topic,
      answers: lens.length,
      wordsPerAnswer: lens.length ? sum / lens.length : null,
      longest: lens.length ? Math.max(...lens) : null,
      distinctWords: words.size,
      savedWordsUsed: savedHere.size,
      replyMedianMs: median(replies),
      cefr: median(cefrs),
      levels: lv,
    };
  });
  return {
    version: CONVERSATION_INSIGHTS_VERSION,
    answers,
    totalWords,
    distinctWords: allWords.size,
    wordsPerAnswer: answers ? totalWords / answers : null,
    longest,
    savedWordsUsed: usedSaved.size,
    savedWords: saved.length,
    levels,
    issues,
    cefr: cefrCounts,
    skills: [...skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => ({ id, label: skillLabel.get(id) ?? id, count: n })),
    perConversation: per.filter((p) => p.answers > 0),
  };
}
