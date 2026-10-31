import { MEASURED_ADDITIONAL_PEAK_MIB } from "../domain/ai/config.js";

export type ResidencyState = "unloaded" | "loading" | "ready" | "unloading" | "error";

export interface LoadedModelInfo {
  name: string;
  sizeVramBytes: number | null;
  contextLength: number | null;
}

/** The model server as the residency service sees it. Only the application's own model is ever passed in. */
export interface ModelHost {
  loadedInfo(): Promise<LoadedModelInfo[] | null>;
  load(model: string, o: { keepAlive: string; numCtx: number; signal?: AbortSignal }): Promise<void>;
  unload(model: string): Promise<void>;
}

/** The dispatcher's side (GpuScheduler): the residency service never starts or stops a model behind its back. */
export interface ResidencyDispatcher {
  practiceActive(): boolean;
  /** the unit currently holding the model, or null */
  activeJob(): { kind: string } | null;
  vramShortfall(peakMib: number): Promise<string | null>;
  noteModelLoaded(models: string[]): void;
  noteModelReleased(): void;
  kick(): void;
}

export interface ModelStatus {
  state: ResidencyState;
  model: string;
  loadedSince: string | null;
  lastLoadMs: number | null;
  vramBytes: number | null;
  /** reason of the last failure while state is `error` */
  error: string | null;
  /** why a load/unload would be refused right now (a unit holds the model, local speech needs the card, a transition runs) */
  busy: "job_running" | "practice_active" | "loading" | "unloading" | null;
  preloadOnStart: boolean;
}

export type ResidencyRefusal = "job_running" | "practice_active" | "loading" | "unloading" | "shutting_down" | "insufficient_vram" | "auto_disabled";
export type Begin = { ok: true; done: Promise<void> } | { ok: false; reason: ResidencyRefusal };

