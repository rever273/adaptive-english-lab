import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";

export type JobKind = "free_text_analysis" | "triage" | "generation" | "vocabulary_enrichment" | "tutor" | "benchmark" | "diagnostic_probe" | "test_unit";
export type JobState = "queued" | "waiting_for_gpu" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  priority: 1 | 2 | 3;
  payload: unknown;
  modelVersionId: string | null;
  idempotencyKey: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryCount: number;
  availableAt: string;
  cancelRequested: boolean;
  checkpoint: unknown;
  leaseToken: number | null;
  heartbeatAt: string | null;
  errorCode: string | null;
}

interface Row {
  id: string;
  kind: JobKind;
  state: JobState;
  priority: 1 | 2 | 3;
  payload_json: string;
  model_version_id: string | null;
  idempotency_key: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  retry_count: number;
  available_at: string;
  cancel_requested: number;
  checkpoint_json: string;
  lease_token: number | null;
  heartbeat_at: string | null;
  error_code: string | null;
}

const toJob = (r: Row): Job => ({
  id: r.id,
  kind: r.kind,
  state: r.state,
  priority: r.priority,
  payload: JSON.parse(r.payload_json),
  modelVersionId: r.model_version_id,
  idempotencyKey: r.idempotency_key,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  retryCount: r.retry_count,
  availableAt: r.available_at,
  cancelRequested: r.cancel_requested === 1,
  checkpoint: JSON.parse(r.checkpoint_json),
  leaseToken: r.lease_token,
  heartbeatAt: r.heartbeat_at,
  errorCode: r.error_code,
});

export interface QueueDeps {
  now: () => Date;
  newId: () => string;
}

export class StaleLeaseError extends Error {
  readonly code = "STALE_LEASE";
  constructor(message = "The job lease is no longer current (stale fencing token)") {
    super(message);
  }
}

/** Priorities: 1 = post-session assessment, 2 = foreground tutor/vocabulary, 3 = generation / benchmark (spec/07). */
export const DEFAULT_PRIORITY: Record<JobKind, 1 | 2 | 3> = {
  free_text_analysis: 1,
  triage: 1,
  diagnostic_probe: 1,
  tutor: 2,
  vocabulary_enrichment: 2,
  generation: 3,
  benchmark: 3,
  test_unit: 3,
};

export const getJob = (db: Db, id: string): Job | undefined => {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return r && toJob(r);
};

export function listJobs(db: Db, filter: { state?: JobState; kind?: JobKind; limit?: number } = {}): Job[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.state) (where.push("state = ?"), params.push(filter.state));
  if (filter.kind) (where.push("kind = ?"), params.push(filter.kind));
  const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  return (db.prepare(sql).all(...params, Math.min(filter.limit ?? 100, 100)) as Row[]).map(toJob);
}

/** Append-only job event; the job row mirrors the latest state. Must run inside the caller's transaction. */
export function appendEvent(db: Db, deps: QueueDeps, jobId: string, state: JobState, reason: string): number {
  const last = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM job_events WHERE job_id = ?").get(jobId) as { n: number };
  db.prepare("INSERT INTO job_events(id, job_id, sequence, state, reason, created_at) VALUES (?,?,?,?,?,?)").run(deps.newId(), jobId, last.n + 1, state, reason, deps.now().toISOString());
  return last.n + 1;
}

export interface EnqueueInput {
  kind: JobKind;
  payload: unknown;
  /** business key: the same key never creates a second job (idempotent delivery) */
  idempotencyKey: string;
  priority?: 1 | 2 | 3;
  modelVersionId?: string;
  /** content batch this unit belongs to (TASK_010) */
  batchId?: string;
  /** do not start before this instant */
  availableAt?: Date;
}

