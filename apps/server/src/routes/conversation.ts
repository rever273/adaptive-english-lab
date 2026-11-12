import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import type { SttService } from "../domain/stt/sttService.js";
import { conversationState, heartbeatConversation, nextLessonTopic, pauseConversation, resumeConversation, startConversation, submitConversation, type ConversationDeps } from "../domain/conversation/repository.js";
import { applyAction } from "../queue/jobs.js";
import type { DictationEnv } from "../domain/typing/dictation/lessons.js";
import { modelShaOpt } from "../domain/voices/model.js";
import { speakable } from "./typingBookSpeech.js";
import { checkedConversationSpeech } from "../domain/conversation/speech.js";
import { createHash } from "node:crypto";
import { AsrError, type DictationAsr } from "../domain/typing/dictation/asr.js";
import { conversationAnalytics } from "../domain/conversation/analytics.js";

const id = z.string().uuid();
const tab = z.object({ tabId: id }).strict();
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", "Invalid conversation request.");
  return r.data;
}

export function registerConversationRoutes(app: FastifyInstance, db: Db, deps: ConversationDeps, opts: { topics: readonly { name: string; group: string }[]; onQueued: () => void; stt?: SttService | null; dictation: DictationEnv; asr: DictationAsr }): void {
  const base = "/api/v1/conversations";
  const cache = new Map<string, { sessionId: string; wav: Buffer }>();
  const pending = new Map<string, Promise<Buffer>>();
  let cacheBytes = 0;
  app.get("/api/v1/analytics/conversation", async req => {
    const query = parse(z.object({ days: z.enum(["7", "30", "90", "all"]).default("30") }).strict(), req.query);
    return conversationAnalytics(db, query.days, deps.now().getTime());
  });
  app.get(base, async () => ({
    topics: [...opts.topics].sort(() => Math.random() - 0.5).slice(0, 8).map(x => x.name),
    topicGroups: Object.fromEntries(opts.topics.map(t => [t.name, t.group])),
    latest: db.prepare("SELECT id,topic,mode,(SELECT label FROM conversation_lesson_targets t WHERE t.session_id=s.id AND t.started_at IS NOT NULL ORDER BY ordinal DESC LIMIT 1) AS lessonTarget,updated_at AS updatedAt FROM conversation_sessions s WHERE history_deleted=0 ORDER BY updated_at DESC,rowid DESC LIMIT 1").get() ?? null,
    statistics: db.prepare("SELECT count(*) AS conversations,coalesce(sum(answer_count),0) AS answers,coalesce(sum(active_ms),0) AS activeMs FROM conversation_sessions").get(),
  }));
  app.post(base, async (req) => {
    const b = parse(z.union([z.object({ topic: z.string().min(1).max(200), tabId: id }).strict(), z.object({ mode: z.literal("lesson"), tabId: id }).strict()]), req.body);
    if ("topic" in b && !opts.topics.some(t => t.name === b.topic)) throw new ApiError(400, "UNKNOWN_TOPIC", "Choose one of the suggested topics.");
    const sessionId = "topic" in b ? startConversation(db, deps, b.topic, b.tabId) : startConversation(db, deps, "", b.tabId, "lesson");
    opts.onQueued();
    return conversationState(db, sessionId);
  });
  app.get<{ Params: { id: string } }>(`${base}/:id`, async req => conversationState(db, parse(id, req.params.id)));
  app.post<{ Params: { id: string } }>(`${base}/:id/resume`, async req => { const b = parse(tab, req.body); resumeConversation(db, deps, parse(id, req.params.id), b.tabId); return conversationState(db, req.params.id); });
  app.post<{ Params: { id: string } }>(`${base}/:id/next-topic`, async req => { const b = parse(tab, req.body); nextLessonTopic(db, deps, parse(id, req.params.id), b.tabId); opts.onQueued(); return conversationState(db, req.params.id); });
  app.post<{ Params: { id: string } }>(`${base}/:id/heartbeat`, async req => { const b = parse(tab, req.body); heartbeatConversation(db, deps, parse(id, req.params.id), b.tabId); return { ok: true }; });
  app.post<{ Params: { id: string } }>(`${base}/:id/pause`, async req => { const b = parse(tab, req.body); pauseConversation(db, deps, parse(id, req.params.id), b.tabId); await opts.stt?.stopForSession(req.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>(`${base}/:id/delete-history`, async req => {
    const sessionId = parse(id, req.params.id);
    await opts.stt?.stopForSession(sessionId);
    db.transaction(() => {
      db.prepare("DELETE FROM conversation_messages WHERE session_id=?").run(sessionId);
      db.prepare("UPDATE conversation_sessions SET history_deleted=1,status='paused',tab_id=NULL,heartbeat_at=NULL WHERE id=?").run(sessionId);
    })();
    for (const [key, item] of cache) if (item.sessionId === sessionId) { cacheBytes -= item.wav.length; cache.delete(key); }
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/retry`, async req => {
    const sessionId = parse(id, req.params.id);
    const b = parse(z.object({ jobId: id }).strict(), req.body);
    const job = db.prepare("SELECT id FROM jobs WHERE id=? AND idempotency_key LIKE ? AND state='failed'").get(b.jobId, `conversation:${sessionId}:%`);
    if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "There is no failed request to retry.");
    applyAction(db, deps, b.jobId, "retry"); opts.onQueued(); return { ok: true };
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/messages`, async req => {
    const b = parse(z.object({ tabId: id, messageId: z.string().uuid(), text: z.string().trim().min(1).max(2000) }).strict(), req.body);
    submitConversation(db, deps, parse(id, req.params.id), b.tabId, b.messageId, b.text);
    opts.onQueued();
    return conversationState(db, req.params.id);
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/stt/start`, async req => {
    const b = parse(tab, req.body);
    if (!opts.stt) throw new ApiError(503, "STT_UNAVAILABLE", "Speech is unavailable.");
    return opts.stt.start(parse(id, req.params.id), b.tabId, "conversation");
  });
  app.post<{ Params: { id: string } }>(`${base}/:id/speech`, async (req, reply) => {
    const sessionId = parse(id, req.params.id);
    const b = parse(z.object({ messageId: id }).strict(), req.body);
    const row = db.prepare("SELECT m.text,s.topic FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE m.id=? AND m.session_id=? AND m.role='assistant' AND s.history_deleted=0").get(b.messageId, sessionId) as { text: string; topic: string } | undefined;
    if (!row) throw new ApiError(404, "MESSAGE_NOT_FOUND", "Assistant message not found.");
    const tts = opts.dictation.tts.available();
    if (!tts.ok) throw new ApiError(503, "SPEECH_UNAVAILABLE", "Piper is unavailable.");
    if (!opts.asr.available()) throw new ApiError(503, "SPEECH_CHECK_UNAVAILABLE", "Voice verification is unavailable; the message is still available as text.");
    const topicGroup = opts.topics.find(t => t.name === row.topic)?.group;
    const voice = opts.dictation.voices.pickForConversation(db, { purpose: "listening", seed: `conversation:${row.topic}`, ...(topicGroup ? { topicGroup } : {}), ...modelShaOpt(opts.dictation.tts) });
    if (!voice) throw new ApiError(503, "SPEECH_UNAVAILABLE", "No voice is enabled.");
    // a lesson puts Russian on its own "RU:" lines: the English voice skips them (and Whisper could never confirm them)
    const text = speakable(row.text.split(/\n+/).filter(line => !/[Ѐ-ӿ]/.test(line)).join("\n")).slice(0, 3000), params = opts.dictation.voices.synthesisParams(voice);
    const key = createHash("sha256").update(JSON.stringify([sessionId, b.messageId, text, params, tts.modelSha256, "conversation-asr-v1"])).digest("hex");
    try {
      let wav = cache.get(key)?.wav;
      if (!wav) {
        let task = pending.get(key);
        if (!task) {
          task = checkedConversationSpeech({ text, params, tts: opts.dictation.tts, asr: opts.asr, signal: AbortSignal.timeout(100000) });
          pending.set(key, task);
          void task.finally(() => pending.delete(key)).catch(() => undefined);
        }
        wav = await task;
        if (!db.prepare("SELECT 1 FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE m.id=? AND m.session_id=? AND s.history_deleted=0").get(b.messageId, sessionId)) throw new Error("message_deleted");
        if (!cache.has(key)) { cache.set(key, { sessionId, wav }); cacheBytes += wav.length; }
        while (cache.size > 20 || cacheBytes > 16 * 1024 * 1024) { const first = cache.keys().next().value as string; cacheBytes -= cache.get(first)!.wav.length; cache.delete(first); }
      }
      return reply.header("Cache-Control", "no-store").type("audio/wav").send(wav);
    } catch (e) {
      const reason = e instanceof AsrError ? e.code : e instanceof Error && ["WAV_INVALID", "WAV_LENGTH", "ASR_MISMATCH", "empty_speech", "message_deleted"].includes(e.message) ? e.message : "unavailable";
      req.log.warn({ reason, error: e instanceof Error ? e.message : String(e) }, "conversation speech check failed");
      throw new ApiError(502, "SPEECH_CHECK_FAILED", "The voice recording did not pass its check. You can read the message or try again.", { reason });
    }
  });
}
