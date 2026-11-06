import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { loadSettings } from "../domain/sessions/policy.js";

const modes = ["grammar", "vocabulary", "words", "books", "dictation"] as const;
type Mode = typeof modes[number];
const zero = () => Object.fromEntries(modes.map(m => [m, 0])) as Record<Mode, number>;
const Body = z.object({ id: z.string().uuid(), sessionId: z.string().min(1).max(64), mode: z.enum(["words", "books", "dictation"]), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict();

// Daily Practice follows Brisbane even if the browser or computer changes timezone.
const DAILY_TIMEZONE = "Australia/Brisbane";
const DAILY_START_OFFSET_MS = 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateIn(tz: string, at: number): string {
  let f = formatters.get(tz); if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); if (formatters.size > 16) formatters.clear(); formatters.set(tz, f); }
  return f.format(new Date(at));
}
/** The learning day changes at 01:00 Brisbane time. The raw timestamps are never changed. */
export function learningDate(at: number, timezone = DAILY_TIMEZONE): string {
  return dateIn(timezone, at - DAILY_START_OFFSET_MS);
}
/** Split an interval exactly at the learning-day boundary. */
export function allocateDays(start: number, end: number, timezone: string): Array<{ date: string; ms: number }> {
  const result: Array<{ date: string; ms: number }> = [];
  while (start < end) {
    const date = learningDate(start, timezone);
    if (learningDate(end - 1, timezone) === date) { result.push({ date, ms: end - start }); break; }
    let lo = start + 1, hi = end;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (learningDate(mid, timezone) === date) lo = mid + 1; else hi = mid; }
    result.push({ date, ms: lo - start }); start = lo;
  }
  return result;
}
export function registerJourneyRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/v1/journey/typing-interval", async req => {
    const p = Body.safeParse(req.body); if (!p.success) throw new ApiError(400,"VALIDATION_ERROR","Invalid interval");
    const b = p.data;
    return db.transaction(() => {
      const old = db.prepare("SELECT session_id AS sessionId,mode,start_ms AS startMs,end_ms AS endMs FROM journey_typing_intervals WHERE id=?").get(b.id) as Omit<typeof b,"id"> | undefined;
      if (old) { if (old.sessionId !== b.sessionId || old.mode !== b.mode || old.startMs !== b.startMs || old.endMs !== b.endMs) throw new ApiError(409,"ACTIVITY_ID_CONFLICT","Interval id already used"); return { recorded: false }; }
      const row = b.mode === "dictation" ? db.prepare("SELECT started_at AS startedAt,completed_at AS endedAt FROM typing_dictation_lessons WHERE id=?").get(b.sessionId) : db.prepare("SELECT started_at AS startedAt,ended_at AS endedAt FROM typing_sessions WHERE id=? AND mode=?").get(b.sessionId,b.mode);
      const session = row as {startedAt: string|null;endedAt: string|null}|undefined;
      if (!session?.startedAt) throw new ApiError(404,"SESSION_NOT_FOUND","Unknown typing session");
      if (b.endMs <= b.startMs || b.endMs-b.startMs > 15000 || b.startMs < Date.parse(session.startedAt) || b.endMs > Date.now()+2000 || (session.endedAt && b.endMs > Date.parse(session.endedAt)+2000)) throw new ApiError(400,"ACTIVITY_INVALID","Invalid interval");
      if (db.prepare("SELECT 1 FROM journey_typing_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs,b.startMs) || db.prepare("SELECT 1 FROM practice_activity_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs,b.startMs)) throw new ApiError(409,"ACTIVITY_OVERLAP","Interval overlaps existing activity");
      db.prepare("INSERT INTO journey_typing_intervals VALUES (?,?,?,?,?,?)").run(b.id,b.sessionId,b.mode,b.startMs,b.endMs,new Date().toISOString());
      return { recorded: true };
    }).immediate();
  });
  app.get("/api/v1/journey", async req => {
    const tz = DAILY_TIMEZONE;
    const today = learningDate(Date.now(), tz);
    const byDay: Record<string,Record<Mode,number>> = {}; const totals = zero();
    const cutoff = Date.now() - 9 * 86400000;
    const grammar = db.prepare(`SELECT i.start_ms AS startMs,i.end_ms AS endMs,CASE WHEN v.session_id IS NULL THEN 'grammar' ELSE 'vocabulary' END AS mode FROM practice_activity_intervals i LEFT JOIN vocabulary_sessions v ON v.session_id=i.session_id WHERE i.end_ms >= ?`).all(cutoff) as Array<{startMs:number;endMs:number;mode:Mode}>;
    const typing = db.prepare("SELECT start_ms AS startMs,end_ms AS endMs,mode FROM journey_typing_intervals WHERE end_ms >= ?").all(cutoff) as Array<{startMs:number;endMs:number;mode:Mode}>;
    for (const row of [...grammar,...typing]) for (const part of allocateDays(row.startMs,row.endMs,tz)) { (byDay[part.date] ??= zero())[row.mode] += part.ms;  }
    for (const r of db.prepare(`SELECT CASE WHEN v.session_id IS NULL THEN 'grammar' ELSE 'vocabulary' END AS mode, SUM(i.end_ms-i.start_ms) AS ms FROM practice_activity_intervals i LEFT JOIN vocabulary_sessions v ON v.session_id=i.session_id GROUP BY mode`).all() as Array<{mode:'grammar'|'vocabulary';ms:number}>) totals[r.mode] = r.ms;
    for (const r of db.prepare("SELECT s.mode,COALESCE(SUM(CASE WHEN s.status='active' THEN MAX(s.active_ms,COALESCE((SELECT SUM(i.end_ms-i.start_ms) FROM journey_typing_intervals i WHERE i.session_id=s.id AND i.mode=s.mode),0)) ELSE s.active_ms END),0) AS ms FROM typing_sessions s GROUP BY s.mode").all() as Array<{mode:'words'|'books';ms:number}>) totals[r.mode] = r.ms;
    totals.dictation = (db.prepare("SELECT COALESCE(SUM(CASE WHEN s.status <> 'completed' THEN MAX(s.active_ms,COALESCE((SELECT SUM(i.end_ms-i.start_ms) FROM journey_typing_intervals i WHERE i.session_id=s.id AND i.mode='dictation'),0)) ELSE s.active_ms END),0) AS ms FROM typing_dictation_lessons s").get() as {ms:number}).ms;
    const settings = loadSettings(db).values;
    const days = Array.from({length:7},(_,i) => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate()-i); return d.toISOString().slice(0,10); });
    return { version: "journey-v2", timezone:tz, today, totals, todayMs: byDay[today] ?? zero(), activeDays: days.filter(d => Object.values(byDay[d] ?? zero()).some(v => v > 0)).length, journeyHours: settings.journeyHours ?? { b2:250,c1:300,c2:400 }, dailyMinutes: settings.dailyMinutes ?? { grammar:15,vocabulary:10,words:5,books:10,dictation:10 }, dailyOrder: settings.dailyOrder ?? modes, bookMinutes: settings.typingBookMinutes ?? 5 };
  });
}
