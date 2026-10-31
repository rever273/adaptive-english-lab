import type { Job, JobKind } from "../../../apps/server/src/queue/jobs.js";
import { RunnerError, type Clock, type GpuSample, type JobRunner, type ModelControl, type RunnerContext, type RunnerOutput, type TelemetryProvider } from "../../../apps/server/src/queue/types.js";

export const flush = () => new Promise<void>((r) => setImmediate(r));

/** Virtual time: sleeping advances the clock, then yields a macrotask so pending promise chains settle first. */
export class FakeClock implements Clock {
  constructor(public current = new Date("2026-10-28T01:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  async sleep(ms: number): Promise<void> {
    await flush();
    this.advance(ms);
    await flush();
  }
}

/** One fake card: telemetry and the model server share the same truth, with an optional lag before VRAM drops after an unload. */
export class FakeGpu implements TelemetryProvider, ModelControl {
  loaded = new Map<string, number>();
  baseMib = 1900;
  totalMib = 16311;
  /** simulate telemetry that is unavailable (null) or stale (old timestamp) */
  telemetry: "ok" | "unavailable" | "stale" = "ok";
  psReachable = true;
  failUnload = false;
  /** samples still showing the old usage after an unload (VRAM release lag) */
  releaseLagSamples = 0;
  private lag = 0;
  private lagMib = 0;
  readonly unloads: string[] = [];
  /** hooks fired on unload (a forced unload is what really ends an inference that ignored its abort) */
  onUnload: Array<(model: string) => void> = [];
  foreignMib = 0;

  constructor(private readonly clock: FakeClock) {}

  load(model: string, mib: number): void {
    this.loaded.set(model, mib);
  }
  get usedMib(): number {
    return this.baseMib + this.foreignMib + [...this.loaded.values()].reduce((a, b) => a + b, 0) + (this.lag > 0 ? this.lagMib : 0);
  }
  async sample(): Promise<GpuSample | null> {
    if (this.telemetry === "unavailable") return null;
    const s: GpuSample = { usedMib: this.usedMib, totalMib: this.totalMib, at: this.clock.now().getTime() - (this.telemetry === "stale" ? 60_000 : 0) };
    if (this.lag > 0) this.lag--;
    return s;
  }
  async listLoaded(): Promise<string[] | null> {
    return this.psReachable ? [...this.loaded.keys()] : null;
  }
  async unload(model: string): Promise<void> {
    this.unloads.push(model);
    if (this.failUnload) throw new Error("unload failed");
    for (const h of this.onUnload) h(model);
    const mib = this.loaded.get(model) ?? 0;
    this.loaded.delete(model);
    if (this.releaseLagSamples > 0) {
      this.lag = this.releaseLagSamples;
      this.lagMib = mib;
    }
  }
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

export type Behaviour = "gate" | "instant" | "transient" | "fatal" | "oom" | "ignore_abort";

/** A scriptable GPU workload. Tracks concurrency so tests can prove "at most one active unit". */
export class FakeRunner implements JobRunner {
  active = 0;
  maxActive = 0;
  readonly started: string[] = [];
  readonly aborted: string[] = [];
  readonly completed: string[] = [];
  behaviour: Behaviour | ((job: Job) => Behaviour) = "instant";
  gates = new Map<string, Deferred>();
  model = "fake-model:1";
  mib = 6000;
  profile: { modelVersionId: string; configHash: string } | null = null;
  constructor(
    readonly kind: JobKind,
    private readonly gpu: FakeGpu,
  ) {}

  gate(jobId: string): Deferred {
    let g = this.gates.get(jobId);
    if (!g) this.gates.set(jobId, (g = deferred()));
    return g;
  }
  ownedModels(): string[] {
    return [this.model];
  }
  profileKey() {
    return this.profile;
  }
  async run(ctx: RunnerContext): Promise<RunnerOutput> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.push(ctx.job.id);
    this.gpu.load(this.model, this.mib);
    this.gpu.onUnload.push(() => this.gates.get(ctx.job.id)?.resolve());
    const b = typeof this.behaviour === "function" ? this.behaviour(ctx.job) : this.behaviour;
    try {
      if (b === "transient") throw new RunnerError("net_blip", "temporary", true);
      if (b === "fatal") throw new RunnerError("bad_input", "cannot be done", false);
      if (b === "oom") throw new RunnerError("oom", "out of memory", false);
      if (b === "gate" || b === "ignore_abort") {
        const g = this.gate(ctx.job.id);
        await new Promise<void>((resolve, reject) => {
          g.promise.then(resolve, reject);
          if (b === "gate") ctx.signal.addEventListener("abort", () => (this.aborted.push(ctx.job.id), reject(new Error("aborted"))), { once: true });
          else ctx.signal.addEventListener("abort", () => this.aborted.push(ctx.job.id), { once: true });
        });
      }
      this.completed.push(ctx.job.id);
      return { schemaVersion: "test-v1", output: { ok: true, job: ctx.job.id }, metrics: { fake: true } };
    } finally {
      this.active--;
    }
  }
}

/** The model server as the residency service sees it (D67): resident model + scriptable load/unload. */
export class FakeModelHost {
  resident = new Set<string>();
  loads = 0;
  unloads = 0;
  loadGate: Deferred | null = null;
  failLoad: string | null = null;
  /** the model stays in /api/ps after an unload request */
  stickyUnload = false;
  reachable = true;
  async loadedInfo() {
    return this.reachable ? [...this.resident].map((name) => ({ name, sizeVramBytes: 10 * 1024 ** 3, contextLength: 8192 })) : null;
  }
  async load(model: string, o?: { signal?: AbortSignal }): Promise<void> {
    this.loads++;
    if (o?.signal?.aborted) throw new Error("aborted");
    if (this.loadGate) {
      const aborted = new Promise<never>((_, rej) => o?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
      await Promise.race([this.loadGate.promise, aborted]);
    }
    if (this.failLoad) throw new Error(this.failLoad);
    this.resident.add(model);
  }
  async unload(model: string): Promise<void> {
    this.unloads++;
    if (!this.stickyUnload) this.resident.delete(model);
  }
}

/** The dispatcher's side of the hand-shake, scriptable. */
export class FakeDispatcher {
  practice = false;
  job: { kind: string } | null = null;
  shortfall: string | null = null;
  loadedNotes = 0;
  releasedNotes = 0;
  kicks = 0;
  practiceActive() {
    return this.practice;
  }
  activeJob() {
    return this.job;
  }
  async vramShortfall() {
    return this.shortfall;
  }
  noteModelLoaded() {
    this.loadedNotes++;
  }
  noteModelReleased() {
    this.releasedNotes++;
  }
  kick() {
    this.kicks++;
  }
}
