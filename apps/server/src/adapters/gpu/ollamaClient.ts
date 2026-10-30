import type { ModelControl } from "../../queue/types.js";

/** Only loopback model servers are ever called (spec/11): no remote models, no redirects, no arbitrary URLs. */
export function assertLoopbackBaseUrl(raw: string): URL {
  const u = new URL(raw);
  const hostOk = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
  if (u.protocol !== "http:" || !hostOk) throw new Error(`model server must be http://127.0.0.1|localhost|[::1], got ${u.origin}`);
  if (u.username || u.password) throw new Error("credentials in the model server URL are not allowed");
  return u;
}

export interface OllamaOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OllamaError extends Error {
  constructor(
    readonly code: "unreachable" | "http" | "timeout" | "aborted" | "bad_json",
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Thin, tool-free HTTP client for the local Ollama service. Never follows redirects; every call has a timeout. */
export class OllamaClient {
  readonly base: URL;
  private readonly f: typeof fetch;
  constructor(o: OllamaOptions = {}) {
    this.base = assertLoopbackBaseUrl(o.baseUrl ?? "http://127.0.0.1:11434");
    this.f = o.fetchImpl ?? fetch;
  }

  async request(path: string, init: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new OllamaError("timeout", `${path} timed out after ${init.timeoutMs} ms`)), init.timeoutMs);
    const onAbort = () => ctl.abort(init.signal?.reason ?? new OllamaError("aborted", "aborted"));
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.f(new URL(path, this.base), {
        method: init.method ?? "POST",
        redirect: "error",
        headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new OllamaError("http", `${path} answered ${res.status}`, res.status);
      return res;
    } catch (e) {
      if (e instanceof OllamaError) throw e;
      const reason = ctl.signal.reason;
      if (reason instanceof OllamaError) throw reason;
      if ((e as Error).name === "AbortError") throw new OllamaError("aborted", "aborted");
      throw new OllamaError("unreachable", (e as Error).message);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  async json<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<T> {
    const res = await this.request(path, init);
    try {
      return (await res.json()) as T;
    } catch {
      throw new OllamaError("bad_json", `${path} returned invalid JSON`);
    }
  }
}

/** The dispatcher's view of Ollama: list resident models (/api/ps) and unload one OWNED model (keep_alive=0). */
export class OllamaModelControl implements ModelControl {
  constructor(private readonly client: OllamaClient) {}

  async listLoaded(): Promise<string[] | null> {
    try {
      const ps = await this.client.json<{ models?: Array<{ name?: string; model?: string }> }>("/api/ps", { method: "GET", timeoutMs: 5000 });
      return (ps.models ?? []).map((m) => String(m.name ?? m.model ?? ""));
    } catch {
      return null;
    }
  }

  async unload(model: string): Promise<void> {
    await this.client.json("/api/generate", { body: { model, keep_alive: 0, stream: false }, timeoutMs: 30000 });
  }
}
