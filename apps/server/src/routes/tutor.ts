import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { agentTask, type AgentTaskKind } from "../domain/tutor/agentExport.js";
import { askTutor, getThread } from "../domain/tutor/repository.js";

const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } } as const;
const TaskQuery = z.object({ kind: z.enum(["session", "exercise", "batch", "findings", "coverage", "progress", "lessons"]), id: z.string().max(64).optional() }).strict();

/**
 * Tutor (spec/02, spec/08): POST /tutor shows the approved rule at once and queues the local model for new examples / free questions (202).
 * No route starts a model call itself; Practice leases keep the queued jobs waiting. The agent-task text is built from IDs only.
 */
export function registerTutorRoutes(app: FastifyInstance, db: Db, deps: { now: () => Date; newId: () => string }, hooks: { onQueued?: () => void } = {}): void {
  app.post("/api/v1/tutor", async (req, reply) => {
    const r = askTutor(db, deps, req.body);
    if (r.jobId) hooks.onQueued?.();
    return reply.code(202).send(r);
  });

  app.get<{ Params: { id: string } }>("/api/v1/tutor/threads/:id", idParams, async (req) => getThread(db, req.params.id));

  // answered slots the learner can ask about (same gate as feedback is enforced again at ask time)
  app.get("/api/v1/tutor/slots", async () => {
    const rows = db
      .prepare(
        `SELECT ss.id AS slotId, ss.session_id AS sessionId, ss.ordinal, er.id AS revisionId, er.type, er.content_json AS c, s.purpose, s.status AS sessionStatus,
                (SELECT MAX(server_at) FROM session_events e WHERE e.slot_id = ss.id) AS lastEvent
           FROM session_slots ss JOIN sessions s ON s.id = ss.session_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
          WHERE (EXISTS (SELECT 1 FROM attempts a WHERE a.slot_id = ss.id) OR EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type IN ('show_answer','skip')))
            AND NOT (s.purpose IN ('heldout','diagnostic') AND s.status = 'active')
          ORDER BY s.created_at DESC, ss.ordinal DESC LIMIT 30`,
      )
      .all() as Array<{ slotId: string; sessionId: string; ordinal: number; revisionId: string; type: string; c: string; purpose: string; lastEvent: string | null }>;
    return {
      slots: rows.map((r) => {
        const c = JSON.parse(r.c) as { prompt_en: string; target_skill: string };
        return { slotId: r.slotId, sessionId: r.sessionId, ordinal: r.ordinal, revisionId: r.revisionId, type: r.type, purpose: r.purpose, skill: c.target_skill, prompt: c.prompt_en.slice(0, 200) };
      }),
    };
  });

  app.get("/api/v1/tutor/agent-task", async (req) => {
    const q = TaskQuery.safeParse(req.query);
    if (!q.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid");
    return { text: agentTask(db, q.data.kind as AgentTaskKind, q.data.id) };
  });
}
