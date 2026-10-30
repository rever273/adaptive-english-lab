import type { Job, JobKind } from "./jobs.js";

export interface GpuSample {
  usedMib: number;
  totalMib: number;
  /** epoch ms of the reading */
  at: number;
}

/** Read-only GPU telemetry. `null` = unavailable (never "0 used"): admission then waits (telemetry_unavailable). */
export interface TelemetryProvider {
  sample(): Promise<GpuSample | null>;
}

/**
 * The model server (Ollama) as the dispatcher sees it. Only models this app started are ever unloaded; foreign models and other
 * processes are never touched (spec/07: "не освобождать чужую модель/процесс").
 */
export interface ModelControl {
  /** names of models currently resident; null when the server cannot be asked */
  listLoaded(): Promise<string[] | null>;
  /** explicit unload (keep_alive=0) of one OWNED model */
  unload(model: string): Promise<void>;
}

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

export interface RunnerContext<P = unknown> {
  job: Job & { payload: P };
  token: number;
  /** aborted for user pause, cancel, practice preemption, lost lease or shutdown: the runner must stop issuing work promptly */
  signal: AbortSignal;
  /** durable progress of a multi-item job; the scheduler stores it under the fencing token */
  checkpoint(cp: unknown): void;
}

export interface RunnerOutput {
  schemaVersion: string;
  output: unknown;
  metrics?: Record<string, unknown>;
  /** extra rows committed atomically with the result (annotations etc.); must be pure DB work */
  alsoCommit?: (db: import("../db/open.js").Db) => void;
}

/** One GPU workload. Registered per job kind; the domain never calls a model server directly. */
export interface JobRunner<P = unknown> {
  kind: JobKind;
  /** models this runner keeps resident while it works; released (verified) when the dispatcher needs the GPU */
  ownedModels(job: Job): string[];
  /** model identity for the measured-profile lookup; null = no profile needed */
  profileKey(job: Job): { modelVersionId: string; configHash: string } | null;
  run(ctx: RunnerContext<P>): Promise<RunnerOutput>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface SchedulerConfig {
  /** free VRAM that must remain after the job's measured peak (spec/07: 2048 MiB, minimum 1024) */
  reserveMib: number;
  heartbeatMs: number;
  leaseTimeoutMs: number;
  /** grace before an abort of a running unit during practice preparation */
  practiceGraceMs: number;
  /** bound for proving a release before "Preparing speech" is reported */
  teardownBoundMs: number;
  telemetryStaleMs: number;
  plateauSamples: number;
  plateauToleranceMib: number;
  /** every Nth start must go to the oldest background job when one waits (10:1) */
  fairnessEvery: number;
  /** how long an idle resident model is kept before it is unloaded (VRAM for the desktop) */
  idleUnloadMs: number;
  /** `profiled`: a job without a measured profile never starts; `spike`: controlled measurement runs only (benchmark/verify) */
  admission: "profiled" | "spike";
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  reserveMib: 2048,
  heartbeatMs: 5000,
  leaseTimeoutMs: 30000,
  practiceGraceMs: 3000,
  teardownBoundMs: 15000,
  telemetryStaleMs: 5000,
  plateauSamples: 2,
  plateauToleranceMib: 64,
  fairnessEvery: 10,
  idleUnloadMs: 60000,
  admission: "profiled",
};
