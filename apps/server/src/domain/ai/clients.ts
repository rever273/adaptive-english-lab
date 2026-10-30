/** Provider-neutral model clients. The domain only sees these interfaces; Ollama specifics live in adapters/ollama. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  num_ctx: number;
  num_predict: number;
  temperature: number;
  seed?: number;
}

export interface CallStats {
  totalMs: number;
  loadMs: number | null;
  promptTokens: number | null;
  evalTokens: number | null;
  evalMs: number | null;
}

export interface ChatResult {
  text: string;
  stats: CallStats;
}

export class TransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

export interface ChatClient {
  chat(req: { model: string; messages: ChatMessage[]; format?: object; options: ChatOptions; signal?: AbortSignal }): Promise<ChatResult>;
}

export interface DecisionResult {
  choice: "review" | "no_issue";
  confidence: number;
  probabilities: Record<string, number>;
  stats: CallStats;
}

/** Nimble-style decision capability (not chat): routing advice only, never a verdict. */
export interface DecisionClient {
  decide(req: { model: string; text: string; instructions: string; criteria?: { review: string; no_issue: string }; signal?: AbortSignal }): Promise<DecisionResult>;
}
