import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { getFeedback } from "../domain/sessions/feedback.js";
import { getEntry } from "../domain/vocabulary/repository.js";
import type { SessionDeps } from "../domain/sessions/policy.js";

const DAY = 86_400_000;
const MODEL = "eleven_multilingual_v2";
type Options = { key?: string; voiceId?: string; cacheDir: string; request?: typeof fetch };

/** Generated audio is shared by the dictionary and practice, never keyed by user-provided file paths. */
export function registerVocabularySpeechRoutes(app: FastifyInstance, db: Db, deps: SessionDeps, options: Options): void {
  const pending = new Map<string, Promise<Buffer>>();
  const request = options.request ?? fetch;
  // The old provider's cooldown is not an ElevenLabs limit. Preserve usage history but count the new provider separately.
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM vocabulary_speech_requests WHERE slot_id = 'eleven:init'").get()) {
      db.prepare("UPDATE vocabulary_speech_settings SET blocked_until = NULL WHERE id = 1").run();
      db.prepare("INSERT INTO vocabulary_speech_requests(slot_id, lemma, requested_at) VALUES ('eleven:init', '', ?)").run(deps.now().toISOString());
    }
  }).immediate();
  const status = () => {
    const now = deps.now();
    const settings = db.prepare("SELECT enabled, blocked_until AS blockedUntil FROM vocabulary_speech_settings WHERE id = 1").get() as { enabled: number; blockedUntil: string | null };
    const oldest = new Date(now.getTime() - DAY).toISOString();
    const count = (db.prepare("SELECT COUNT(*) AS n FROM vocabulary_speech_requests WHERE slot_id LIKE 'eleven:req:%' AND requested_at > ?").get(oldest) as { n: number }).n;
    return { enabled: !!settings.enabled, configured: !!options.key && !!options.voiceId, requests: count, blockedUntil: settings.blockedUntil && settings.blockedUntil > now.toISOString() ? settings.blockedUntil : null };
  };
  app.get("/api/v1/vocabulary-speech", async () => status());
  /** the account's character credits from ElevenLabs (needs the key's "user_read" permission) plus what this app has sent itself */
  app.get("/api/v1/vocabulary-speech/credits", async () => {
    const since = new Date(deps.now().getTime() - 30 * DAY).toISOString();
    const appCharacters30d = (db.prepare("SELECT COALESCE(SUM(LENGTH(lemma)), 0) AS n FROM vocabulary_speech_requests WHERE slot_id LIKE 'eleven:req:%' AND requested_at > ?").get(since) as { n: number }).n;
    if (!options.key) return { available: false, reason: "No ElevenLabs API key is set.", appCharacters30d };
    try {
      const response = await request("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": options.key }, signal: AbortSignal.timeout(10000) });
      if (response.status === 401 || response.status === 403) return { available: false, reason: "The key cannot read the subscription: enable the “User → Read” permission for this API key in ElevenLabs.", appCharacters30d };
      if (!response.ok) return { available: false, reason: `ElevenLabs did not return the credits (HTTP ${response.status}).`, appCharacters30d };
      const s = await response.json() as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number | null; tier?: string };
      if (typeof s.character_count !== "number" || typeof s.character_limit !== "number") return { available: false, reason: "ElevenLabs returned an unexpected answer.", appCharacters30d };
      return { available: true, used: s.character_count, limit: s.character_limit, remaining: Math.max(0, s.character_limit - s.character_count), resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null, tier: s.tier ?? null, appCharacters30d };
    } catch { return { available: false, reason: "Could not reach ElevenLabs.", appCharacters30d }; }
  });
  app.post<{ Body: { enabled?: unknown } }>("/api/v1/vocabulary-speech/settings", async (req) => {
    if (typeof req.body?.enabled !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", "Expected enabled as a boolean");
    db.prepare("UPDATE vocabulary_speech_settings SET enabled = ? WHERE id = 1").run(req.body.enabled ? 1 : 0);
    return status();
  });
  async function speak(word: string, automatic: boolean, reply: FastifyReply) {
    if (automatic && !status().enabled) return reply.code(204).send();
    const text = word.trim().replace(/\s+/g, " ");
    if (!text || text.length > 200) throw new ApiError(400, "SPEECH_INVALID", "Word is not available for pronunciation");
    if (!options.voiceId) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "ElevenLabs voice ID is missing.");
    const hash = createHash("sha256").update(JSON.stringify([options.voiceId, MODEL, text.toLowerCase()])).digest("hex");
    const file = path.join(options.cacheDir, `${hash}.mp3`);
    async function load(): Promise<Buffer> {
      try { const data = await readFile(file); if (data.length) return data; } catch { /* cache miss */ }
      if (!options.key) throw new ApiError(503, "SPEECH_NOT_CONFIGURED", "ElevenLabs API key is missing.");
      if (status().blockedUntil) throw new ApiError(429, "SPEECH_RATE_LIMIT", "ElevenLabs is temporarily rate limited.");
      db.prepare("INSERT INTO vocabulary_speech_requests(slot_id, lemma, requested_at) VALUES (?, ?, ?)").run(`eleven:req:${randomUUID()}`, text.toLowerCase(), deps.now().toISOString());
      let response: Response;
      try {
        response = await request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voiceId!)}/stream?output_format=mp3_44100_128`, { method: "POST", headers: { "xi-api-key": options.key, "Content-Type": "application/json" }, body: JSON.stringify({ text, model_id: MODEL }), signal: AbortSignal.timeout(30000) });
      } catch { throw new ApiError(502, "SPEECH_UNAVAILABLE", "Could not reach ElevenLabs."); }
      if (!response.ok) {
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"));
          const until = new Date(deps.now().getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000)).toISOString();
          db.prepare("UPDATE vocabulary_speech_settings SET blocked_until = ? WHERE id = 1").run(until);
          throw new ApiError(429, "SPEECH_RATE_LIMIT", "ElevenLabs limit reached; try again later.");
        }
        if (response.status === 401 || response.status === 403) throw new ApiError(502, "SPEECH_ACCESS", "ElevenLabs rejected the key or its text-to-speech permission.");
        throw new ApiError(502, "SPEECH_PROVIDER", `ElevenLabs could not generate audio (HTTP ${response.status}).`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length || data.length > 10_000_000) throw new ApiError(502, "SPEECH_PROVIDER", "ElevenLabs returned invalid audio.");
      await mkdir(options.cacheDir, { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, data); await rename(temp, file); } finally { await rm(temp, { force: true }); }
      return data;
    }
    let task = pending.get(hash);
    if (!task) { task = load(); pending.set(hash, task); void task.finally(() => pending.delete(hash)).catch(() => {}); }
    const audio = await task;
    return reply.header("Cache-Control", "no-store").type("audio/mpeg").send(audio);
  }
  app.post<{ Params: { sessionId: string; slotId: string } }>("/api/v1/vocabulary-speech/:sessionId/:slotId", async (req, reply) => {
    const { sessionId, slotId } = req.params;
    if (!db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(sessionId)) throw new ApiError(404, "SESSION_NOT_FOUND", "Not a vocabulary session");
    const feedback = getFeedback(db, deps, sessionId, slotId);
    const word = feedback.correct && feedback.vocabulary?.sentence?.form;
    if (!word) return reply.code(204).send();
    return speak(word, true, reply);
  });
  app.post<{ Params: { id: string } }>("/api/v1/vocabulary-speech/word/:id", async (req, reply) => speak(getEntry(db, req.params.id).lemma, false, reply));
}