/** Idempotent: a repeated key returns the existing job. The attempt/assessment that asked for it is already committed. */
export function enqueue(db: Db, deps: QueueDeps, input: EnqueueInput): { job: Job; created: boolean } {
  const existing = db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(input.idempotencyKey) as Row | undefined;
  if (existing) return { job: toJob(existing), created: false };
  const id = deps.newId();
  const now = deps.now().toISOString();
  db.prepare(
    `INSERT INTO jobs(id, kind, state, priority, payload_json, model_version_id, batch_id, idempotency_key, created_at, available_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, input.kind, "queued", input.priority ?? DEFAULT_PRIORITY[input.kind], JSON.stringify(input.payload), input.modelVersionId ?? null, input.batchId ?? null, input.idempotencyKey, now, (input.availableAt ?? deps.now()).toISOString());
  appendEvent(db, deps, id, "queued", "enqueued");
  return { job: getJob(db, id)!, created: true };
}

function setState(db: Db, deps: QueueDeps, id: string, to: JobState, reason: string, extra: Record<string, unknown> = {}): void {
  const sets = ["state = ?"];
  const params: unknown[] = [to];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  try {
    db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  } catch (e) {
    throw new ApiError(409, "ILLEGAL_TRANSITION", (e as Error).message.replace(/^jobs: /, ""), { to });
  }
  appendEvent(db, deps, id, to, reason);
}

export const iso = (d: Date): string => d.toISOString();

/** ---- user / API actions (spec/02 POST /jobs/:id/actions) ---- */

export type JobAction = "pause" | "resume" | "retry" | "cancel";

export function applyAction(db: Db, deps: QueueDeps, id: string, action: JobAction): Job {
  return db
    .transaction((): Job => {
      const job = getJob(db, id);
      if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "Unknown job");
      const now = iso(deps.now());
      switch (action) {
        case "pause": {
          if (job.state === "running") {
            // a running unit is aborted at a safe boundary by the scheduler; the request is recorded and survives a restart
            db.prepare("UPDATE jobs SET cancel_requested = cancel_requested WHERE id = ?").run(id);
            appendEvent(db, deps, id, "running", "pause_requested:user_pause");
            db.prepare("UPDATE jobs SET checkpoint_json = json_set(checkpoint_json, '$.pause_requested', 'user_pause') WHERE id = ?").run(id);
          } else if (job.state === "queued" || job.state === "waiting_for_gpu") {
            setState(db, deps, id, "paused", "user_pause");
          } else throw new ApiError(409, "ILLEGAL_TRANSITION", `Cannot pause a ${job.state} job`);
          break;
        }
        case "resume": {
          if (job.state !== "paused") throw new ApiError(409, "ILLEGAL_TRANSITION", `Cannot resume a ${job.state} job`);
          setState(db, deps, id, "queued", "resumed_by_user", { available_at: now });
          break;
        }
        case "retry": {
          if (job.state !== "failed") throw new ApiError(409, "ILLEGAL_TRANSITION", `Only a failed job can be retried (now ${job.state})`);
          setState(db, deps, id, "queued", "retry_by_user", { available_at: now, error_code: null, finished_at: null, lease_token: null, heartbeat_at: null, retry_count: 0 });
          break;
        }
        case "cancel": {
          if (job.state === "running") {
            db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(id);
            appendEvent(db, deps, id, "running", "cancel_requested");
          } else if (job.state === "completed" || job.state === "cancelled" || job.state === "failed") {
            throw new ApiError(409, "ILLEGAL_TRANSITION", `Cannot cancel a ${job.state} job`);
          } else {
            db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(id);
            setState(db, deps, id, "cancelled", "cancelled_by_user", { finished_at: now });
          }
          break;
        }
      }
      return getJob(db, id)!;
    })
    .immediate();
}

/** ---- scheduler-side operations (all token-checked) ---- */

export function reasonOfLastEvent(db: Db, jobId: string, state?: JobState): string | null {
  const r = (state
    ? db.prepare("SELECT reason FROM job_events WHERE job_id = ? AND state = ? ORDER BY sequence DESC LIMIT 1").get(jobId, state)
    : db.prepare("SELECT reason FROM job_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1").get(jobId)) as { reason: string } | undefined;
  return r?.reason ?? null;
}

export function markWaiting(db: Db, deps: QueueDeps, id: string, reason: string): void {
  db.transaction(() => {
    const j = getJob(db, id);
    if (!j) return;
    if (j.state === "waiting_for_gpu" && reasonOfLastEvent(db, id) === reason) return; // do not spam events
    if (j.state === "queued" || j.state === "waiting_for_gpu") setState(db, deps, id, "waiting_for_gpu", reason);
  }).immediate();
}

export function startRunning(db: Db, deps: QueueDeps, id: string, token: number): void {
  db.transaction(() => {
    setState(db, deps, id, "running", "granted", { lease_token: token, heartbeat_at: iso(deps.now()), started_at: iso(deps.now()) });
  }).immediate();
}

export function heartbeat(db: Db, deps: QueueDeps, id: string, token: number, owner: string, timeoutMs: number): boolean {
  return db.transaction(() => {
    const now = iso(deps.now());
    const current = db.prepare("SELECT 1 FROM jobs WHERE id = ? AND state = 'running' AND lease_token = ?").get(id, token);
    if (!current) return false;
    const lock = db.prepare("UPDATE gpu_lock SET lease_until = ? WHERE id = 1 AND owner_id = ? AND fencing_token = ? AND lease_until > ?")
      .run(iso(new Date(deps.now().getTime() + timeoutMs)), owner, token, now);
    if (lock.changes !== 1) return false;
    db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND state = 'running' AND lease_token = ?").run(now, id, token);
    return true;
  }).immediate();
}

function assertToken(db: Db, id: string, token: number): void {
  const j = db.prepare("SELECT state, lease_token FROM jobs WHERE id = ?").get(id) as { state: string; lease_token: number | null } | undefined;
  const lock = db.prepare("SELECT fencing_token FROM gpu_lock WHERE id = 1").get() as { fencing_token: number };
  // a result from an older owner is rejected: the job must still be running under THIS token, and the lock must not have moved on
  if (!j || j.state !== "running" || j.lease_token !== token || lock.fencing_token !== token) throw new StaleLeaseError();
}

export interface JobResultInput {
  schemaVersion: string;
  output: unknown;
  metrics?: Record<string, unknown>;
  /** extra work committed atomically with the result (e.g. annotations); throwing aborts the whole commit */
  alsoCommit?: (db: Db) => void;
}

/** Result + checkpoint + `completed` in ONE transaction, only while the fencing token is current. A duplicate delivery is a no-op. */
export function completeJob(db: Db, deps: QueueDeps, id: string, token: number, res: JobResultInput): { duplicate: boolean } {
  return db
    .transaction((): { duplicate: boolean } => {
      const done = db.prepare("SELECT 1 FROM job_results WHERE job_id = ?").get(id);
      if (done) return { duplicate: true };
      assertToken(db, id, token);
      const out = JSON.stringify(res.output);
      db.prepare("INSERT INTO job_results(id, job_id, schema_version, output_json, output_hash, metrics_json, created_at) VALUES (?,?,?,?,?,?,?)").run(
        deps.newId(),
        id,
        res.schemaVersion,
        out,
        createHash("sha256").update(out).digest("hex"),
        JSON.stringify(res.metrics ?? {}),
        iso(deps.now()),
      );
      res.alsoCommit?.(db);
      setState(db, deps, id, "completed", "result_committed", { finished_at: iso(deps.now()), lease_token: token });
      return { duplicate: false };
    })
    .immediate();
}

export function saveCheckpoint(db: Db, id: string, token: number, checkpoint: unknown): void {
  db.transaction(() => {
    assertToken(db, id, token);
    db.prepare("UPDATE jobs SET checkpoint_json = ? WHERE id = ?").run(JSON.stringify(checkpoint), id);
  }).immediate();
}

export const MAX_RETRIES = 3;
/** Transient retry delays (spec/06: 2 s then 5 s, then the limit is reached). Deterministic: no random jitter, so it is testable. */
export const RETRY_DELAYS_MS = [2000, 5000, 10000];

export function failOrRetry(db: Db, deps: QueueDeps, id: string, token: number, error: { code: string; transient: boolean }): "queued" | "failed" {
  return db
    .transaction((): "queued" | "failed" => {
      assertToken(db, id, token);
      const j = getJob(db, id)!;
      if (error.transient && j.retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[Math.min(j.retryCount, RETRY_DELAYS_MS.length - 1)]!;
        setState(db, deps, id, "queued", `retry:${error.code}`, { retry_count: j.retryCount + 1, available_at: iso(new Date(deps.now().getTime() + delay)), error_code: error.code, lease_token: null, heartbeat_at: null });
        return "queued";
      }
      setState(db, deps, id, "failed", `failed:${error.code}`, { error_code: error.code, finished_at: iso(deps.now()), lease_token: null, heartbeat_at: null });
      return "failed";
    })
    .immediate();
}

/** Safe-boundary stop: user pause, practice preemption, lost lease. The uncommitted unit is discarded (it restarts later). */
export function releaseToQueue(db: Db, deps: QueueDeps, id: string, token: number, to: "queued" | "paused", reason: string): void {
  db.transaction(() => {
    const j = getJob(db, id);
    if (!j || j.state !== "running" || j.leaseToken !== token) return;
    setState(db, deps, id, to, reason, { lease_token: null, heartbeat_at: null, available_at: iso(deps.now()) });
    db.prepare("UPDATE jobs SET checkpoint_json = json_remove(checkpoint_json, '$.pause_requested') WHERE id = ?").run(id);
  }).immediate();
}

export function finishCancelled(db: Db, deps: QueueDeps, id: string, token: number | null): void {
  db.transaction(() => {
    const j = getJob(db, id);
    if (!j || j.state !== "running" || (token !== null && j.leaseToken !== token)) return;
    setState(db, deps, id, "cancelled", "cancelled_after_teardown", { finished_at: iso(deps.now()), lease_token: null, heartbeat_at: null });
  }).immediate();
}

/**
 * Startup recovery and lease expiry: a running unit whose owner died goes back to the queue with a recovery reason (its last
 * committed checkpoint is kept, a completed item is never repeated). Returns the recovered ids.
 */
export function recoverStale(db: Db, deps: QueueDeps, opts: { timeoutMs: number; all?: boolean }): string[] {
  return db
    .transaction((): string[] => {
      const cutoff = iso(new Date(deps.now().getTime() - opts.timeoutMs));
      const rows = (opts.all
        ? db.prepare("SELECT id FROM jobs WHERE state = 'running'").all()
        : db.prepare("SELECT id FROM jobs WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)").all(cutoff)) as Array<{ id: string }>;
      const lock = db.prepare("SELECT owner_id, lease_until FROM gpu_lock WHERE id = 1").get() as { owner_id: string | null; lease_until: string | null };
      // A current GPU lease is stronger evidence of a live owner than a stale job timestamp.
      if (lock.owner_id !== null && lock.lease_until !== null && lock.lease_until > iso(deps.now())) return [];
      for (const { id } of rows) {
        const j = getJob(db, id)!;
        if (j.cancelRequested) setState(db, deps, id, "cancelled", opts.all ? "cancelled_on_recovery" : "cancelled_lease_expired", { finished_at: iso(deps.now()), lease_token: null, heartbeat_at: null });
        else setState(db, deps, id, "queued", opts.all ? "recovery:process_restart" : "recovery:lease_expired", { lease_token: null, heartbeat_at: null, available_at: iso(deps.now()) });
      }
      if (rows.length > 0) {
        // the dead owner's token must never commit again: move the lock forward
        db.prepare("UPDATE gpu_lock SET fencing_token = fencing_token + 1, owner_id = NULL, lease_until = NULL WHERE id = 1").run();
      }
      return rows.map((r) => r.id);
    })
    .immediate();
}

export function resultOf(db: Db, jobId: string): { schemaVersion: string; output: unknown; outputHash: string; metrics: unknown } | undefined {
  const r = db.prepare("SELECT schema_version, output_json, output_hash, metrics_json FROM job_results WHERE job_id = ?").get(jobId) as { schema_version: string; output_json: string; output_hash: string; metrics_json: string } | undefined;
  return r && { schemaVersion: r.schema_version, output: JSON.parse(r.output_json), outputHash: r.output_hash, metrics: JSON.parse(r.metrics_json) };
}
