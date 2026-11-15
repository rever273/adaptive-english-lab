import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { readDailyTotals, readJourney, readPracticeActivity } from "../domain/journey/readModel.js";
export { allocateDays, learningDate } from "../domain/journey/calendar.js";

const Body = z.object({ id: z.string().uuid(), sessionId: z.string().min(1).max(64), mode: z.enum(["words", "books", "dictation"]), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict();

export function registerJourneyRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/v1/journey/typing-interval", async req => {
    const p = Body.safeParse(req.body); if (!p.success) throw new ApiError(400,"VALIDATION_ERROR","Invalid interval");
    const b = p.data;
    return db.transaction(() => {
      const old = db.prepare("SELECT session_id AS sessionId,mode,start_ms AS startMs,end_ms AS endMs FROM journey_typing_intervals WHERE id=?").get(b.id) as Omit<typeof b,"id"> | undefined;
      if (old) { if (old.sessionId !== b.sessionId || old.mode !== b.mode || old.startMs !== b.startMs || old.endMs !== b.endMs) throw new ApiError(409,"ACTIVITY_ID_CONFLICT","Interval id already used"); return { recorded: false }; }
      const row = b.mode === "dictation" ? db.prepare("SELECT started_at AS startedAt,completed_at AS endedAt FROM typing_dictation_lessons WHERE id=?").get(b.sessionId)
        : db.prepare("SELECT started_at AS startedAt,ended_at AS endedAt FROM typing_sessions WHERE id=? AND mode=?").get(b.sessionId,b.mode)
          // a Key Builder lesson is Words time
          ?? (b.mode === "words" ? db.prepare("SELECT started_at AS startedAt,ended_at AS endedAt FROM typing_key_lessons WHERE id=?").get(b.sessionId) : undefined);
      const session = row as {startedAt: string|null;endedAt: string|null}|undefined;
      if (!session?.startedAt) throw new ApiError(404,"SESSION_NOT_FOUND","Unknown typing session");
      if (b.endMs <= b.startMs || b.endMs-b.startMs > 15000 || b.startMs < Date.parse(session.startedAt) || b.endMs > Date.now()+2000 || (session.endedAt && b.endMs > Date.parse(session.endedAt)+2000)) throw new ApiError(400,"ACTIVITY_INVALID","Invalid interval");
      if (db.prepare("SELECT 1 FROM journey_typing_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs,b.startMs) || db.prepare("SELECT 1 FROM practice_activity_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs,b.startMs) || db.prepare("SELECT 1 FROM word_lesson_activity_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs,b.startMs) || db.prepare("SELECT 1 FROM conversation_activity_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs,b.startMs) || db.prepare("SELECT 1 FROM grammar_cloze_activity_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs,b.startMs)) throw new ApiError(409,"ACTIVITY_OVERLAP","Interval overlaps existing activity");
      db.prepare("INSERT INTO journey_typing_intervals VALUES (?,?,?,?,?,?)").run(b.id,b.sessionId,b.mode,b.startMs,b.endMs,new Date().toISOString());
      return { recorded: true };
    }).immediate();
  });
  app.get("/api/v1/journey/practice-activity", async () => readPracticeActivity(db));
  app.get("/api/v1/journey/daily-totals", async () => readDailyTotals(db));
  app.get("/api/v1/journey", async () => readJourney(db));
}
