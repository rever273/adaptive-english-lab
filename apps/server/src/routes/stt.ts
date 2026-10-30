import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { SttService } from "../domain/stt/sttService.js";

const StartSchema = z.object({ sessionId: z.string().min(1).max(64), tabId: z.string().min(1).max(64) }).strict();
const ConfirmSchema = z.object({ draftId: z.string().min(1).max(64), slotId: z.string().min(1).max(64), text: z.string().min(1).max(2000) }).strict();
const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } } as const;
const MAX_BODY = 2 * 1024 * 1024 + 1024;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

/**
 * Voice endpoints (spec/02 `stt`). The audio request body is raw 16 kHz mono int16 PCM (`application/octet-stream`, <= 2 MiB): it is held in
 * memory just long enough to decode and is never written, logged or stored. The response is text only.
 */
export function registerSttRoutes(app: FastifyInstance, stt: SttService): void {
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

  app.post("/api/v1/stt/start", async (req, reply) => {
    const b = parse(StartSchema, req.body);
    return reply.code(201).send(await stt.start(b.sessionId, b.tabId));
  });

  app.post<{ Params: { id: string } }>("/api/v1/stt/:id/audio", { ...idParams, bodyLimit: MAX_BODY }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new ApiError(415, "AUDIO_FORMAT", "Send raw 16 kHz mono 16-bit PCM as application/octet-stream");
    return stt.transcribe(req.params.id, req.body);
  });

  app.post<{ Params: { id: string } }>("/api/v1/stt/:id/confirm", idParams, async (req, reply) => {
    const b = parse(ConfirmSchema, req.body);
    return reply.code(201).send(stt.confirm(req.params.id, b.draftId, b.slotId, b.text));
  });

  app.post<{ Params: { id: string } }>("/api/v1/stt/:id/stop", idParams, async (req) => {
    await stt.stop(req.params.id);
    return { stopped: true };
  });
}
