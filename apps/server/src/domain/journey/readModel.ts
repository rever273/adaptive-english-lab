import type { Db } from "../../db/open.js";
import { loadSettings } from "../sessions/policy.js";
import { allocateDays, learningDate, DAILY_TIMEZONE } from "./calendar.js";

const modes = ["grammar", "vocabulary", "wordLesson", "grammarCloze", "words", "books", "dictation", "conversation"] as const;
type Mode = typeof modes[number];
const zero = () => Object.fromEntries(modes.map(m => [m, 0])) as Record<Mode, number>;

export function readPracticeActivity(db: Db) {
    const rows = db.prepare(`SELECT i.start_ms AS startMs, i.end_ms AS endMs, CASE WHEN v.session_id IS NULL THEN 'grammar' ELSE 'vocabulary' END AS mode FROM practice_activity_intervals i LEFT JOIN vocabulary_sessions v ON v.session_id=i.session_id ORDER BY i.start_ms`).all() as Array<{startMs:number;endMs:number;mode:'grammar'|'vocabulary'}>;
    const days = new Map<string, { date: string; grammar: number; vocabulary: number }>();
    for (const row of rows) for (const part of allocateDays(row.startMs, row.endMs, DAILY_TIMEZONE)) {
      const day = days.get(part.date) ?? { date: part.date, grammar: 0, vocabulary: 0 };
      day[row.mode] += part.ms; days.set(part.date, day);
    }
    const grammarResults = db.prepare(`SELECT t.local_date AS date,
      COUNT(DISTINCT CASE WHEN a.verdict='correct' THEN t.id END) AS correct,
      COUNT(DISTINCT t.id) AS scored, COUNT(DISTINCT sr.skill_id) AS skills
      FROM attempts t JOIN session_slots ss ON ss.id=t.slot_id
      LEFT JOIN vocabulary_sessions v ON v.session_id=ss.session_id
      JOIN assessment_revisions a ON a.attempt_id=t.id AND a.sequence=(SELECT MAX(ar.sequence) FROM assessment_revisions ar WHERE ar.attempt_id=t.id)
      LEFT JOIN skill_opportunities o ON o.assessment_id=a.id LEFT JOIN skill_revisions sr ON sr.id=o.skill_revision_id
      WHERE v.session_id IS NULL AND t.attempt_no=1 AND t.hints_before=0 AND t.answer_seen_before=0 AND t.idk=0
        AND COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) <> 1 AND a.confirmation='confirmed' AND a.verdict IN ('correct','incorrect')
      GROUP BY t.local_date ORDER BY t.local_date`).all();
    return { days: [...days.values()].sort((a,b) => a.date.localeCompare(b.date)), grammarResults };
}

export function readDailyTotals(db: Db) {
    const days = new Map<string, number>();
    for (const sql of [
      "SELECT start_ms AS startMs,end_ms AS endMs FROM practice_activity_intervals",
      "SELECT start_ms AS startMs,end_ms AS endMs FROM journey_typing_intervals",
      "SELECT start_ms AS startMs,end_ms AS endMs FROM word_lesson_activity_intervals",
      "SELECT start_ms AS startMs,end_ms AS endMs FROM grammar_cloze_activity_intervals",
      "SELECT start_ms AS startMs,end_ms AS endMs FROM conversation_activity_intervals",
    ]) for (const row of db.prepare(sql).all() as Array<{startMs:number;endMs:number}>) for (const part of allocateDays(row.startMs, row.endMs, DAILY_TIMEZONE)) days.set(part.date, (days.get(part.date) ?? 0) + part.ms);
    return { days: [...days].map(([date, ms]) => ({ date, ms })).sort((a, b) => a.date.localeCompare(b.date)) };
}

