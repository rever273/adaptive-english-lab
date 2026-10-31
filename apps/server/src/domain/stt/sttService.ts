import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import type { GpuScheduler } from "../../queue/scheduler.js";
import { SttError, MAX_PCM_BYTES, type SttReady, type Transcription } from "../../adapters/stt/sttWorker.js";
import { assertLease } from "../sessions/lease.js";
import type { SessionDeps } from "../sessions/policy.js";
import { createTranscript, upsertModelVersion } from "../attempts/transcripts.js";

export const MAX_SECONDS = 60;
export const SAMPLE_RATE = 16000;
const DRAFT_TTL_MS = 10 * 60_000;
export const STT_MODEL = { tag: "faster-whisper-small", runtime: "ctranslate2", runtimeVersion: "faster-whisper 1.2.1", parameters: { language: "en", compute_type: "int8_float16", vad_filter: true, beam_size: 1 } } as const;

interface SpeechWorker { readonly alive: boolean; start(): Promise<SttReady>; transcribe(pcm: Buffer): Promise<Transcription>; stop(): Promise<number | null>; }

interface Stream {
  id: string;
  sessionId: string;
  tabId: string;
  worker: SpeechWorker;
  ready: SttReady;
  lastUsed: number;
  modelDir: string;
}
interface Draft {
  sessionId: string;
  text: string;
  at: number;
  used: boolean;
}

export interface SttServiceOptions {
  db: Db;
  deps: SessionDeps;
  /** the single GPU dispatcher: a voice session takes the card before anything is loaded */
  scheduler: Pick<GpuScheduler, "beginPractice" | "endPractice">;
  /** creates a worker, or null when no local STT model exists on this machine */
  createWorker: () => { worker: SpeechWorker; modelPath: string } | null;
  available: () => boolean;
  idleMs?: number;
  cloud?: boolean;
}

/**
 * Voice capture for ONE practice session (spec/07). Audio exists only in memory between the browser request and the decode; this class and
 * everything below it write no audio anywhere. A draft is text only; it becomes a transcript row only when the learner confirms the (possibly
 * edited) text. When the voice session ends, idles out, loses its lease or the worker dies, the child process is stopped and the card is given back.
 */
