import { TransportError, type CallStats, type ChatClient, type ChatMessage, type ChatOptions } from "./clients.js";
import type { ValidationIssue, Validated } from "./validate.js";

export const TRANSPORT_DELAYS_MS = [2000, 5000];
/** transport retries (max 2) and the one repair request share a budget of 3 model calls (spec/06) */
export const MAX_CALLS = 3;

export interface StructuredUsage {
  calls: number;
  transportRetries: number;
  repaired: boolean;
  /** the first output was already valid: the metric behind "JSON valid >= 98%" (before repair) */
  validBeforeRepair: boolean;
  validAfterRepair: boolean;
  schemaValidBeforeRepair: boolean;
  schemaValidAfterRepair: boolean;
  stats: CallStats[];
  rawOutputs: string[];
}

export type StructuredResult<T> =
  | { ok: true; value: T; usage: StructuredUsage }
  | { ok: false; code: "failed_validation" | "transport_failed"; issues: ValidationIssue[]; usage: StructuredUsage };

export interface StructuredRequest<T> {
  client: ChatClient;
  model: string;
  messages: ChatMessage[];
  format: object;
  options: ChatOptions;
  validate: (text: string) => Validated<T>;
  schemaValid?: (text: string) => boolean;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One structured model call with the project's retry policy: transport errors are retried (2 s, then 5 s), an INVALID output gets
 * exactly one repair request that carries only the validation errors (no hidden chain of thought), then `failed_validation`.
 * At most 3 model calls. Cancellation is never a failure and never retried.
 */
export async function runStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const sleep = req.sleep ?? realSleep;
  const usage: StructuredUsage = { calls: 0, transportRetries: 0, repaired: false, validBeforeRepair: false, validAfterRepair: false, schemaValidBeforeRepair: false, schemaValidAfterRepair: false, stats: [], rawOutputs: [] };
  let messages = req.messages;

  const call = async (): Promise<string | null> => {
    for (;;) {
      if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (usage.calls >= MAX_CALLS) return null;
      usage.calls++;
      try {
        const r = await req.client.chat({ model: req.model, messages, format: req.format, options: req.options, signal: req.signal });
        usage.stats.push(r.stats);
        usage.rawOutputs.push(r.text);
        return r.text;
      } catch (e) {
        if (req.signal?.aborted || (e as Error).name === "AbortError") throw e;
        if (e instanceof TransportError && e.transient && usage.transportRetries < TRANSPORT_DELAYS_MS.length && usage.calls < MAX_CALLS) {
          await sleep(TRANSPORT_DELAYS_MS[usage.transportRetries]!);
          usage.transportRetries++;
          continue;
        }
        throw e;
      }
    }
  };

  let text: string | null;
  try {
    text = await call();
  } catch (e) {
    if (e instanceof TransportError) return { ok: false, code: "transport_failed", issues: [{ code: e.code, message: e.message }], usage };
    throw e;
  }
  if (text === null) return { ok: false, code: "transport_failed", issues: [{ code: "BUDGET", message: "call budget exhausted" }], usage };
  const first = req.validate(text);
  usage.schemaValidBeforeRepair = usage.schemaValidAfterRepair = req.schemaValid?.(text) ?? first.ok;
  if (first.ok) {
    usage.validBeforeRepair = usage.validAfterRepair = true;
    return { ok: true, value: first.value, usage };
  }

  usage.repaired = true;
  messages = [
    ...req.messages,
    { role: "assistant", content: text.slice(0, 8000) },
    { role: "user", content: `Your previous output was invalid. Errors:\n${first.issues.map((i) => `- ${i.code}: ${i.message}`).join("\n")}\nReturn the corrected JSON only, matching the schema.` },
  ];
  try {
    text = await call();
  } catch (e) {
    if (e instanceof TransportError) return { ok: false, code: "failed_validation", issues: first.issues, usage };
    throw e;
  }
  if (text === null) return { ok: false, code: "failed_validation", issues: first.issues, usage };
  const second = req.validate(text);
  usage.schemaValidAfterRepair = req.schemaValid?.(text) ?? second.ok;
  if (second.ok) {
    usage.validAfterRepair = true;
    return { ok: true, value: second.value, usage };
  }
  return { ok: false, code: "failed_validation", issues: second.issues, usage };
}
