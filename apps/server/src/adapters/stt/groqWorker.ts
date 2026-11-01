import { MAX_PCM_BYTES, MIN_PCM_BYTES, SttError, type SttReady, type Transcription } from "./sttWorker.js";

/** the rate-limit headers Groq sent with the latest transcription (memory only, lost on restart); Groq has no credits endpoint */
export const groqLimits: { capturedAt: string | null; status: number | null; headers: Record<string, string> } = { capturedAt: null, status: null, headers: {} };
function rememberLimits(response: Response): void {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { if (/^(x-ratelimit-|retry-after$)/.test(k)) headers[k] = v; });
  groqLimits.capturedAt = new Date().toISOString(); groqLimits.status = response.status; groqLimits.headers = headers;
}

/** Sends memory-only PCM as a WAV to Groq. No audio files or API responses are logged. */
export class GroqWorker {
  private controller: AbortController | null = null;
  private running = false;
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch) {}
  get alive(): boolean { return this.running; }
  async start(): Promise<SttReady> {
    this.running = true;
    return { pid: 0, loadSeconds: 0, warmupSeconds: 0, device: "groq", computeType: "cloud" };
  }
  async transcribe(pcm: Buffer): Promise<Transcription> {
    if (!this.running) throw new SttError("not_running", "Speech recognition is not running");
    if (pcm.length % 2) throw new SttError("odd_length", "audio must be 16-bit samples");
    if (pcm.length < MIN_PCM_BYTES) throw new SttError("too_short", "that recording is too short");
    if (pcm.length > MAX_PCM_BYTES) throw new SttError("too_long", "that recording is too long");
    if (this.controller) throw new SttError("busy", "a transcription is already in progress");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(header), new Uint8Array(pcm)], { type: "audio/wav" }), "speech.wav");
    body.set("model", "whisper-large-v3"); body.set("language", "en"); body.set("temperature", "0"); body.set("response_format", "json");
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 30000); timeout.unref();
    const started = Date.now();
    try {
      const response = await this.request("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${this.key}` }, body, signal: controller.signal });
      rememberLimits(response);
      if (!response.ok) throw new SttError(response.status === 429 ? "rate_limited" : response.status === 401 ? "authentication_failed" : "provider_error", "Groq transcription failed");
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string" || data.text.length > 10000) throw new SttError("bad_response", "Groq returned an invalid response");
      return { text: data.text, audioSeconds: pcm.length / 32000, decodeSeconds: (Date.now() - started) / 1000 };
    } catch (e) {
      if (e instanceof SttError) throw e;
      throw new SttError("provider_unavailable", "Groq transcription is unavailable");
    } finally { clearTimeout(timeout); this.controller = null; }
  }
  async stop(): Promise<null> { this.running = false; this.controller?.abort(); return null; }
}
