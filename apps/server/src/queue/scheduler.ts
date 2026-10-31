import type { Db } from "../db/open.js";
import {
  completeJob,
  failOrRetry,
  finishCancelled,
  getJob,
  heartbeat,
  iso,
  markWaiting,
  reasonOfLastEvent,
  recoverStale,
  releaseToQueue,
  saveCheckpoint,
  startRunning,
  StaleLeaseError,
  type Job,
  type JobKind,
  type QueueDeps,
} from "./jobs.js";
import {
  DEFAULT_SCHEDULER_CONFIG,
  RunnerError,
  realClock,
  type Clock,
  type GpuSample,
  type JobRunner,
  type ModelControl,
  type SchedulerConfig,
  type TelemetryProvider,
} from "./types.js";

type StopIntent = "practice" | "user_pause" | "cancel" | "lease_lost" | "shutdown";

interface ActiveRun {
  job: Job;
  token: number;
  runner: JobRunner;
  controller: AbortController;
  intent: StopIntent | null;
  lastHeartbeat: number;
  startedAt: number;
  promise: Promise<void>;
  models: string[];
}

export interface Release {
  verified: boolean;
  elapsedMs: number;
  samples: number;
}

export interface GpuStatus {
  owner: string | null;
  fencingToken: number;
  leaseUntil: string | null;
  activeJob: { id: string; kind: JobKind; state: string; runningForMs: number } | null;
  residentModels: string[];
  practiceActive: boolean;
  reserveMib: number;
  telemetry: { usedMib: number; totalMib: number; freeMib: number; ageMs: number } | "unavailable";
  waitingByReason: Record<string, number>;
  admission: SchedulerConfig["admission"];
}

export interface SchedulerOptions {
  db: Db;
  newId: () => string;
  clock?: Clock;
  telemetry: TelemetryProvider;
  control: ModelControl;
  runners: JobRunner[];
  instanceId: string;
  config?: Partial<SchedulerConfig>;
  /** called after persisted job state changed (SSE fan-out, tests) */
  onChange?: () => void;
}

/**
 * THE GPU dispatcher (spec/07). At most one heavy GPU unit at any time, enforced by the SQLite lease + fencing token; every result
 * commit re-checks the token. A model server is only ever asked to unload models this dispatcher itself started. Practice (an active
 * practice lease or an explicit grant) always wins: running units are aborted at a safe boundary, the release is PROVEN (unload +
 * /api/ps absence + VRAM plateau) before the speech grant is reported ready, and background work resumes only when practice ends.
 */
