import { describe, expect, it } from "vitest";
import { OllamaClient, OllamaError, assertLoopbackBaseUrl } from "../../../apps/server/src/adapters/gpu/ollamaClient.js";
import { DEFAULT_PRIORITY, MAX_RETRIES, RETRY_DELAYS_MS } from "../../../apps/server/src/queue/jobs.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../../../apps/server/src/queue/types.js";

describe("the model server is loopback only (spec/11)", () => {
  it.each(["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"])("accepts %s", (u) => {
    expect(assertLoopbackBaseUrl(u).protocol).toBe("http:");
  });
  it.each(["https://127.0.0.1:11434", "http://192.168.1.5:11434", "http://example.com", "http://user:pw@127.0.0.1:11434", "http://0.0.0.0:11434", "ftp://localhost"])("rejects %s", (u) => {
    expect(() => assertLoopbackBaseUrl(u)).toThrow();
  });

  it("never follows redirects and maps failures to typed errors", async () => {
    let seen: RequestInit | undefined;
    const ok = new OllamaClient({ fetchImpl: (async (_u: unknown, init?: RequestInit) => ((seen = init), new Response("{}", { status: 200 }))) as typeof fetch });
    await ok.json("/api/ps", { method: "GET", timeoutMs: 1000 });
    expect(seen?.redirect).toBe("error");
    const http = new OllamaClient({ fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch });
    await expect(http.json("/x", { timeoutMs: 1000 })).rejects.toMatchObject({ code: "http", status: 500 });
    const down = new OllamaClient({ fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(down.json("/x", { timeoutMs: 1000 })).rejects.toMatchObject({ code: "unreachable" });
    const slow = new OllamaClient({ fetchImpl: ((_u: unknown, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))))) as typeof fetch });
    await expect(slow.json("/x", { timeoutMs: 20 })).rejects.toBeInstanceOf(OllamaError);
    await expect(slow.json("/x", { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    const bad = new OllamaClient({ fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch });
    await expect(bad.json("/x", { timeoutMs: 1000 })).rejects.toMatchObject({ code: "bad_json" });
  });
});

describe("queue constants are the spec values", () => {
  it("priorities, backoff and scheduler defaults", () => {
    expect(DEFAULT_PRIORITY).toMatchObject({ free_text_analysis: 1, tutor: 2, vocabulary_enrichment: 2, generation: 3 });
    expect(RETRY_DELAYS_MS.slice(0, 2)).toEqual([2000, 5000]);
    expect(MAX_RETRIES).toBe(3);
    expect(DEFAULT_SCHEDULER_CONFIG).toMatchObject({ reserveMib: 2048, heartbeatMs: 5000, leaseTimeoutMs: 30000, practiceGraceMs: 3000, teardownBoundMs: 15000, telemetryStaleMs: 5000, fairnessEvery: 10, plateauSamples: 2 });
  });
});
