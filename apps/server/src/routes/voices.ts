import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { VoicePurposeSchema, VoiceSettingsUpdateSchema, type VoiceInfo, type VoicesResponse } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import type { DictationEnv } from "../domain/typing/dictation/lessons.js";
import { modelShaOpt } from "../domain/voices/model.js";
import { sampleStats } from "../domain/voices/sampleStats.js";
import type { VoiceListing } from "../domain/voices/service.js";

/**
 * A fixed phrase, so voices can be compared by ear and the audio is cached. One sentence on purpose: a short first sentence ("Good morning.")
 * followed by a full stop made the voices produce a hum in the pause, worst when the pace was stretched.
 */
export const SAMPLE_TEXT = "I reckon we should leave before the traffic gets heavy.";
const SAMPLE_WORDS = 10;
const SAMPLE_SYLLABLES = 14;

const keyParams = { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 80 } }, required: ["key"] } as const;
const Query = z.object({ purpose: VoicePurposeSchema.optional() }).strict();
/** a pace not saved yet, so a change can be heard before it is kept */
const SampleQuery = z.object({ lengthScale: z.coerce.number().min(0.7).max(1.8).optional() }).strict();

const toInfo = (v: VoiceListing): VoiceInfo => ({
  key: v.key,
  name: v.name,
  gender: v.gender,
  ageGroup: v.ageGroup,
  impression: v.impression,
  enabled: v.enabled,
  purposes: v.purposes,
  avoidGroups: v.avoidGroups,
  lengthScale: v.lengthScale,
  noiseScale: v.noiseScale,
  noiseWScale: v.noiseWScale,
  maxSpeedUp: v.maxSpeedUp,
  revision: v.revision,
  source: v.source,
  checks: v.checks,
  heardRate: v.heardRate === null ? null : Math.round(v.heardRate * 1000) / 10,
  flags: v.flags,
  weight: v.weight,
  share: Math.round(v.share * 1000) / 10,
});

export interface VoiceRouteOptions {
  env: DictationEnv;
  /** where the cached sample phrases are kept (synthetic audio only) */
  sampleDir: string;
}

/** Settings → Voices (TASK_029): the voices with their weights, a settings revision per change, and a sample phrase to listen to. */
export function registerVoiceRoutes(app: FastifyInstance, db: Db, o: VoiceRouteOptions): void {
  const { env } = o;
  const list = (purpose: z.infer<typeof VoicePurposeSchema>): VoicesResponse => ({ purpose, voices: env.voices.list(db, { purpose, ...modelShaOpt(env.tts) }).map(toInfo) });

  app.get("/api/v1/voices", async (req) => {
    const q = Query.safeParse(req.query);
    if (!q.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid");
    return list(q.data.purpose ?? "dictation");
  });

  app.get<{ Params: { key: string } }>("/api/v1/voices/:key/history", { schema: { params: keyParams } }, async (req) => {
    if (!env.voices.byKey(db, req.params.key)) throw new ApiError(404, "VOICE_NOT_FOUND", "There is no such voice");
    return { revisions: env.voices.history(db, req.params.key) };
  });

  // a change is a new settings revision (older ones stay); the weights shown come back with the answer
  app.patch<{ Params: { key: string } }>("/api/v1/voices/:key/settings", { schema: { params: keyParams } }, async (req) => {
    const b = VoiceSettingsUpdateSchema.safeParse(req.body);
    if (!b.success) throw new ApiError(400, "VALIDATION_ERROR", b.error.issues[0]?.message ?? "Settings are invalid");
    env.voices.updateSettings(db, req.params.key, b.data);
    return list("dictation");
  });

  app.get<{ Params: { key: string } }>("/api/v1/voices/:key/sample", { schema: { params: keyParams } }, async (req, reply) => {
    const voice = env.voices.byKey(db, req.params.key);
    if (!voice) throw new ApiError(404, "VOICE_NOT_FOUND", "There is no such voice");
    const tts = env.tts.available();
    if (!tts.ok) throw new ApiError(409, "VOICE_SAMPLE_UNAVAILABLE", tts.reason === "tts_not_installed" ? "Piper is not installed. Run npm run dictation:setup." : "The Piper voice model is missing. Run npm run dictation:setup.");
    const q = SampleQuery.safeParse(req.query);
    if (!q.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid");
    const params = { ...env.voices.synthesisParams(voice), ...(q.data.lengthScale !== undefined ? { lengthScale: q.data.lengthScale } : {}) };
    const name = `${createHash("sha256").update(JSON.stringify([voice.key, params, SAMPLE_TEXT, tts.modelSha256])).digest("hex")}.wav`;
    const file = path.join(o.sampleDir, name);
    if (!existsSync(file)) {
      let wav: Buffer;
      try {
        wav = await env.tts.synthesize({ text: SAMPLE_TEXT, ...params, signal: AbortSignal.timeout(60_000) });
      } catch {
        throw new ApiError(502, "VOICE_SAMPLE_FAILED", "The voice engine could not read the sample.");
      }
      mkdirSync(o.sampleDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, wav);
      renameSync(tmp, file);
    }
    const bytes = readFileSync(file);
    const stats = sampleStats(bytes, SAMPLE_WORDS, SAMPLE_SYLLABLES);
    reply.header("Cache-Control", "no-store").type("audio/wav");
    if (stats) reply.header("X-Sample-Stats", JSON.stringify({ ...stats, lengthScale: params.lengthScale }));
    return reply.send(bytes);
  });
}
