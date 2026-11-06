import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export const PIPER_MODEL_NAME = "en_AU-librivox-medium";
const IDLE_STOP_MS = 5 * 60_000;

export type TtsUnavailable = "tts_not_installed" | "tts_model_missing";
export class TtsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient = true,
  ) {
    super(message);
  }
}

/** The text-to-speech side of Audio Dictation. The synthesised audio is the product; no learner speech goes through here. */
export interface TtsClient {
  available(): { ok: true; modelSha256: string } | { ok: false; reason: TtsUnavailable };
  /** WAV bytes */
  synthesize(input: { text: string; speakerId: number; lengthScale: number; noiseScale?: number; noiseWScale?: number; signal: AbortSignal }): Promise<Buffer>;
  stop(): Promise<void>;
  /** starts the engine ahead of the first request (optional) */
  warm?(): Promise<void>;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/**
 * Piper (GPL-3.0-or-later) runs as its own local HTTP process from its own venv (D84): this project never imports it. The process starts
 * on the first request, listens on 127.0.0.1 only, takes about 300 MB of RAM and no VRAM, and stops after ~5 idle minutes or with the app.
 */
export class PiperClient implements TtsClient {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private sha: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  stderrTail: string[] = [];

  constructor(private readonly o: { python: string; modelDir: string; fetchFn?: typeof fetch; idleMs?: number }) {}

  available(): { ok: true; modelSha256: string } | { ok: false; reason: TtsUnavailable } {
    if (!existsSync(this.o.python)) return { ok: false, reason: "tts_not_installed" };
    const model = path.join(this.o.modelDir, `${PIPER_MODEL_NAME}.onnx`);
    if (!existsSync(model) || !existsSync(`${model}.json`)) return { ok: false, reason: "tts_model_missing" };
    return { ok: true, modelSha256: (this.sha ??= this.modelHash(model)) };
  }

  /** the manifest written by `npm run dictation:setup` already holds the hash; hashing 77 MB is only the fallback */
  private modelHash(model: string): string {
    try {
      const manifest = JSON.parse(readFileSync(path.join(this.o.modelDir, "manifest.json"), "utf8")) as { files?: Record<string, string> };
      const known = manifest.files?.[`${PIPER_MODEL_NAME}.onnx`];
      if (typeof known === "string" && /^[0-9a-f]{64}$/.test(known)) return known;
    } catch {
      /* no manifest */
    }
    return createHash("sha256").update(readFileSync(model)).digest("hex");
  }

  private async ensureStarted(signal: AbortSignal): Promise<number> {
    if (this.port !== null && this.child && this.child.exitCode === null) return this.port;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    const port = await this.starting;
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return port;
  }

  private async start(): Promise<number> {
    const port = await freePort();
    const child = spawn(this.o.python, ["-m", "piper.http_server", "-m", PIPER_MODEL_NAME, "--data-dir", this.o.modelDir, "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const note = (d: Buffer) => {
      this.stderrTail = [...this.stderrTail, ...d.toString("utf8").split(/\r?\n/).filter(Boolean)].slice(-20);
    };
    child.stdout?.on("data", note);
    child.stderr?.on("data", note);
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
    });
    child.once("error", () => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
    });
    this.child = child;
    const request = this.o.fetchFn ?? fetch;
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new TtsError("tts_exited", `the speech engine exited: ${this.stderrTail.slice(-3).join(" | ").slice(0, 300)}`);
      try {
        const r = await request(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > 90_000) {
        child.kill();
        throw new TtsError("tts_start_timeout", "the speech engine did not start in 90 s");
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.port = port;
    return port;
  }

  async warm(): Promise<void> {
    await this.ensureStarted(new AbortController().signal);
    this.touch();
  }

  synthesize(input: { text: string; speakerId: number; lengthScale: number; noiseScale?: number; noiseWScale?: number; signal: AbortSignal }): Promise<Buffer> {
    // one request at a time: the engine is a small single-threaded server
    const run = async (): Promise<Buffer> => {
      if (input.signal.aborted) throw new DOMException("aborted", "AbortError");
      const port = await this.ensureStarted(input.signal);
      this.touch();
      let response: Response;
      try {
        response = await (this.o.fetchFn ?? fetch)(`http://127.0.0.1:${port}/synthesize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: input.text, speaker_id: input.speakerId, length_scale: input.lengthScale, ...(input.noiseScale !== undefined ? { noise_scale: input.noiseScale } : {}), ...(input.noiseWScale !== undefined ? { noise_w_scale: input.noiseWScale } : {}) }),
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]),
        });
      } catch (e) {
        if (input.signal.aborted) throw e;
        throw new TtsError("tts_unreachable", "could not reach the speech engine");
      }
      if (!response.ok) throw new TtsError("tts_failed", `the speech engine answered HTTP ${response.status}`);
      this.touch();
      return Buffer.from(await response.arrayBuffer());
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), this.o.idleMs ?? IDLE_STOP_MS);
    this.idle.unref?.();
  }

  /** stops OUR engine process and its children */
  async stop(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    this.port = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  }
}
