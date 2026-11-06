import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/** The check every synthesised sentence must pass (D97): the audio is transcribed and compared with the text. Synthetic audio only, never the learner's voice. */
export interface DictationAsr {
  available(): boolean;
  transcribe(wav: Buffer, signal: AbortSignal): Promise<{ text: string; model: string }>;
  stop(): Promise<void>;
}

export class AsrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/** Groq `whisper-large-v3` (D66), used whenever a key is set. A 429 is transient. */
export class GroqDictationAsr implements DictationAsr {
  /** Groq's free whisper limit is about 20 requests a minute: calls are spaced out instead of failing with 429 */
  private last = 0;
  private gate: Promise<void> = Promise.resolve();
  constructor(
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  available(): boolean {
    return this.key.length > 0;
  }
  private spaced(signal: AbortSignal): Promise<void> {
    const next = this.gate.then(async () => {
      const wait = this.last + 3000 - Date.now();
      if (wait > 0) await new Promise<void>((resolve) => { const t = setTimeout(resolve, wait); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
      this.last = Date.now();
    });
    this.gate = next.catch(() => undefined);
    return next;
  }
  async transcribe(wav: Buffer, signal: AbortSignal): Promise<{ text: string; model: string }> {
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "dictation.wav");
    body.set("model", "whisper-large-v3");
    body.set("language", "en");
    body.set("temperature", "0");
    body.set("response_format", "json");
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.spaced(signal);
      try {
        response = await this.request("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${this.key}` }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new AsrError("asr_unreachable", "Groq transcription is unreachable", true);
      }
      if (response.status !== 429) break;
      this.last = Date.now() + Math.min(20, Number(response.headers.get("retry-after")) || 10) * 1000; // wait as asked, then try again
    }
    if (!response) throw new AsrError("asr_unreachable", "Groq transcription is unreachable", true);
    if (response.status === 429) throw new AsrError("asr_rate_limited", "Groq is limiting requests", true);
    if (response.status === 401) throw new AsrError("asr_auth", "Groq rejected the key", false);
    if (!response.ok) throw new AsrError("asr_provider", `Groq answered HTTP ${response.status}`, true);
    const data = (await response.json().catch(() => null)) as { text?: unknown } | null;
    if (!data || typeof data.text !== "string") throw new AsrError("asr_bad_response", "Groq returned an invalid response", true);
    return { text: data.text, model: "groq/whisper-large-v3" };
  }
  async stop(): Promise<void> {}
}

/** the cached faster-whisper large-v3 weights (never downloads) */
export function findLargeV3(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ENGLISHLAB_DICTATION_ASR_MODEL_PATH;
  if (explicit) return existsSync(path.join(explicit, "model.bin")) ? explicit : null;
  const hub = path.join(env.HF_HOME ?? path.join(os.homedir(), ".cache", "huggingface"), "hub", "models--Systran--faster-whisper-large-v3", "snapshots");
  try {
    for (const snap of readdirSync(hub)) if (existsSync(path.join(hub, snap, "model.bin"))) return path.join(hub, snap);
  } catch {
    /* no cache */
  }
  return null;
}

/** Local fallback: workers/dictation_asr/check.py (faster-whisper large-v3), one JSON line each way. Small is not accurate enough for this check. */
export class LocalDictationAsr implements DictationAsr {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<number, (m: Record<string, unknown>) => void>();
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  constructor(private readonly o: { script: string; env?: NodeJS.ProcessEnv; idleMs?: number }) {}

  available(): boolean {
    return existsSync(this.o.script) && findLargeV3(this.o.env) !== null;
  }

  private start(): Promise<void> {
    const custom = (this.o.env ?? process.env).ENGLISHLAB_PYTHON;
    const [command, ...pre] = custom ? [custom] : process.platform === "win32" ? ["py", "-3.11"] : ["python3.11"];
    const child = spawn(command!, [...pre, this.o.script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...this.o.env, HF_HUB_OFFLINE: "1", PYTHONUNBUFFERED: "1" } });
    this.child = child;
    child.stderr.resume();
    return new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout }).on("line", (line) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (m.event === "ready") resolve();
        else if (m.event === "error") reject(new AsrError("asr_unavailable", String(m.error ?? "the local checker failed to start"), false));
        else if (typeof m.id === "number") this.waiting.get(m.id)?.(m);
      });
      child.once("exit", () => {
        this.child = null;
        this.ready = null;
        for (const w of this.waiting.values()) w({ ok: false, error: "worker_exited" });
        this.waiting.clear();
        reject(new AsrError("asr_exited", "the local checker exited", true));
      });
      child.once("error", (e) => {
        this.child = null;
        this.ready = null; // a later request may try again (Python could be fixed meanwhile)
        reject(new AsrError("asr_spawn_failed", e.message, false));
      });
    });
  }

  transcribe(wav: Buffer, signal: AbortSignal): Promise<{ text: string; model: string }> {
    const run = async (): Promise<{ text: string; model: string }> => {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      this.ready ??= this.start();
      await this.ready;
      this.touch();
      const id = ++this.seq;
      const answer = new Promise<Record<string, unknown>>((resolve) => this.waiting.set(id, resolve));
      this.child!.stdin.write(`${JSON.stringify({ id, wav: wav.toString("base64") })}\n`);
      const onAbort = () => void this.stop();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const m = await answer;
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (m.ok !== true) throw new AsrError("asr_failed", String(m.error ?? "the local checker failed"), true);
        return { text: String(m.text ?? ""), model: "faster-whisper-large-v3" };
      } finally {
        signal.removeEventListener("abort", onAbort);
        this.waiting.delete(id);
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), this.o.idleMs ?? 5 * 60_000);
    this.idle.unref?.();
  }

  async stop(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.stdin.write(`${JSON.stringify({ op: "shutdown" })}\n`);
      child.stdin.end();
    } catch {
      /* pipe closed */
    }
    const timer = setTimeout(() => child.kill(), 3000);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }
}

/** Groq when a key is set (D66), otherwise the local large-v3; `available()` is false when neither exists (D97: no check, no lesson). */
export function chooseDictationAsr(o: { groqKey?: string; script: string }): DictationAsr {
  const groq = o.groqKey ? new GroqDictationAsr(o.groqKey) : null;
  const local = new LocalDictationAsr({ script: o.script });
  return {
    available: () => groq !== null || local.available(),
    transcribe: (wav, signal) => (groq ?? local).transcribe(wav, signal),
    stop: async () => {
      await local.stop();
    },
  };
}
