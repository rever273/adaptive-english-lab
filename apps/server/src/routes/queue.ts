import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { applyAction, getJob, listJobs, resultOf, type JobKind, type JobState } from "../queue/jobs.js";
import type { GpuScheduler } from "../queue/scheduler.js";
import type { QueueDeps } from "../queue/jobs.js";

const ActionSchema = z.object({ action: z.enum(["pause", "resume", "retry", "cancel"]) }).strict();
const STATES = ["queued", "waiting_for_gpu", "running", "paused", "completed", "failed", "cancelled"] as const;

const publicJob = (db: Db, id: string) => {
  const j = getJob(db, id)!;
  return {
    id: j.id,
    kind: j.kind,
    state: j.state,
    priority: j.priority,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    retryCount: j.retryCount,
    availableAt: j.availableAt,
    errorCode: j.errorCode,
    cancelRequested: j.cancelRequested,
    // progress is counted items from the checkpoint, never a fabricated percentage of a single LLM call
    progress: (j.checkpoint as { done?: number; total?: number } | null)?.total !== undefined ? { done: (j.checkpoint as { done?: number }).done ?? 0, total: (j.checkpoint as { total: number }).total } : null,
    hasResult: resultOf(db, id) !== undefined,
  };
};

export function registerQueueRoutes(app: FastifyInstance, db: Db, deps: QueueDeps, scheduler: GpuScheduler | null): void {
  app.get("/api/v1/jobs", async (req) => {
    const q = req.query as { state?: string; kind?: string; limit?: string };
    if (q.state && !(STATES as readonly string[]).includes(q.state)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown state filter");
    const jobs = listJobs(db, { state: q.state as JobState | undefined, kind: q.kind as JobKind | undefined, limit: q.limit ? Number(q.limit) : undefined });
    return { jobs: jobs.map((j) => publicJob(db, j.id)) };
  });

  app.get("/api/v1/gpu", async () => {
    if (!scheduler) return { available: false, reason: "scheduler_not_running" };
    return { available: true, ...(await scheduler.status()) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/jobs/:id/actions", { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } }, async (req) => {
    const parsed = ActionSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    applyAction(db, deps, req.params.id, parsed.data.action);
    scheduler?.kick();
    return publicJob(db, req.params.id);
  });

  // SSE: persisted job_events are replayed from Last-Event-ID, then followed. On a gap the client simply refetches /jobs.
  app.get("/api/v1/events", (req, reply) => {
    const lastHeader = req.headers["last-event-id"];
    let last = Number(Array.isArray(lastHeader) ? lastHeader[0] : lastHeader ?? 0);
    if (!Number.isFinite(last) || last < 0) last = 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
    res.write("retry: 2000\n\n");
    const flush = () => {
      const rows = db.prepare("SELECT rowid AS id, job_id AS jobId, sequence, state, reason, created_at AS at FROM job_events WHERE rowid > ? ORDER BY rowid LIMIT 200").all(last) as Array<{ id: number; jobId: string; sequence: number; state: string; reason: string; at: string }>;
      for (const r of rows) {
        res.write(`id: ${r.id}\nevent: job\ndata: ${JSON.stringify({ jobId: r.jobId, sequence: r.sequence, state: r.state, reason: r.reason, at: r.at })}\n\n`);
        last = r.id;
      }
      if (rows.length === 0) res.write(": keepalive\n\n");
    };
    flush();
    const timer = setInterval(flush, 1000);
    req.raw.on("close", () => clearInterval(timer));
  });
}
