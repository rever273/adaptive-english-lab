import type { SessionEventRequest, SessionEventResponse } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { localDateIn } from "./canonical.js";
import type { AttemptDeps } from "./ports.js";
import { awardCompletionXp } from "../sessions/xp.js";

type StoredType = SessionEventResponse["type"];
const API_TO_STORED: Record<SessionEventRequest["type"], StoredType> = {
  hint: "hint",
  reveal_answer: "show_answer",
  skip: "skip",
  continue: "continue",
};

export interface RecordedEvent {
  status: 200 | 201;
  body: SessionEventResponse;
}

interface EventRow {
  id: string;
  session_id: string;
  slot_id: string | null;
  event_type: string;
  server_at: string;
}

/**
 * hint / reveal_answer / skip / continue for a revealed slot. Skip is an event, never a synthetic wrong attempt.
 * Rules (D26): the slot must have been revealed; skip/continue close the slot; continue needs an answer (use skip otherwise).
 */
export function recordSessionEvent(db: Db, deps: AttemptDeps, sessionId: string, req: SessionEventRequest): RecordedEvent {
  const type = API_TO_STORED[req.type];
  return db
    .transaction((): RecordedEvent => {
      const dup = db.prepare("SELECT id, session_id, slot_id, event_type, server_at FROM session_events WHERE client_event_id = ?").get(req.clientEventId) as EventRow | undefined;
      if (dup) {
        if (dup.session_id !== sessionId || dup.slot_id !== req.slotId || dup.event_type !== type) {
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "clientEventId was already used with a different payload");
        }
        return { status: 200, body: { eventId: dup.id, type, slotId: req.slotId, serverAt: dup.server_at, replayed: true } };
      }

      const session = db.prepare("SELECT status, timezone, purpose FROM sessions WHERE id = ?").get(sessionId) as { status: string; timezone: string; purpose: string } | undefined;
      if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
      if (session.status !== "active") throw new ApiError(409, "SESSION_NOT_ACTIVE", "Session is not active");
      // an independent check must stay independent: no hints and no shown answers inside a diagnostic block or a held-out check
      if ((type === "hint" || type === "show_answer") && (session.purpose === "diagnostic" || session.purpose === "heldout")) {
        throw new ApiError(409, "HINTS_CLOSED", "Hints and shown answers are closed in a diagnostic block and in a held-out check. Answer, choose \"I don't know\", or skip.");
      }
      const slot = db.prepare("SELECT id FROM session_slots WHERE id = ? AND session_id = ?").get(req.slotId, sessionId);
      if (!slot) throw new ApiError(404, "SLOT_NOT_FOUND", "Slot does not belong to this session");

      const types = (db.prepare("SELECT event_type AS t FROM session_events WHERE slot_id = ?").all(req.slotId) as Array<{ t: string }>).map((e) => e.t);
      if (!types.includes("reveal")) throw new ApiError(409, "SLOT_NOT_REVEALED", "The slot has not been revealed yet");
      if (types.includes("skip") || types.includes("continue")) throw new ApiError(409, "SLOT_CLOSED", "The slot was already skipped or continued");
      if (type === "continue") {
        const answered = db.prepare("SELECT 1 FROM attempts WHERE slot_id = ?").get(req.slotId);
        if (!answered) throw new ApiError(409, "CONTINUE_WITHOUT_ANSWER", "Answer, choose \"I don't know\", or skip before continuing");
      }

      const now = deps.now();
      const id = deps.newId();
      const serverAt = now.toISOString();
      db.prepare(
        `INSERT INTO session_events(id, session_id, slot_id, client_event_id, event_type, payload_json, server_at, local_date, timezone)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(id, sessionId, req.slotId, req.clientEventId, type, JSON.stringify({ schema_version: 1 }), serverAt, localDateIn(session.timezone, now), session.timezone);
      if (type === "continue" && session.purpose === "practice") {
        const vocabulary = db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(sessionId) !== undefined;
        awardCompletionXp(db, { id: deps.newId(), slotId: req.slotId, eventId: id, track: vocabulary ? "vocabulary" : "grammar", at: serverAt });
      }
      let hint: string | null | undefined;
      if (type === "hint") {
        // the Russian hints of the exercise, one more each time; never the answer itself
        const row = db.prepare("SELECT er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?").get(req.slotId) as { c: string };
        const hints = (JSON.parse(row.c) as { hints_ru?: string[] }).hints_ru ?? [];
        const given = types.filter((t) => t === "hint").length; // earlier hints of this slot
        hint = hints.length === 0 ? null : (hints[Math.min(given, hints.length - 1)] ?? null);
      }
      return { status: 201, body: { eventId: id, type, slotId: req.slotId, serverAt, replayed: false, ...(hint !== undefined ? { hint } : {}) } };
    })
    .immediate();
}