export class SttService {
  private stream: Stream | null = null;
  private starting: Promise<unknown> | null = null;
  private startingSession: string | null = null;
  private startingWorker: SpeechWorker | null = null;
  private generation = 0;
  private stopped = false;
  private readonly drafts = new Map<string, Draft>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: SttServiceOptions) {}

  /** local weights exist (for /capabilities). It says nothing about the card being free right now. */
  available(): boolean {
    return this.o.available();
  }

  get active(): { streamId: string; sessionId: string } | null {
    return this.stream ? { streamId: this.stream.id, sessionId: this.stream.sessionId } : null;
  }

  async start(sessionId: string, tabId: string): Promise<{ streamId: string; maxSeconds: number; maxBytes: number; sampleRate: number; ready: SttReady }> {
    if (this.stopped) throw new ApiError(503, "STT_STOPPED", "Speech recognition is shutting down.");
    assertLease(this.o.db, this.o.deps, sessionId, tabId); // only the tab that holds the practice lease may use the microphone
    if (this.starting) throw new ApiError(409, "STT_BUSY", "Speech is already being prepared");
    if (this.stream) {
      if (this.stream.sessionId === sessionId && this.stream.tabId === tabId && this.stream.worker.alive) return this.describe(this.stream);
      await this.close(this.stream, "replaced");
    }
    if (!this.o.available()) throw new ApiError(503, "STT_UNAVAILABLE", "No local speech model is installed. Type your answer instead.");
    const generation = this.generation;
    const cancelled = () => this.stopped || generation !== this.generation;
    this.startingSession = sessionId;
    const run = (async (): Promise<Stream> => {
      // 1. the card: stop and unload any background model, and PROVE it before loading anything (single dispatcher)
      const grant = this.o.cloud ? { ready: true, reason: null } : await this.o.scheduler.beginPractice();
      if (cancelled()) {
        if (!this.o.cloud) this.o.scheduler.endPractice();
        throw new ApiError(409, "STT_START_CANCELLED", "Speech preparation was cancelled.");
      }
      if (!grant.ready) {
        if (!this.o.cloud) this.o.scheduler.endPractice();
        throw new ApiError(503, "STT_PREPARING", "The graphics card is not free yet. Type your answer or try again in a moment.", { reason: grant.reason });
      }
      // 2. the worker is created only now that the card is proven free; ready only after a REAL warm-up
      const made = this.o.createWorker();
      if (!made) {
        if (!this.o.cloud) this.o.scheduler.endPractice();
        throw new ApiError(503, "STT_UNAVAILABLE", "No local speech model is installed. Type your answer instead.");
      }
      this.startingWorker = made.worker;
      let ready: SttReady;
      try {
        ready = await made.worker.start();
      } catch (e) {
        await made.worker.stop().catch(() => undefined);
        if (!this.o.cloud) this.o.scheduler.endPractice();
        throw new ApiError(503, "STT_START_FAILED", "Speech recognition could not start. Type your answer instead.", { reason: e instanceof SttError ? e.code : "unknown" });
      }
      try {
        if (cancelled()) throw new Error("cancelled");
        assertLease(this.o.db, this.o.deps, sessionId, tabId);
        const session = this.o.db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string } | undefined;
        if (session?.status !== "active") throw new Error("session ended");
      } catch {
        await made.worker.stop().catch(() => undefined);
        if (!this.o.cloud) this.o.scheduler.endPractice();
        throw new ApiError(409, "STT_START_CANCELLED", "Speech preparation was cancelled.");
      }
      return { id: randomUUID(), sessionId, tabId, worker: made.worker, ready, lastUsed: Date.now(), modelDir: made.modelPath };
    })();
    this.starting = run;
    try {
      this.stream = await run;
    } finally {
      this.starting = null;
      this.startingSession = null;
      this.startingWorker = null;
    }
    this.watch();
    return this.describe(this.stream);
  }

  private describe(s: Stream) {
    return { streamId: s.id, maxSeconds: MAX_SECONDS, maxBytes: MAX_PCM_BYTES, sampleRate: SAMPLE_RATE, ready: s.ready };
  }

  private need(streamId: string): Stream {
    if (!this.stream || this.stream.id !== streamId) throw new ApiError(404, "STT_STREAM_NOT_FOUND", "There is no open voice session. Start it again or type your answer.");
    return this.stream;
  }

  async transcribe(streamId: string, pcm: Buffer): Promise<{ draftId: string; text: string; audioSeconds: number; decodeSeconds: number }> {
    const s = this.need(streamId);
    try {
      assertLease(this.o.db, this.o.deps, s.sessionId, s.tabId);
    } catch (e) {
      await this.close(s, "lease_lost");
      throw e;
    }
    s.lastUsed = Date.now();
    try {
      const r = await s.worker.transcribe(pcm);
      if (this.stream !== s) throw new ApiError(409, "STT_STREAM_CLOSED", "Speech session ended before transcription completed.");
      assertLease(this.o.db, this.o.deps, s.sessionId, s.tabId);
      this.gc();
      const draftId = randomUUID();
      this.drafts.set(draftId, { sessionId: s.sessionId, text: r.text, at: Date.now(), used: false });
      return { draftId, text: r.text, audioSeconds: r.audioSeconds, decodeSeconds: r.decodeSeconds };
    } catch (e) {
      if (e instanceof SttError) {
        if (["too_short", "too_long", "odd_length"].includes(e.code)) throw new ApiError(422, `AUDIO_${e.code.toUpperCase()}`, e.message);
        await this.close(s, e.code); // a worker that failed, died or stopped answering is ended: the card must not stay occupied
        throw new ApiError(503, "STT_WORKER_FAILED", "Speech recognition stopped working. Type your answer instead.", { reason: e.code });
      }
      throw e;
    }
  }

  /** Learner confirmed the text (edited or not): store TEXT ONLY and return the transcript id for the attempt. */
  confirm(streamId: string, draftId: string, slotId: string, submittedText: string): { transcriptId: string; edited: boolean } {
    const s = this.need(streamId);
    const d = this.drafts.get(draftId);
    if (!d || d.sessionId !== s.sessionId || d.used) throw new ApiError(404, "DRAFT_NOT_FOUND", "That voice draft is gone. Record again or type your answer.");
    const text = submittedText.trim();
    if (text.length === 0) throw new ApiError(422, "TEXT_EMPTY", "The text is empty");
    const model = this.o.cloud ? { tag: "whisper-large-v3", runtime: "groq", runtimeVersion: "api", digest: "provider-managed", parameters: { language: "en", temperature: 0 } } : { ...STT_MODEL, digest: path.basename(s.modelDir), parameters: { ...STT_MODEL.parameters } };
    const sttModelId = upsertModelVersion(this.o.db, this.o.deps.newId, model);
    const transcriptId = createTranscript(this.o.db, { sessionId: s.sessionId, slotId, asrText: d.text, submittedText: text, sttModelId, newId: this.o.deps.newId, now: this.o.deps.now });
    d.used = true;
    return { transcriptId, edited: d.text !== text };
  }

  async stop(streamId: string): Promise<void> {
    const s = this.stream;
    if (s && s.id === streamId) await this.close(s, "stopped");
  }
  /** the practice session ended (finish, expiry): free the microphone side at once */
  async stopForSession(sessionId: string): Promise<void> {
    if (this.starting && this.startingSession === sessionId) {
      this.generation++;
      if (this.startingWorker) await this.startingWorker.stop().catch(() => undefined);
      await this.starting.catch(() => undefined);
    }
    if (this.stream?.sessionId === sessionId) await this.close(this.stream, "session_ended");
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.generation++;
    if (this.startingWorker) await this.startingWorker.stop().catch(() => undefined);
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream) await this.close(this.stream, "shutdown");
  }

  private async close(s: Stream, _why: string): Promise<void> {
    if (this.stream?.id === s.id) this.stream = null;
    for (const [id, d] of this.drafts) if (d.sessionId === s.sessionId && !d.used && _why !== "stopped") this.drafts.delete(id);
    await s.worker.stop().catch(() => undefined);
    if (!this.o.cloud) this.o.scheduler.endPractice();
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, d] of this.drafts) if (now - d.at > DRAFT_TTL_MS) this.drafts.delete(id);
  }

  private watch(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const s = this.stream;
      if (!s) return;
      const idle = Date.now() - s.lastUsed > (this.o.idleMs ?? 120_000);
      let leaseOk = true;
      try {
        assertLease(this.o.db, this.o.deps, s.sessionId, s.tabId);
      } catch {
        leaseOk = false;
      }
      const ended = (this.o.db.prepare("SELECT status FROM sessions WHERE id = ?").get(s.sessionId) as { status: string } | undefined)?.status !== "active";
      if (idle || !leaseOk || ended || !s.worker.alive) void this.close(s, idle ? "idle" : "ended");
    }, 2000);
    this.timer.unref?.();
  }
}
