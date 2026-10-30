import type { Job, JobKind } from "../../queue/jobs.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import { OllamaClient, OllamaError } from "./ollamaClient.js";

export interface StreamPayload {
  prompt: string;
  numPredict?: number;
}

/**
 * A streaming chat workload used for controlled GPU measurements (verify:gpu). It reads the NDJSON stream chunk by chunk and stops
 * promptly when the dispatcher aborts it; closing the socket is only a request: the dispatcher still proves the release.
 * No tools, no remote hosts, no data besides the supplied synthetic prompt.
 */
export class OllamaStreamRunner implements JobRunner<StreamPayload> {
  constructor(
    readonly kind: JobKind,
    private readonly client: OllamaClient,
    private readonly model: string,
  ) {}

  ownedModels(): string[] {
    return [this.model];
  }
  profileKey() {
    return null; // measured by the controlled spike itself
  }

  async run(ctx: RunnerContext<StreamPayload>): Promise<RunnerOutput> {
    const startedAt = Date.now();
    let firstChunkMs: number | null = null;
    let chunks = 0;
    let chars = 0;
    let evalCount = 0;
    let evalDurationNs = 0;
    try {
      const res = await this.client.request("/api/chat", {
        timeoutMs: 120_000,
        signal: ctx.signal,
        body: {
          model: this.model,
          stream: true,
          think: false,
          keep_alive: "5m",
          messages: [{ role: "user", content: ctx.job.payload.prompt }],
          options: { num_ctx: 4096, num_predict: ctx.job.payload.numPredict ?? 400, temperature: 0.2, seed: 42 },
        },
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        if (ctx.signal.aborted) {
          await reader.cancel().catch(() => undefined);
          throw new OllamaError("aborted", "aborted");
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { message?: { content?: string }; done?: boolean; eval_count?: number; eval_duration?: number };
          if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt;
          chunks++;
          chars += msg.message?.content?.length ?? 0;
          if (msg.done) {
            evalCount = msg.eval_count ?? 0;
            evalDurationNs = msg.eval_duration ?? 0;
          }
        }
        if (chunks % 20 === 0) ctx.checkpoint({ done: chunks, total: null, chars });
      }
    } catch (e) {
      if (ctx.signal.aborted || (e instanceof OllamaError && e.code === "aborted")) throw new RunnerError("aborted", "aborted by the dispatcher", false);
      if (e instanceof OllamaError) throw new RunnerError(`ollama_${e.code}`, e.message, e.code === "unreachable" || e.code === "timeout");
      throw e;
    }
    return {
      schemaVersion: "stream-smoke-v1",
      output: { chars, chunks },
      metrics: { firstChunkMs, totalMs: Date.now() - startedAt, evalCount, tokensPerSecond: evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : null },
    };
  }
}

export type { Job };