export interface ResidencyOptions {
  host: ModelHost;
  dispatcher: ResidencyDispatcher;
  model: string;
  numCtx: number;
  keepAlive: string;
  /** the setting preloadModelOnStart (read at every decision, so a change applies at once) */
  preloadEnabled: () => boolean;
  /** false while routing is off (digest drift, AI runners disabled): the server then never loads the model by itself */
  autoAllowed?: () => boolean;
  now?: () => Date;
  /** bound for the ps check that proves an unload */
  unloadVerifyMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const IDLE_WARM_MS = 30 * 60_000;
const IDLE_COLD_MS = 60_000;

/**
 * Residency of the ONE local model (D67): unloaded | loading | ready | unloading | error. The truth is Ollama's /api/ps (so a model dropped
 * by keep_alive expiry or by hand is noticed); `loading`/`unloading`/`error` are the service's own transient facts. load() is idempotent;
 * unload() is refused while a unit holds the model. While a transition runs the dispatcher starts no unit (`transitioning()`).
 */
export class ModelResidency {
  private transient: "loading" | "unloading" | null = null;
  private error: string | null = null;
  private loadedSince: string | null = null;
  private lastLoadMs: number | null = null;
  private loading: Promise<void> | null = null;
  private loadAbort: AbortController | null = null;
  private shuttingDown = false;
  /** the learner unloaded by hand: automatic warm-up stays off until a manual load (or a restart) */
  private suppressAuto = false;
  /** the learner loaded by hand: the model is kept warm even when the setting is off */
  private manualHold = false;
  private lastAutoAt = 0;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: ResidencyOptions) {
    this.now = o.now ?? (() => new Date());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** a load/unload is in flight: the dispatcher must not start a unit now */
  transitioning(): boolean {
    return this.transient !== null;
  }

  /** how long the dispatcher keeps an idle model: warm while the learner wants it warm, otherwise freed soon (VRAM for the desktop) */
  idleUnloadMs(): number {
    return this.o.preloadEnabled() || this.manualHold ? IDLE_WARM_MS : IDLE_COLD_MS;
  }

  private busy(): ModelStatus["busy"] {
    if (this.transient) return this.transient;
    if (this.o.dispatcher.activeJob()) return "job_running";
    if (this.o.dispatcher.practiceActive()) return "practice_active";
    return null;
  }

  async status(): Promise<ModelStatus> {
    const base = { model: this.o.model, preloadOnStart: this.o.preloadEnabled() };
    if (this.transient) return { ...base, state: this.transient, loadedSince: this.loadedSince, lastLoadMs: this.lastLoadMs, vramBytes: null, error: null, busy: this.transient };
    const list = await this.o.host.loadedInfo();
    const mine = list?.find((m) => m.name === this.o.model) ?? null;
    if (this.transient) return this.status(); // a transition began while the server was asked
    const busy = this.busy();
    if (mine) {
      this.loadedSince ??= this.now().toISOString();
      this.error = null;
      return { ...base, state: "ready", loadedSince: this.loadedSince, lastLoadMs: this.lastLoadMs, vramBytes: mine.sizeVramBytes, error: null, busy };
    }
    this.loadedSince = null;
    if (list === null) return { ...base, state: "error", loadedSince: null, lastLoadMs: this.lastLoadMs, vramBytes: null, error: "model_server_unreachable", busy };
    if (this.error) return { ...base, state: "error", loadedSince: null, lastLoadMs: this.lastLoadMs, vramBytes: null, error: this.error, busy };
    return { ...base, state: "unloaded", loadedSince: null, lastLoadMs: this.lastLoadMs, vramBytes: null, error: null, busy };
  }

  // ---------------------------------------------------------------- load

  /** Idempotent. `auto` = started by the server (start-up, learner activity): honours the setting and a manual unload. */
  load(opts: { auto?: boolean } = {}): Begin {
    if (this.shuttingDown) return { ok: false, reason: "shutting_down" };
    if (opts.auto && (!this.o.preloadEnabled() || this.suppressAuto || this.o.autoAllowed?.() === false)) return { ok: false, reason: "auto_disabled" };
    if (this.transient === "unloading") return { ok: false, reason: "unloading" };
    if (this.loading) return { ok: true, done: this.loading };
    // a running unit owns the model: its own chat call loads it, a second /api/generate or a VRAM check would only get in its way
    if (this.o.dispatcher.activeJob()) return { ok: true, done: Promise.resolve() };
    if (this.o.dispatcher.practiceActive()) return { ok: false, reason: "practice_active" }; // local speech recognition owns the card
    if (!opts.auto) {
      this.suppressAuto = false;
      this.manualHold = true;
    }
    this.transient = "loading";
    this.error = null;
    const ctl = new AbortController();
    this.loadAbort = ctl;
    const done = this.runLoad(ctl.signal).finally(() => {
      this.loading = null;
      this.loadAbort = null;
      this.transient = null;
      this.o.dispatcher.kick();
    });
    this.loading = done;
    return { ok: true, done };
  }

  private async runLoad(signal: AbortSignal): Promise<void> {
    const started = Date.now();
    try {
      const resident = (await this.o.host.loadedInfo())?.some((m) => m.name === this.o.model) ?? false;
      if (!resident) {
        const peak = MEASURED_ADDITIONAL_PEAK_MIB[this.o.model];
        const short = peak === undefined ? null : await this.o.dispatcher.vramShortfall(peak);
        if (short) {
          this.error = short;
          return;
        }
        if (signal.aborted) return;
        await this.o.host.load(this.o.model, { keepAlive: this.o.keepAlive, numCtx: this.o.numCtx, signal });
        const after = await this.o.host.loadedInfo();
        if (!after?.some((m) => m.name === this.o.model)) {
          this.error = "model_not_resident_after_load";
          return;
        }
        this.lastLoadMs = Date.now() - started;
        this.loadedSince = this.now().toISOString();
      }
      this.o.dispatcher.noteModelLoaded([this.o.model]);
    } catch (e) {
      this.error = signal.aborted ? null : (e as Error).message.slice(0, 200) || "load_failed"; // stopped on purpose (practice, shutdown): not a failure
    }
  }

  // ---------------------------------------------------------------- unload

  /** Refused (and says why) while a unit holds the model, a load runs or local speech needs the card. Verified through /api/ps. */
  unload(opts: { manual?: boolean } = { manual: true }): Begin {
    if (this.transient === "loading") return { ok: false, reason: "loading" };
    if (this.transient === "unloading") return { ok: true, done: this.unloading ?? Promise.resolve() };
    if (this.o.dispatcher.activeJob()) return { ok: false, reason: "job_running" };
    this.transient = "unloading";
    this.error = null;
    if (opts.manual !== false) {
      this.suppressAuto = true;
      this.manualHold = false;
    }
    const done = this.runUnload().finally(() => {
      this.unloading = null;
      this.transient = null;
      this.o.dispatcher.kick();
    });
    this.unloading = done;
    return { ok: true, done };
  }
  private unloading: Promise<void> | null = null;

  private async runUnload(): Promise<void> {
    try {
      await this.o.host.unload(this.o.model).catch(() => undefined);
      const end = Date.now() + (this.o.unloadVerifyMs ?? 15_000);
      for (;;) {
        const list = await this.o.host.loadedInfo();
        if (list !== null && !list.some((m) => m.name === this.o.model)) {
          this.loadedSince = null;
          this.o.dispatcher.noteModelReleased();
          return;
        }
        if (Date.now() >= end) {
          this.error = list === null ? "model_server_unreachable" : "unload_not_confirmed";
          return;
        }
        await this.sleep(300);
      }
    } catch (e) {
      this.error = (e as Error).message.slice(0, 200) || "unload_failed";
    }
  }

  // ---------------------------------------------------------------- triggers

  /** Server start: warm the model in the background when the setting asks for it. Never blocks start-up. */
  warmOnStart(): void {
    if (this.o.preloadEnabled()) this.load({ auto: true });
  }

  /**
   * The learner is probably about to practise (dashboard, practice, vocabulary, session creation). Cheap and synchronous: an attempt is
   * made at most every 20 s, and never when the setting is off, after a manual unload, or while a load/unload runs.
   */
  noteActivity(): void {
    if (this.shuttingDown || this.transient || !this.o.preloadEnabled() || this.suppressAuto) return;
    if (this.o.autoAllowed?.() === false || this.probing) return;
    const t = this.now().getTime();
    if (t - this.lastAutoAt < 20_000) return;
    this.lastAutoAt = t;
    // already in memory: nothing to do, and no flash of "loading" (which would also block an unload with a 409)
    this.probing = true;
    void this.o.host
      .loadedInfo()
      .then((list) => {
        if (list?.some((m) => m.name === this.o.model)) return;
        this.load({ auto: true });
      })
      .catch(() => undefined)
      .finally(() => (this.probing = false));
  }
  private probing = false;

  /**
   * Local speech recognition needs the card: stop a load in flight and wait until it has ended. Returns the model name when a load was
   * aborted (the caller must prove it is gone from the card), otherwise an empty list.
   */
  async abortLoad(): Promise<string[]> {
    const l = this.loading;
    if (!l) return [];
    this.loadAbort?.abort();
    await l.catch(() => undefined);
    return [this.o.model];
  }

  // ---------------------------------------------------------------- shutdown

  /** No new load starts from now on (the shutdown has begun); a load in progress is aborted. */
  halt(): void {
    this.shuttingDown = true;
    this.loadAbort?.abort();
  }

  /** Graceful stop: abort a load in progress and unload the model (bounded; never hangs the shutdown). The dispatcher has already stopped its unit. */
  async shutdown(boundMs = 10_000): Promise<void> {
    this.halt();
    const work = (async () => {
      if (this.loading) await this.loading.catch(() => undefined);
      if (this.unloading) await this.unloading.catch(() => undefined);
      try {
        await this.o.host.unload(this.o.model);
      } catch {
        /* keep_alive expiry frees the card if this fails */
      }
    })();
    await Promise.race([work, new Promise<void>((r) => setTimeout(r, boundMs).unref?.())]);
  }
}
