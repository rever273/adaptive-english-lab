import { OllamaClient, OllamaError } from "../gpu/ollamaClient.js";
import { TransportError, type CallStats, type ChatClient, type ChatMessage, type ChatOptions, type ChatResult, type DecisionClient, type DecisionResult } from "../../domain/ai/clients.js";

const ms = (ns: unknown): number | null => (typeof ns === "number" ? ns / 1e6 : null);

function toTransport(e: unknown): never {
  if (e instanceof OllamaError) {
    if (e.code === "aborted") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const transient = e.code === "unreachable" || e.code === "timeout" || (e.code === "http" && (e.status ?? 0) >= 500);
    throw new TransportError(`ollama_${e.code}`, e.message, transient);
  }
  throw e;
}

/** Ollama /api/chat with a JSON-schema `format`, no tools, no thinking, non-streaming, loopback only. */
export class OllamaChatClient implements ChatClient {
  constructor(
    private readonly client: OllamaClient,
    private readonly timeoutMs = 120_000,
  ) {}

  async chat(req: { model: string; messages: ChatMessage[]; format?: object; options: ChatOptions; signal?: AbortSignal }): Promise<ChatResult> {
    const started = Date.now();
    try {
      const r = await this.client.json<{ message?: { content?: string }; load_duration?: number; prompt_eval_count?: number; eval_count?: number; eval_duration?: number }>("/api/chat", {
        timeoutMs: this.timeoutMs,
        signal: req.signal,
        body: { model: req.model, stream: false, think: false, keep_alive: "5m", format: req.format, messages: req.messages, options: req.options },
      });
      const stats: CallStats = { totalMs: Date.now() - started, loadMs: ms(r.load_duration), promptTokens: r.prompt_eval_count ?? null, evalTokens: r.eval_count ?? null, evalMs: ms(r.eval_duration) };
      return { text: r.message?.content ?? "", stats };
    } catch (e) {
      toTransport(e);
    }
  }
}

/** Nimble /v1/systemone `choice`: triage routing advice (needs deep review or not). It is a decision capability, not a chat model. */
export class NimbleDecisionClient implements DecisionClient {
  constructor(
    private readonly client: OllamaClient,
    private readonly timeoutMs = 60_000,
  ) {}

  async decide(req: { model: string; text: string; instructions: string; criteria?: { review: string; no_issue: string }; signal?: AbortSignal }): Promise<DecisionResult> {
    const started = Date.now();
    try {
      const r = await this.client.json<{ answers?: { review?: { choice?: string; probabilities?: Record<string, number>; confidence?: number } } }>("/v1/systemone", {
        timeoutMs: this.timeoutMs,
        signal: req.signal,
        body: {
          model: req.model,
          state: req.text,
          questions: { review: { type: "choice", instructions: req.instructions, criteria: req.criteria ?? { review: "Possible grammatical error or ambiguity; deeper review needed.", no_issue: "No apparent grammar issue." } } },
          keep_alive: "5m",
        },
      });
      const a = r.answers?.review;
      if (!a || (a.choice !== "review" && a.choice !== "no_issue")) throw new TransportError("nimble_bad_response", "unexpected decision response", false);
      const probs = a.probabilities;
      const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
      if (!probs || !valid(probs.review) || !valid(probs.no_issue) || Math.abs(probs.review + probs.no_issue - 1) > .01 || !valid(a.confidence)) throw new TransportError("nimble_bad_response", "decision probabilities/confidence are missing, non-finite or unnormalised", false);
      return { choice: a.choice, confidence: a.confidence, probabilities: probs, stats: { totalMs: Date.now() - started, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } };
    } catch (e) {
      if (e instanceof TransportError) throw e;
      toTransport(e);
    }
  }
}
