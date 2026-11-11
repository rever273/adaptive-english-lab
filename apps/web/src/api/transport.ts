import { ErrorEnvelopeSchema, SessionBootstrapSchema } from "@english-lab/contracts";
import type { ZodType } from "zod";

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 0,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

/** Shared by the JSON transport and the existing binary/keepalive requests. */
export const csrfState: { token: string | null } = { token: null };
/** Simultaneous identical GETs share one request; a mutation (POST/PATCH) drops them so nothing read before it is reused after it. */
const inflightGets = new Map<string, Promise<unknown>>();

export function send<T>(method: "GET" | "POST" | "PATCH", path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
  if (method !== "GET") {
    inflightGets.clear();
    return request(method, path, schema, body).finally(() => inflightGets.clear());
  }
  const shared = inflightGets.get(path) as Promise<T> | undefined;
  if (shared) return shared;
  const started: Promise<T> = request(method, path, schema, body).finally(() => { if (inflightGets.get(path) === started) inflightGets.delete(path); });
  inflightGets.set(path, started);
  return started;
}

async function request<T>(method: "GET" | "POST" | "PATCH", path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    if (!csrfState.token) {
      // same-origin bootstrap: sets the HttpOnly cookie and hands out the matching CSRF value
      const boot = await fetch("/api/v1/session", { headers: { Accept: "application/json" } });
      csrfState.token = SessionBootstrapSchema.parse(await boot.json()).csrfToken;
    }
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = csrfState.token;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiRequestError("NETWORK", "Cannot reach the local English Lab server.");
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 403) csrfState.token = null; // a restarted server issues a new token: fetch it again next time
    const env = ErrorEnvelopeSchema.safeParse(json);
    throw new ApiRequestError(env.success ? env.data.error.code : `HTTP_${res.status}`, env.success ? env.data.error.message : "Unexpected server response.", res.status, env.success ? env.data.error.details : null);
  }
  return schema.parse(json);
}

