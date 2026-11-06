import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { Db } from "../db/open.js";
import type { DictationEnv } from "../domain/typing/dictation/lessons.js";
import { modelShaOpt } from "../domain/voices/model.js";

const Body = z.object({ text: z.string().min(2).max(700), sessionId: z.string().min(1).max(64), paragraph: z.number().int().min(0).max(100000) }).strict();

/** at most this many sentences / bytes stay in memory (a temporary cache: nothing is written to disk, nothing survives a restart) */
const CACHE_ENTRIES = 40;
const CACHE_BYTES = 24 * 1024 * 1024;

/** what Piper is given: plain readable text (no control characters, one line) */
export const speakable = (text: string): string => text.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Books: hear a sentence of the book (the previous one) in a Piper voice, made on the spot. One voice for a whole paragraph (picked from the
 * paragraph, so it differs between paragraphs); the audio lives only in a small in-memory cache.
 */
export function registerTypingBookSpeechRoutes(app: FastifyInstance, db: Db, env: DictationEnv): void {
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  let bytes = 0;
  const remember = (key: string, wav: Buffer) => {
    cache.set(key, wav);
    bytes += wav.length;
    while (cache.size > CACHE_ENTRIES || bytes > CACHE_BYTES) {
      const oldest = cache.keys().next().value as string;
      bytes -= cache.get(oldest)!.length;
      cache.delete(oldest);
    }
  };
  const ready = () => {
    const a = env.tts.available();
    if (!a.ok) throw new ApiError(409, "BOOK_SPEECH_UNAVAILABLE", a.reason === "tts_not_installed" ? "Piper is not installed. Run npm run dictation:setup." : "The Piper voice model is missing. Run npm run dictation:setup.");
  };

  // starts the voice engine in the background so the first sentence does not wait for it
  app.post("/api/v1/typing/books/speech/warm", async (_req, reply) => {
    if (env.tts.available().ok) void env.tts.warm?.().catch(() => {});
    reply.code(202);
    return { ok: true };
  });

  const speak = async (req: FastifyRequest, reply: FastifyReply) => {
    const practice = req.url === "/api/v1/practice/speech";
    const parsed = practice ? z.object({ text: z.string().min(2).max(700) }).strict().safeParse(req.body) : Body.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Expected the sentence, the session and the paragraph number");
    ready();
    const text = speakable(parsed.data.text);
    if (text.length < 2) throw new ApiError(400, "VALIDATION_ERROR", "Nothing to read");
    const voice = env.voices.pick(db, { purpose: practice ? "listening" : "books", seed: "sessionId" in parsed.data && "paragraph" in parsed.data ? `${parsed.data.sessionId}:${parsed.data.paragraph}` : randomUUID(), ...modelShaOpt(env.tts) });
    if (!voice) throw new ApiError(409, "BOOK_SPEECH_UNAVAILABLE", "No voice is enabled.");
    const params = env.voices.synthesisParams(voice);
    const key = createHash("sha256").update(`${voice.id}|${params.lengthScale}|${params.noiseScale ?? ""}|${params.noiseWScale ?? ""}|${text}`).digest("hex");
    let wav = cache.get(key);
    if (!wav) {
      let task = pending.get(key);
      if (!task) {
        task = env.tts.synthesize({ text, ...params, signal: AbortSignal.timeout(60_000) });
        pending.set(key, task);
        void task.finally(() => pending.delete(key)).catch(() => {});
      }
      try {
        wav = await task;
      } catch {
        throw new ApiError(502, "BOOK_SPEECH_FAILED", "The voice engine could not read this sentence.");
      }
      if (!cache.has(key)) remember(key, wav);
    }
    reply.header("Cache-Control", "no-store").type("audio/wav");
    return reply.send(wav);
  };
  app.post("/api/v1/typing/books/speech", speak);
  app.post("/api/v1/practice/speech", speak);
}
