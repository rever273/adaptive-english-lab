import type { FastifyInstance } from "fastify";
import type { AiModelStatus } from "@english-lab/contracts";
import { ApiError } from "../errors.js";
import type { ModelResidency, ResidencyRefusal } from "../queue/modelResidency.js";

const REFUSAL: Record<ResidencyRefusal, { status: number; code: string; message: string }> = {
  job_running: { status: 409, code: "AI_MODEL_BUSY", message: "An AI task is running and holds the model. Try again when it has finished." },
  practice_active: { status: 409, code: "AI_MODEL_SPEECH_ACTIVE", message: "Local speech recognition is using the graphics card right now." },
  loading: { status: 409, code: "AI_MODEL_LOADING", message: "The model is loading. It cannot be unloaded until it is ready." },
  unloading: { status: 409, code: "AI_MODEL_UNLOADING", message: "The model is unloading. Try again in a moment." },
  shutting_down: { status: 409, code: "AI_MODEL_SHUTTING_DOWN", message: "The server is shutting down." },
  insufficient_vram: { status: 409, code: "AI_MODEL_NO_VRAM", message: "Not enough free graphics memory for the model." },
  auto_disabled: { status: 409, code: "AI_MODEL_AUTO_DISABLED", message: "Automatic loading is off." },
};

/**
 * The one local model (D67): status, load, unload. No confirmation step (the learner's explicit button). All three are loopback-only like
 * every other route; the state machine, the busy refusal and the dispatcher hand-shake live in ModelResidency.
 */
export function registerAiModelRoutes(app: FastifyInstance, residency: ModelResidency): void {
  const status = (): Promise<AiModelStatus> => residency.status();

  app.get("/api/v1/ai/model", async () => status());

  // returns at once (the first load takes ~40 s): the client polls the status endpoint
  app.post("/api/v1/ai/model/load", async (_req, reply) => {
    const r = residency.load();
    if (!r.ok) {
      const x = REFUSAL[r.reason];
      throw new ApiError(x.status, x.code, x.message);
    }
    return reply.code(202).send(await status());
  });

  // unloading is quick; the answer reflects the verified result
  app.post("/api/v1/ai/model/unload", async () => {
    const r = residency.unload();
    if (!r.ok) {
      const x = REFUSAL[r.reason];
      throw new ApiError(x.status, x.code, x.message);
    }
    await r.done;
    return status();
  });
}
