import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Result of one decode. Audio is never part of it: only text and timings. */
export interface Transcription {
  text: string;
  audioSeconds: number;
  decodeSeconds: number;
}
export interface SttReady {
  pid: number;
  loadSeconds: number;
  warmupSeconds: number;
  device: string;
  computeType: string;
}
export class SttError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SttLaunch {
  command: string;
  args: string[];
  /** extra environment for the child (it also gets HF_HUB_OFFLINE=1) */
  env?: NodeJS.ProcessEnv;
}

export const MAX_PCM_BYTES = 2 * 1024 * 1024;
export const MIN_PCM_BYTES = 3200;

/**
 * One local STT child process (workers/stt/worker.py). The server owns it: it starts it, waits for a REAL warm-up ("ready"), serialises
 * decodes through the framed stdin/stdout protocol, and on stop terminates only its own child and waits for the exit. PCM goes straight
 * from memory into the pipe; nothing here touches the file system.
 */
export class SttWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private exitPromise: Promise<number | null> | null = null;
  private stopping: Promise<number | null> | null = null;
  private exited = false;
  ready: SttReady | null = null;
  /** diagnostic only: stderr lines of the child (they never carry audio) */
  stderrTail: string[] = [];

  constructor(
    private readonly launch: SttLaunch,
    private readonly opts: { startTimeoutMs?: number; decodeTimeoutMs?: number } = {},
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }
  get alive(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Spawns the child and resolves when it reports `ready` (model loaded AND first decode done). */
  start(): Promise<SttReady> {
    if (this.child) return Promise.reject(new SttError("already_started", "worker already started"));
    const child = spawn(this.launch.command, this.launch.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...this.launch.env, HF_HUB_OFFLINE: "1", PYTHONUNBUFFERED: "1" } });
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code) => {
        this.exited = true;
        this.fail(new SttError("worker_exited", `the speech worker exited (${code})`));
        resolve(code);
      });
      child.once("error", (e) => {
        this.exited = true;
        this.fail(new SttError("spawn_failed", e.message));
        resolve(null);
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      this.stderrTail = [...this.stderrTail, ...d.split(/\r?\n/).filter(Boolean)].slice(-20);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // stdout is reserved for protocol lines; anything else is ignored
      }
      this.pending?.resolve(msg);
      this.pending = null;
    });
    return this.expect(this.opts.startTimeoutMs ?? 120_000, "start_timeout").then((m) => {
      if (m.event !== "ready") throw new SttError(String(m.error ?? "start_failed"), `the speech worker did not become ready (${String(m.error ?? "unknown")})`);
      this.ready = { pid: Number(m.pid), loadSeconds: Number(m.loadSeconds), warmupSeconds: Number(m.warmupSeconds), device: String(m.device), computeType: String(m.computeType) };
      return this.ready;
    });
  }

  /** One decode at a time; a second call waits for the first. */
  transcribe(pcm: Buffer): Promise<Transcription> {
    const run = async (): Promise<Transcription> => {
      if (!this.alive || !this.ready) throw new SttError("not_running", "the speech worker is not running");
      if (pcm.length % 2 !== 0) throw new SttError("odd_length", "audio must be 16-bit samples");
      if (pcm.length < MIN_PCM_BYTES) throw new SttError("too_short", "that recording is too short");
      if (pcm.length > MAX_PCM_BYTES) throw new SttError("too_long", "that recording is too long");
      const waiting = this.expect(this.opts.decodeTimeoutMs ?? 30_000, "decode_timeout");
      this.child!.stdin.write(`${JSON.stringify({ op: "transcribe", bytes: pcm.length })}\n`);
      this.child!.stdin.write(pcm);
      const m = await waiting;
      if (m.ok !== true) throw new SttError(String(m.error ?? "decode_failed"), `decode failed (${String(m.error ?? "unknown")})`);
      return { text: String(m.text ?? ""), audioSeconds: Number(m.audioSeconds), decodeSeconds: Number(m.decodeSeconds) };
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Asks politely, then terminates OUR child only. Resolves with the exit code once the process is really gone. */
  async stop(graceMs = 3000): Promise<number | null> {
    if (!this.stopping) this.stopping = this.stopChild(graceMs);
    return this.stopping;
  }

  private async stopChild(graceMs: number): Promise<number | null> {
    const child = this.child;
    if (!child || !this.exitPromise) return null;
    if (!this.exited) {
      try {
        child.stdin.write(`${JSON.stringify({ op: "shutdown" })}\n`);
        child.stdin.end();
      } catch {
        /* pipe already closed */
      }
      const timer = setTimeout(() => child.kill(), graceMs);
      timer.unref?.();
      const code = await this.exitPromise;
      clearTimeout(timer);
      return code;
    }
    return this.exitPromise;
  }

  private expect(ms: number, code: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new SttError("busy", "a request is already in flight"));
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new SttError(code, `the speech worker did not answer within ${Math.round(ms / 1000)} s`));
        // a worker that stops answering is dropped: its process is ended so the GPU is freed
        this.child?.kill();
      }, ms);
      this.pending = {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
    });
  }

  private fail(e: Error): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(e);
  }
}
