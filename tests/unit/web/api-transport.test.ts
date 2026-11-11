import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settings = { revision: 1, values: {}, defaults: {} };
const error = { error: { code: "CSRF_FAILED", message: "Session expired", details: { retry: true }, requestId: "test-request" } };

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("public API transport contracts", () => {
  it("keeps JSON and binary requests on the same CSRF session and resets both after a 403", async () => {
    const calls: Array<{ url: string; method: string; token: string | null }> = [];
    let boot = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", token: new Headers(init?.headers).get("X-CSRF-Token") });
      if (url === "/api/v1/session") return json({ csrfToken: `token-${++boot}` });
      if (url === "/api/v1/settings") return json(settings);
      if (url === "/api/v1/practice/speech") return json(error, 403);
      return new Response(null, { status: 204 });
    }));
    const api = await import("../../../apps/web/src/api.js");
    await api.savePreloadModel(true);
    await expect(api.fetchBookSpeech({ text: "A synthetic sentence." })).rejects.toMatchObject({ code: "HTTP_403", status: 403, message: "Session expired" });
    expect(await api.vocabularyTextSpeech("sample")).toBeNull();
    expect(calls).toEqual([
      { url: "/api/v1/session", method: "GET", token: null },
      { url: "/api/v1/settings", method: "POST", token: "token-1" },
      { url: "/api/v1/practice/speech", method: "POST", token: "token-1" },
      { url: "/api/v1/session", method: "GET", token: null },
      { url: "/api/v1/vocabulary-speech/text", method: "POST", token: "token-2" },
    ]);
  });

  it("preserves structured errors and reboots after a JSON 403", async () => {
    let writes = 0, boots = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/session") return json({ csrfToken: `token-${++boots}` });
      return ++writes === 1 ? json(error, 403) : json(settings);
    }));
    const api = await import("../../../apps/web/src/api.js");
    await expect(api.savePreloadModel(true)).rejects.toMatchObject({ code: "CSRF_FAILED", message: "Session expired", status: 403, details: { retry: true } });
    expect(await api.savePreloadModel(false)).toEqual(settings);
    expect(boots).toBe(2);
  });

  it("shares a failing GET, releases it and permits a fresh retry", async () => {
    let fail!: (reason: Error) => void;
    const first = new Promise<Response>((_, reject) => { fail = reject; });
    const fetcher = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(json(settings));
    vi.stubGlobal("fetch", fetcher);
    const api = await import("../../../apps/web/src/api.js");
    const a = api.fetchSettings(), b = api.fetchSettings();
    fail(new Error("offline"));
    const results = await Promise.allSettled([a, b]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "NETWORK", status: 0 });
    }
    expect(await api.fetchSettings()).toEqual(settings);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("validates responses using the existing schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ status: "invented" })));
    const api = await import("../../../apps/web/src/api.js");
    await expect(api.fetchHealth()).rejects.toMatchObject({ name: "ZodError" });
  });

  it("keeps encoded binary URLs, signal cancellation and raw Blob bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 255]);
    const signal = new AbortController().signal;
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, signal: init?.signal });
      if (url === "/api/v1/session") return json({ csrfToken: "test-token" });
      return new Response(bytes, { headers: { "Content-Type": "audio/wav" } });
    }));
    const api = await import("../../../apps/web/src/api.js");
    const blob = await api.vocabularySpeech("session/a", "slot b", signal);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
    expect(calls.at(-1)).toEqual({ url: "/api/v1/vocabulary-speech/session%2Fa/slot%20b", signal });
    const aborted = new DOMException("Cancelled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
    await expect(api.vocabularySpeech("s", "x", signal)).rejects.toBe(aborted);
  });

  it("does not bootstrap for keepalive and sends its original body after normal bootstrap", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/v1/session") return json({ csrfToken: "test-token" });
      if (url === "/api/v1/settings") return json(settings);
      throw new Error("closed tab");
    }));
    const api = await import("../../../apps/web/src/api.js");
    await api.sendKeepalive("/checkpoint", { count: 3 });
    expect(calls).toHaveLength(0);
    await api.savePreloadModel(true);
    await expect(api.sendKeepalive("/checkpoint", { count: 3 })).resolves.toBeUndefined();
    expect(calls.at(-1)).toEqual({ url: "/checkpoint", init: { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-CSRF-Token": "test-token" }, body: '{"count":3}' } });
  });
});