export function readJourney(db: Db) {
    const tz = DAILY_TIMEZONE;
    const today = learningDate(Date.now(), tz);
    const byDay: Record<string,Record<Mode,number>> = {}; const totals = zero();
    const cutoff = Date.now() - 9 * 86400000;
    const grammar = db.prepare(`SELECT i.start_ms AS startMs,i.end_ms AS endMs,CASE WHEN v.session_id IS NULL THEN 'grammar' ELSE 'vocabulary' END AS mode FROM practice_activity_intervals i LEFT JOIN vocabulary_sessions v ON v.session_id=i.session_id WHERE i.end_ms >= ?`).all(cutoff) as Array<{startMs:number;endMs:number;mode:Mode}>;
    const typing = [
      ...(db.prepare("SELECT start_ms AS startMs,end_ms AS endMs,mode FROM journey_typing_intervals WHERE end_ms >= ?").all(cutoff) as Array<{startMs:number;endMs:number;mode:Mode}>),
      // Single Word lessons keep their own measured intervals (they are not practice sessions)
      ...(db.prepare("SELECT start_ms AS startMs,end_ms AS endMs,'wordLesson' AS mode FROM word_lesson_activity_intervals WHERE end_ms >= ?").all(cutoff) as Array<{startMs:number;endMs:number;mode:Mode}>),
      ...(db.prepare("SELECT start_ms AS startMs,end_ms AS endMs,'grammarCloze' AS mode FROM grammar_cloze_activity_intervals WHERE end_ms >= ?").all(cutoff) as Array<{startMs:number;endMs:number;mode:Mode}>),
      ...(db.prepare("SELECT start_ms AS startMs,end_ms AS endMs,'conversation' AS mode FROM conversation_activity_intervals WHERE end_ms >= ?").all(cutoff) as Array<{startMs:number;endMs:number;mode:Mode}>),
    ];
    for (const row of [...grammar,...typing]) for (const part of allocateDays(row.startMs,row.endMs,tz)) { (byDay[part.date] ??= zero())[row.mode] += part.ms;  }
    for (const r of db.prepare(`SELECT CASE WHEN v.session_id IS NULL THEN 'grammar' ELSE 'vocabulary' END AS mode, SUM(i.end_ms-i.start_ms) AS ms FROM practice_activity_intervals i LEFT JOIN vocabulary_sessions v ON v.session_id=i.session_id GROUP BY mode`).all() as Array<{mode:'grammar'|'vocabulary';ms:number}>) totals[r.mode] = r.ms;
    for (const r of db.prepare("SELECT s.mode,COALESCE(SUM(CASE WHEN s.status='active' THEN MAX(s.active_ms,COALESCE((SELECT SUM(i.end_ms-i.start_ms) FROM journey_typing_intervals i WHERE i.session_id=s.id AND i.mode=s.mode),0)) ELSE s.active_ms END),0) AS ms FROM typing_sessions s GROUP BY s.mode").all() as Array<{mode:'words'|'books';ms:number}>) totals[r.mode] = r.ms;
    totals.wordLesson = (db.prepare("SELECT COALESCE(SUM(end_ms-start_ms),0) AS ms FROM word_lesson_activity_intervals").get() as {ms:number}).ms;
    totals.grammarCloze = (db.prepare("SELECT COALESCE(SUM(end_ms-start_ms),0) AS ms FROM grammar_cloze_activity_intervals").get() as {ms:number}).ms;
    totals.conversation = (db.prepare("SELECT (SELECT COALESCE(SUM(active_ms),0) FROM conversation_activity_baseline) + (SELECT COALESCE(SUM(end_ms-start_ms),0) FROM conversation_activity_intervals) AS ms").get() as {ms:number}).ms;
    totals.dictation = (db.prepare("SELECT COALESCE(SUM(CASE WHEN s.status <> 'completed' THEN MAX(s.active_ms,COALESCE((SELECT SUM(i.end_ms-i.start_ms) FROM journey_typing_intervals i WHERE i.session_id=s.id AND i.mode='dictation'),0)) ELSE s.active_ms END),0) AS ms FROM typing_dictation_lessons s").get() as {ms:number}).ms;
    const settings = loadSettings(db).values;
    const days = Array.from({length:7},(_,i) => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate()-i); return d.toISOString().slice(0,10); });
    return { version: "journey-v3", timezone:tz, today, totals, todayMs: byDay[today] ?? zero(), activeDays: days.filter(d => Object.values(byDay[d] ?? zero()).some(v => v > 0)).length, journeyHours: settings.journeyHours ?? { b2:250,c1:300,c2:400 }, dailyMinutes: { grammar:15,vocabulary:10,words:5,books:10,dictation:10,wordLesson:5,grammarCloze:10,conversation:2.5, ...(settings.dailyMinutes ?? {}) }, dailyOrder: [...(settings.dailyOrder ?? []), ...modes.filter(m => !(settings.dailyOrder ?? []).includes(m))], bookMinutes: settings.typingBookMinutes ?? 5 };
}

