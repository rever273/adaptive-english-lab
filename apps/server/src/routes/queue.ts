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
  const entryId = j.kind === "vocabulary_enrichment" ? (j.payload as { entryId?: unknown }).entryId : null;
  const word = typeof entryId === "string" ? (db.prepare("SELECT lemma FROM vocabulary_entries e WHERE id = ? AND (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = e.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'").get(entryId) as { lemma: string } | undefined)?.lemma ?? null : null;
  const diagnostic = j.errorCode ? (db.prepare("SELECT reason FROM job_events WHERE job_id = ? AND (reason LIKE 'failed:%|%' OR reason LIKE 'retry:%|%') ORDER BY sequence DESC LIMIT 1").get(id) as { reason: string } | undefined)?.reason.split("|")[1] : undefined;
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
    word,
    diagnosticCodes: diagnostic ? diagnostic.split(",").filter(c => /^[A-Z][A-Z0-9_]{0,39}$/.test(c)) : [],
    cancelRequested: j.cancelRequested,
    // progress is counted items from the checkpoint, never a fabricated percentage of a single LLM call
    progress: (j.checkpoint as { done?: number; total?: number } | null)?.total !== undefined ? { done: (j.checkpoint as { done?: number }).done ?? 0, total: (j.checkpoint as { total: number }).total } : null,
    hasResult: resultOf(db, id) !== undefined,
  };
};

export function registerQueueRoutes(app: FastifyInstance, db: Db, deps: QueueDeps, scheduler: GpuScheduler | null): void {
  app.get("/api/v1/jobs", async (req) => {
    const q = req.query as { state?: string; kind?: string; limit?: string; offset?: string };
    if (q.state && !(STATES as readonly string[]).includes(q.state)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown state filter");
    const jobs = listJobs(db, { state: q.state as JobState | undefined, kind: q.kind as JobKind | undefined, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined });
    // the whole queue by state (for the summary line and the "load more" list), not only the rows that were sent
    const counts: Record<string, number> = {};
    for (const r of db.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as Array<{ state: string; n: number }>) counts[r.state] = r.n;
    return { jobs: jobs.map((j) => publicJob(db, j.id)), counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  });

  // D64: a compact picture for the floating AI panel. Jobs of one kind that are still open form the current "wave"; done/failed count the
  // jobs of that kind created since the oldest open one, and the time per item is the median of the last finished ones (measured, not guessed).
  app.get("/api/v1/ai/activity", async () => {
    const open = db.prepare("SELECT kind, COUNT(*) AS n, MIN(created_at) AS since, SUM(state = 'running') AS running, SUM(state = 'waiting_for_gpu') AS waiting, SUM(state = 'paused') AS paused FROM jobs WHERE state IN ('queued','waiting_for_gpu','running','paused') AND kind <> 'test_unit' GROUP BY kind").all() as Array<{ kind: string; n: number; since: string; running: number; waiting: number; paused: number }>;
    const waves = open.map((w) => {
      const closed = db.prepare("SELECT SUM(state = 'completed') AS done, SUM(state IN ('failed','cancelled')) AS failed FROM jobs WHERE kind = ? AND created_at >= ? AND state IN ('completed','failed','cancelled')").get(w.kind, w.since) as { done: number | null; failed: number | null };
      const recent = (db.prepare("SELECT (julianday(finished_at) - julianday(started_at)) * 86400000 AS ms FROM jobs WHERE kind = ? AND state = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 9").all(w.kind) as Array<{ ms: number }>).map((r) => r.ms).sort((a, b) => a - b);
      const reason = w.waiting > 0 ? (db.prepare("SELECT e.reason AS r FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.kind = ? AND j.state = 'waiting_for_gpu' ORDER BY e.rowid DESC LIMIT 1").get(w.kind) as { r: string } | undefined)?.r ?? null : null;
      const done = closed.done ?? 0;
      const failed = closed.failed ?? 0;
      return { kind: w.kind, open: w.n, running: w.running, waiting: w.waiting, paused: w.paused, done, failed, total: w.n + done + failed, msPerItem: recent.length ? Math.round(recent[Math.floor(recent.length / 2)]!) : null, waitingReason: reason };
    });
    const status = scheduler ? await scheduler.status() : null;
    return {
      waves,
      active: status?.activeJob ? { kind: status.activeJob.kind, runningForMs: status.activeJob.runningForMs } : null,
      models: status?.residentModels ?? [],
      practiceActive: status?.practiceActive ?? false,
      telemetry: status && status.telemetry !== "unavailable" ? { usedMib: status.telemetry.usedMib, totalMib: status.telemetry.totalMib } : null,
    };
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