export class GpuScheduler {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly deps: QueueDeps;
  private readonly cfg: SchedulerConfig;
  private readonly runners = new Map<JobKind, JobRunner>();
  private active: ActiveRun | null = null;
  private practiceGrant = false;
  private resident: { models: string[]; lastUsed: number } | null = null;
  private lastSample: GpuSample | null = null;
  private ticking = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: SchedulerOptions) {
    this.db = o.db;
    this.clock = o.clock ?? realClock;
    this.deps = { now: () => this.clock.now(), newId: o.newId };
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...o.config };
    if (this.cfg.reserveMib < 1024) this.cfg.reserveMib = 1024; // configurable, never below the safe minimum
    for (const r of o.runners) this.runners.set(r.kind, r);
  }

  /** Startup: a unit left `running` by a dead process goes back to the queue (recovery); the old token can never commit again. */
  recover(): string[] {
    // A second scheduler must not invalidate a live owner at startup.
    this.noteAbandonedModels();
    const ids = recoverStale(this.db, this.deps, { timeoutMs: this.cfg.leaseTimeoutMs });
    if (ids.length > 0) this.o.onChange?.();
    return ids;
  }

  start(intervalMs = 1000): void {
    this.recover();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  /** Wake the loop now (job enqueued, practice lease taken). */
  kick(): void {
    void this.tick().catch(() => undefined);
  }

  // ---------------------------------------------------------------- practice gate

  private practiceLeaseLive(): boolean {
    const r = this.db.prepare("SELECT 1 FROM practice_leases WHERE expires_at > ? LIMIT 1").get(iso(this.clock.now()));
    return r !== undefined;
  }
  practiceActive(): boolean {
    return this.practiceGrant || this.practiceLeaseLive();
  }

  /**
   * Start of a practice session (P0). Stops admission of LLM units, aborts a running unit after the grace period, proves the model
   * release within the bound. `ready:false` means "Preparing speech / waiting_for_gpu": text practice stays available and nothing
   * else is started on top of an unproven GPU. Never kills a foreign process.
   */
  async beginPractice(): Promise<{ ready: boolean; reason: string | null; elapsedMs: number }> {
    const start = this.clock.now().getTime();
    this.practiceGrant = true;
    if (this.active) await this.stopActive("practice");
    const rel = this.resident ? await this.verifiedRelease(this.resident.models) : { verified: true, elapsedMs: 0, samples: 0 };
    if (rel.verified) this.resident = null;
    const loaded = await this.o.control.listLoaded().catch(() => null);
    const ownedStillThere = this.resident !== null;
    const ready = rel.verified && !ownedStillThere && loaded !== null && this.active === null;
    return { ready, reason: ready ? null : ownedStillThere || this.active !== null ? "teardown_unproven" : "model_server_unreachable", elapsedMs: this.clock.now().getTime() - start };
  }

  endPractice(): void {
    this.practiceGrant = false;
    this.kick();
  }

  // ---------------------------------------------------------------- loop

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.step();
    } finally {
      this.ticking = false;
    }
  }

  private async step(): Promise<void> {
    const nowMs = this.clock.now().getTime();
    const practice = this.practiceActive();

    if (this.active) {
      const a = this.active;
      const fresh = getJob(this.db, a.job.id);
      if (fresh?.cancelRequested && !a.intent) a.intent = "cancel";
      else if ((fresh?.checkpoint as { pause_requested?: string } | undefined)?.pause_requested && !a.intent) a.intent = "user_pause";
      else if (practice && !a.intent) a.intent = "practice";
      if (a.intent && !a.controller.signal.aborted) {
        a.controller.abort(a.intent);
        await this.awaitStop(a);
        if (a.intent === "practice" || a.intent === "cancel") {
          // practice must find the GPU free: prove the release now (unload + /api/ps + VRAM plateau), not on some later tick
          const rel = await this.verifiedRelease(a.models);
          if (rel.verified && this.active === null) this.resident = null;
        }
        return;
      }
      if (nowMs - a.lastHeartbeat >= this.cfg.heartbeatMs) {
        a.lastHeartbeat = nowMs;
        if (!heartbeat(this.db, this.deps, a.job.id, a.token, this.o.instanceId, this.cfg.leaseTimeoutMs)) {
          a.intent = "lease_lost"; // somebody moved the lock on: our result must never commit
          a.controller.abort("lease_lost");
        }
      }
      return;
    }

    this.noteAbandonedModels();
    recoverStale(this.db, this.deps, { timeoutMs: this.cfg.leaseTimeoutMs });

    // paused-by-preemption work comes back when practice is over; a user pause never does
    if (!practice) {
      const paused = this.db.prepare("SELECT id FROM jobs WHERE state = 'paused'").all() as Array<{ id: string }>;
      for (const { id } of paused) {
        if (reasonOfLastEvent(this.db, id, "paused") === "preempted_by_practice") {
          this.db.transaction(() => {
            this.db.prepare("UPDATE jobs SET state = 'queued', available_at = ? WHERE id = ?").run(iso(this.clock.now()), id);
            this.db.prepare("INSERT INTO job_events(id, job_id, sequence, state, reason, created_at) VALUES (?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM job_events WHERE job_id = ?),?,?,?)").run(this.deps.newId(), id, id, "queued", "resumed_after_practice", iso(this.clock.now()));
          }).immediate();
          this.o.onChange?.();
        }
      }
    }

    // free the GPU of an idle resident model (VRAM for the desktop) and always when practice needs it
    if (this.resident && (practice || nowMs - this.resident.lastUsed >= this.cfg.idleUnloadMs)) {
      const rel = await this.verifiedRelease(this.resident.models);
      if (rel.verified) this.resident = null;
    }

    const candidates = this.eligible();
    if (candidates.length === 0) return;
    if (practice) {
      for (const j of candidates) markWaiting(this.db, this.deps, j.id, "practice_active");
      this.o.onChange?.();
      return;
    }
    // A job that cannot run AT ALL (no adapter, no model profile yet) must not block the work queued behind it: park it and try the next one.
    let pool = candidates;
    let job: Job | undefined;
    let runner: JobRunner | undefined;
    while (pool.length > 0) {
      const j = this.pick(pool);
      const rn = this.runners.get(j.kind);
      const unrunnable = !rn ? "no_adapter" : rn.profileKey(j) === null && this.cfg.admission === "profiled" ? "profile_unknown" : null;
      if (unrunnable) {
        markWaiting(this.db, this.deps, j.id, unrunnable);
        pool = pool.filter((x) => x.id !== j.id);
        continue;
      }
      job = j;
      runner = rn;
      break;
    }
    if (!job || !runner) {
      this.o.onChange?.();
      return;
    }
    // switching models: the previous one must be provably gone first (STT and LLM, or two LLMs, are never resident together)
    const needed = runner.ownedModels(job);
    if (this.resident && this.resident.models.some((m) => !needed.includes(m))) {
      const rel = await this.verifiedRelease(this.resident.models);
      if (!rel.verified) {
        markWaiting(this.db, this.deps, job.id, "release_unproven");
        return;
      }
      this.resident = null;
    }
    const wait = await this.admit(job, runner);
    if (wait) {
      markWaiting(this.db, this.deps, job.id, wait);
      this.o.onChange?.();
      return;
    }
    // Practice or shutdown can begin while telemetry or model release is awaited.
    if (this.stopped || this.practiceActive()) return;
    const current = getJob(this.db, job.id);
    if (!current || !["queued", "waiting_for_gpu"].includes(current.state) || current.cancelRequested) return;
    // Takeover of an EXPIRED foreign lease (a crashed or unresponsive previous owner): fencing only stops its stale commits, it does not
    // stop its inference. Before the new owner runs anything, the models the old owner may have been using must be provably gone.
    if (this.takeoverPending()) {
      const rel = await this.verifiedRelease([...new Set([...needed, ...this.abandonedModels])]);
      if (!rel.verified) {
        markWaiting(this.db, this.deps, job.id, "release_unproven");
        this.o.onChange?.();
        return;
      }
      this.abandonedModels.clear();
      if (this.stopped || this.practiceActive()) return;
    }
    const token = this.acquireLease();
    if (token === null) return; // another owner holds a live lease: stay put
    startRunning(this.db, this.deps, job.id, token);
    this.launch(getJob(this.db, job.id)!, token, runner);
    this.o.onChange?.();
  }

  private eligible(): Job[] {
    const now = iso(this.clock.now());
    const rows = this.db.prepare("SELECT id FROM jobs WHERE state IN ('queued','waiting_for_gpu') AND available_at <= ? AND cancel_requested = 0 ORDER BY created_at, rowid").all(now) as Array<{ id: string }>;
    return rows.map((r) => getJob(this.db, r.id)!);
  }

  /**
   * Priority with aging (<= 20) and a 10:1 fairness rule outside practice: after `fairnessEvery` consecutive foreground starts the
   * oldest background job goes next. Lower number = more urgent.
   */
  pick(candidates: Job[]): Job {
    const nowMs = this.clock.now().getTime();
    const score = (j: Job) => j.priority * 100 - Math.min(20, Math.floor((nowMs - Date.parse(j.createdAt)) / 60000));
    const background = candidates.filter((j) => j.priority === 3);
    if (background.length > 0) {
      const recent = this.db.prepare("SELECT priority FROM jobs WHERE started_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT ?").all(this.cfg.fairnessEvery) as Array<{ priority: number }>;
      if (recent.length >= this.cfg.fairnessEvery && recent.every((r) => r.priority < 3)) {
        return [...background].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))[0]!;
      }
    }
    return [...candidates].sort((a, b) => score(a) - score(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))[0]!;
  }

  /** Telemetry + measured-profile admission. Returns the waiting reason, or null when the job may start. */
  private async admit(job: Job, runner: JobRunner): Promise<string | null> {
    const sample = await this.sample();
    if (!sample) return "telemetry_unavailable";
    const key = runner.profileKey(job);
    let need = 0;
    if (!key && this.cfg.admission === "profiled") return "profile_unknown";
    if (key) {
      const prof = this.db.prepare("SELECT measured_peak_mib AS p FROM gpu_profiles WHERE model_version_id = ? AND config_hash = ?").get(key.modelVersionId, key.configHash) as { p: number } | undefined;
      if (!prof) {
        if (this.cfg.admission === "profiled") return "profile_unknown"; // file size is never an admission basis
      } else need = prof.p;
    }
    const free = sample.totalMib - sample.usedMib;
    const alreadyOurs = this.resident ? 1 : 0; // a resident model of ours is part of `used`, not extra demand
    if (!alreadyOurs && need > 0 && free < need + this.cfg.reserveMib) {
      const loaded = await this.o.control.listLoaded().catch(() => null);
      const foreign = (loaded ?? []).filter((m) => !(this.resident?.models ?? []).includes(m));
      return foreign.length > 0 ? "ollama_in_use" : "insufficient_vram";
    }
    return null;
  }

  private async sample(): Promise<GpuSample | null> {
    const s = await this.o.telemetry.sample().catch(() => null);
    if (!s) {
      this.lastSample = null;
      return null;
    }
    if (this.clock.now().getTime() - s.at > this.cfg.telemetryStaleMs) {
      this.lastSample = null; // stale readings are as good as none (spec/07)
      return null;
    }
    this.lastSample = s;
    return s;
  }

  /** models of units left 'running' by a lease holder that is no longer alive: they may still be resident or generating */
  private readonly abandonedModels = new Set<string>();

  private noteAbandonedModels(): void {
    const cutoff = iso(new Date(this.clock.now().getTime() - this.cfg.leaseTimeoutMs));
    const rows = this.db.prepare("SELECT id FROM jobs WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)").all(cutoff) as Array<{ id: string }>;
    for (const { id } of rows) {
      const job = getJob(this.db, id);
      if (!job || job.id === this.active?.job.id) continue;
      for (const m of this.runners.get(job.kind)?.ownedModels(job) ?? []) this.abandonedModels.add(m);
    }
  }

  private takeoverPending(): boolean {
    const lock = this.db.prepare("SELECT owner_id AS owner, lease_until AS until FROM gpu_lock WHERE id = 1").get() as { owner: string | null; until: string | null };
    const foreignExpired = lock.owner !== null && lock.owner !== this.o.instanceId && (lock.until === null || lock.until < iso(this.clock.now()));
    return foreignExpired || this.abandonedModels.size > 0;
  }

  private acquireLease(): number | null {
    const now = iso(this.clock.now());
    const until = iso(new Date(this.clock.now().getTime() + this.cfg.leaseTimeoutMs));
    return this.db
      .transaction((): number | null => {
        const r = this.db.prepare("UPDATE gpu_lock SET owner_id = ?, fencing_token = fencing_token + 1, lease_until = ? WHERE id = 1 AND (owner_id IS NULL OR lease_until IS NULL OR lease_until < ? OR owner_id = ?)").run(this.o.instanceId, until, now, this.o.instanceId);
        if (r.changes !== 1) return null;
        return (this.db.prepare("SELECT fencing_token AS t FROM gpu_lock WHERE id = 1").get() as { t: number }).t;
      })
      .immediate();
  }

  private releaseLease(): void {
    try {
      this.db.prepare("UPDATE gpu_lock SET owner_id = NULL, lease_until = NULL WHERE id = 1 AND owner_id = ?").run(this.o.instanceId);
    } catch {
      /* the database was closed during shutdown: the lease then expires by itself */
    }
  }

  // ---------------------------------------------------------------- running a unit

  private launch(job: Job, token: number, runner: JobRunner): void {
    const controller = new AbortController();
    const models = runner.ownedModels(job);
    const run: ActiveRun = { job, token, runner, controller, intent: null, lastHeartbeat: this.clock.now().getTime(), startedAt: this.clock.now().getTime(), promise: Promise.resolve(), models };
    this.active = run;
    this.resident = { models, lastUsed: this.clock.now().getTime() };
    run.promise = (async () => {
      try {
        const out = await runner.run({ job: job as never, token, signal: controller.signal, checkpoint: (cp) => saveCheckpoint(this.db, job.id, token, cp) });
        if (run.intent) {
          // a stop was requested: whatever the unit produced is discarded, it restarts later (spec/07: pause = abort + restart unit)
          this.settleStopped(run);
        } else {
          try {
            completeJob(this.db, this.deps, job.id, token, out);
          } catch (e) {
            if (!(e instanceof StaleLeaseError)) throw e; // a stale owner's result is dropped silently by design
          }
        }
      } catch (e) {
        await this.settleError(run, e);
      } finally {
        if (this.active === run) this.active = null;
        if (this.resident) this.resident.lastUsed = this.clock.now().getTime();
        if (!this.stopped || !this.resident) this.releaseLease();
        this.o.onChange?.();
      }
    })();
  }

  private settleStopped(run: ActiveRun): void {
    const { job, token } = run;
    switch (run.intent) {
      case "cancel":
        finishCancelled(this.db, this.deps, job.id, token);
        break;
      case "user_pause":
        releaseToQueue(this.db, this.deps, job.id, token, "paused", "user_pause");
        break;
      case "practice":
        releaseToQueue(this.db, this.deps, job.id, token, "paused", "preempted_by_practice");
        break;
      case "shutdown":
        releaseToQueue(this.db, this.deps, job.id, token, "queued", "shutdown");
        break;
      case "lease_lost":
      default:
        break; // recovery owns the job now
    }
  }

  private async settleError(run: ActiveRun, e: unknown): Promise<void> {
    const { job, token } = run;
    if (run.intent) {
      this.settleStopped(run);
      return;
    }
    if (e instanceof StaleLeaseError) return;
    const err = e instanceof RunnerError ? e : new RunnerError("runner_error", e instanceof Error ? e.message : String(e), false);
    if (err.code === "oom") {
      const rel = await this.verifiedRelease(run.models);
      if (rel.verified) this.resident = null;
      const s = await this.sample();
      const key = run.runner.profileKey(job);
      const need = key ? ((this.db.prepare("SELECT measured_peak_mib AS p FROM gpu_profiles WHERE model_version_id = ? AND config_hash = ?").get(key.modelVersionId, key.configHash) as { p: number } | undefined)?.p ?? 0) : 0;
      const pressureGone = s !== null && s.totalMib - s.usedMib >= need + this.cfg.reserveMib;
      if (pressureGone && job.retryCount === 0) failOrRetry(this.db, this.deps, job.id, token, { code: "oom", transient: true });
      else {
        releaseToQueue(this.db, this.deps, job.id, token, "queued", "oom_pressure");
        markWaiting(this.db, this.deps, job.id, "oom_pressure");
      }
      return;
    }
    failOrRetry(this.db, this.deps, job.id, token, { code: err.code, transient: err.transient, diagnosticCodes: err.diagnosticCodes });
  }

  /** Waits for a unit to settle within `ms`, polling the clock in small steps (no dangling long timers, deterministic under a fake clock). */
  private async settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    const end = this.clock.now().getTime() + ms;
    while (!settled && this.clock.now().getTime() < end) await this.clock.sleep(100);
    return settled;
  }

  private async awaitStop(a: ActiveRun): Promise<void> {
    const grace = a.intent === "practice" ? this.cfg.practiceGraceMs : this.cfg.teardownBoundMs;
    if (await this.settledWithin(a.promise, grace)) return;
    // closing a socket does not prove inference stopped: unload the OWNED model and wait for the unit to end
    await this.verifiedRelease(a.models);
    await this.settledWithin(a.promise, this.cfg.teardownBoundMs);
  }

  private async stopActive(intent: StopIntent): Promise<void> {
    const a = this.active;
    if (!a) return;
    if (!a.intent) a.intent = intent;
    if (!a.controller.signal.aborted) a.controller.abort(intent);
    await this.awaitStop(a);
  }

  /** unload owned models, then require: /api/ps shows none of them AND the VRAM reading is flat for N samples. */
  async verifiedRelease(models: string[]): Promise<Release> {
    const start = this.clock.now().getTime();
    for (const m of models) await this.o.control.unload(m).catch(() => undefined);
    const samples: number[] = [];
    while (this.clock.now().getTime() - start <= this.cfg.teardownBoundMs) {
      const loaded = await this.o.control.listLoaded().catch(() => null);
      const absent = loaded !== null && !models.some((m) => loaded.includes(m));
      const s = await this.sample();
      if (s) samples.push(s.usedMib);
      const tail = samples.slice(-this.cfg.plateauSamples);
      const plateau = tail.length >= this.cfg.plateauSamples && Math.max(...tail) - Math.min(...tail) <= this.cfg.plateauToleranceMib;
      if (absent && plateau) return { verified: true, elapsedMs: this.clock.now().getTime() - start, samples: samples.length };
      await this.clock.sleep(500);
    }
    return { verified: false, elapsedMs: this.clock.now().getTime() - start, samples: samples.length };
  }

  /** Stop admission, abort and discard the running unit, prove the release, give the lease back. Never touches foreign processes. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.active) await this.stopActive("shutdown");
    if (this.resident) {
      const rel = await this.verifiedRelease(this.resident.models);
      if (rel.verified) this.resident = null;
    }
    // Do not advertise an uncooperative active unit as released.
    if (!this.active && !this.resident) this.releaseLease();
  }

  // ---------------------------------------------------------------- reporting

  async status(): Promise<GpuStatus> {
    const lock = this.db.prepare("SELECT owner_id AS owner, fencing_token AS token, lease_until AS until FROM gpu_lock WHERE id = 1").get() as { owner: string | null; token: number; until: string | null };
    const s = await this.sample();
    const waiting: Record<string, number> = {};
    for (const j of this.db.prepare("SELECT id FROM jobs WHERE state IN ('waiting_for_gpu','paused')").all() as Array<{ id: string }>) {
      const r = reasonOfLastEvent(this.db, j.id) ?? "unknown";
      waiting[r] = (waiting[r] ?? 0) + 1;
    }
    const nowMs = this.clock.now().getTime();
    return {
      owner: lock.owner,
      fencingToken: lock.token,
      leaseUntil: lock.until,
      activeJob: this.active ? { id: this.active.job.id, kind: this.active.job.kind, state: "running", runningForMs: nowMs - this.active.startedAt } : null,
      residentModels: this.resident?.models ?? [],
      practiceActive: this.practiceActive(),
      reserveMib: this.cfg.reserveMib,
      telemetry: s ? { usedMib: s.usedMib, totalMib: s.totalMib, freeMib: s.totalMib - s.usedMib, ageMs: nowMs - s.at } : "unavailable",
      waitingByReason: waiting,
      admission: this.cfg.admission,
    };
  }

  /** test/ops hook: wait for the running unit (if any) to settle */
  async idle(): Promise<void> {
    while (this.active) await this.active.promise;
  }
}
