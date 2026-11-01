import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import {
  CreateSessionRequestSchema,
  FinishRequestSchema,
  LeaseRequestSchema,
  RevealRequestSchema,
  type CreateSessionResponse,
  type Dashboard,
  type FeedbackResponse,
  type RevealResponse,
  type SessionSnapshot,
  type SessionSummary,
} from "@english-lab/contracts";
import type { DiscoveryConfig } from "@english-lab/learning";
import type { Db } from "../db/open.js";
import { createPracticeSession } from "../domain/sessions/create.js";
import { createDiagnosticBlock, createHeldoutCheck, diagnosticStatus, heldoutStatus } from "../domain/diagnostics/session.js";
import { getFeedback } from "../domain/sessions/feedback.js";
import { finishSession, summarize } from "../domain/sessions/finish.js";
import { HEARTBEAT_SECONDS, takeLease } from "../domain/sessions/lease.js";
import { loadBlueprint, loadSettings, type SessionDeps } from "../domain/sessions/policy.js";
import { courseLessons } from "../domain/sessions/course.js";
import { computeReadiness } from "../domain/sessions/readiness.js";
import { revealSlot } from "../domain/sessions/reveal.js";
import { currentSessionId, getSnapshot, recentSessionId, sessionCategory, type SessionCategory } from "../domain/sessions/snapshot.js";
import { reviewStatus } from "../domain/sessions/reviewQueue.js";
import { activityProgress } from "../domain/sessions/xp.js";
import { ApiError } from "../errors.js";

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

const idParam = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } as const;
const slotParams = {
  type: "object",
  properties: { id: { type: "string", minLength: 1, maxLength: 64 }, slotId: { type: "string", minLength: 1, maxLength: 64 } },
  required: ["id", "slotId"],
} as const;

export interface SessionRouteOptions {
  discovery?: DiscoveryConfig;
  /** shown on the dashboard, e.g. for the non-release vertical-slice profile */
  banner?: string | null;
  /** a practice lease was taken/refreshed: wake the GPU dispatcher so it can step aside */
  onLease?: () => void;
  /** the session was finished: anything that holds the microphone or the card for it must let go */
  onSessionEnd?: (sessionId: string) => void;
  /** the session has no voice-capable exercise left (TASK_021): free the speech model and let the queued AI checks start */
  onVoiceDone?: (sessionId: string) => Promise<void> | void;
}

export function registerSessionRoutes(app: FastifyInstance, db: Db, deps: SessionDeps, opts: SessionRouteOptions = {}): void {
  app.get("/api/v1/activity-progress", async () => ({ grammar: activityProgress(db, "grammar"), vocabulary: activityProgress(db, "vocabulary") }));
  app.post("/api/v1/sessions", async (req, reply): Promise<CreateSessionResponse> => {
    const body = parse(CreateSessionRequestSchema, req.body);
    const r = body.purpose === "diagnostic" ? createDiagnosticBlock(db, deps, body) : body.purpose === "heldout" ? createHeldoutCheck(db, deps, body) : createPracticeSession(db, deps, body, { discovery: opts.discovery, enforceStock: true });
    reply.code(201);
    return r;
  });

  // ?category=grammar|vocabulary: the active session of that kind, plus a pointer to an active session of the other kind (only one can be open)
  app.get("/api/v1/sessions/current", async (req): Promise<{ session: SessionSnapshot | null; otherActive?: { sessionId: string; category: SessionCategory } | null }> => {
    const c = (req.query as { category?: string }).category;
    if (c !== "grammar" && c !== "vocabulary") {
      const id = currentSessionId(db);
      return { session: id ? getSnapshot(db, id) : null };
    }
    const id = currentSessionId(db, c);
    const any = id ? null : currentSessionId(db);
    return { session: id ? getSnapshot(db, id) : null, otherActive: any ? { sessionId: any, category: sessionCategory(db, any) } : null };
  });

  app.get("/api/v1/sessions/recent", async (req): Promise<SessionSummary | null> => {
    const c = (req.query as { category?: string }).category === "vocabulary" ? "vocabulary" : "grammar";
    const last = recentSessionId(db, c);
    return last ? summarize(db, last.id, last.status) : null;
  });

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id", { schema: { params: idParam } }, async (req): Promise<SessionSnapshot> => getSnapshot(db, req.params.id));

  // a finished session's summary, re-read while the local AI checks of its answers are still running (the live "waiting" counter)
  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id/summary", { schema: { params: idParam } }, async (req): Promise<SessionSummary> => {
    const snap = getSnapshot(db, req.params.id);
    if (snap.status !== "completed" && snap.status !== "ended_early") throw new ApiError(409, "SESSION_ACTIVE", "The session is not finished yet");
    return summarize(db, req.params.id, snap.status);
  });

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/voice-done", { schema: { params: idParam } }, async (req) => {
    const snap = getSnapshot(db, req.params.id);
    if (snap.status === "active") await opts.onVoiceDone?.(req.params.id);
    return { released: snap.status === "active" };
  });

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/lease", { schema: { params: idParam } }, async (req) => {
    const body = parse(LeaseRequestSchema, req.body);
    const l = takeLease(db, deps, req.params.id, body.tabId);
    opts.onLease?.();
    return { leaseToken: l.token, expiresAt: l.expiresAt, heartbeatSeconds: HEARTBEAT_SECONDS };
  });

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/reveal", { schema: { params: idParam } }, async (req): Promise<RevealResponse> => {
    const body = parse(RevealRequestSchema, req.body);
    return revealSlot(db, deps, req.params.id, body.slotId, body.tabId);
  });

  app.get<{ Params: { id: string; slotId: string } }>("/api/v1/sessions/:id/slots/:slotId/feedback", { schema: { params: slotParams } }, async (req): Promise<FeedbackResponse> =>
    getFeedback(db, deps, req.params.id, req.params.slotId),
  );

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/finish", { schema: { params: idParam } }, async (req): Promise<SessionSummary> => {
    const body = parse(FinishRequestSchema, req.body);
    const summary = finishSession(db, deps, req.params.id, body.mode);
    opts.onSessionEnd?.(req.params.id);
    return summary;
  });

  // Dashboard: resume pointer, readiness by sequential simulation, and the exact shortage when a session cannot be built.
  app.get("/api/v1/dashboard", async (): Promise<Dashboard> => {
    const settings = loadSettings(db);
    const rows = courseLessons(db);
    const blueprints = rows
      .map((r) => {
        const bp = loadBlueprint(db, r.id);
        const ready = computeReadiness(db, deps, r.id);
        return { blueprintRevisionId: r.id, key: r.key, title: bp.policy.title, status: r.status, completed: r.completed, unlocked: r.unlocked, readySessions: ready.readySessions, shortage: ready.shortage };
      });
    return { activeSessionId: currentSessionId(db, "grammar"), taskCount: settings.values.taskCount, blueprints, banner: opts.banner ?? null, diagnostic: diagnosticStatus(db, deps), review: reviewStatus(db), heldout: heldoutStatus(db, deps) };
  });
}
