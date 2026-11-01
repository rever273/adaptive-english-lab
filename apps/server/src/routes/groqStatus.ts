import type { FastifyInstance } from "fastify";
import { groqLimits } from "../adapters/stt/groqWorker.js";

/** Groq has no credits endpoint: the status is "the key works" plus the rate-limit headers of the latest transcription, if there was one since the start. */
export function registerGroqStatusRoute(app: FastifyInstance, options: { key?: string; request?: typeof fetch }): void {
  const request = options.request ?? fetch;
  app.get("/api/v1/groq-status", async () => {
    const limits = groqLimits.capturedAt ? { capturedAt: groqLimits.capturedAt, status: groqLimits.status, headers: { ...groqLimits.headers } } : null;
    if (!options.key) return { configured: false, reachable: false, reason: "No Groq API key is set; speech recognition runs locally.", limits };
    try {
      const response = await request("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${options.key}` }, signal: AbortSignal.timeout(10000) });
      if (response.status === 401 || response.status === 403) return { configured: true, reachable: false, reason: "Groq rejected the API key.", limits };
      if (!response.ok) return { configured: true, reachable: false, reason: `Groq answered HTTP ${response.status}.`, limits };
      return { configured: true, reachable: true, limits };
    } catch { return { configured: true, reachable: false, reason: "Could not reach Groq.", limits }; }
  });
}
