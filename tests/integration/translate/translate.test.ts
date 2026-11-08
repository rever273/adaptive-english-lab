import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTranslateRoutes } from "../../../apps/server/src/routes/translate.js";
import { ApiError } from "../../../apps/server/src/errors.js";

function appWith(request: typeof fetch, email?: string, deeplKey?: string) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  registerTranslateRoutes(app, { request, ...(email ? { email } : {}), ...(deeplKey ? { deeplKey } : {}) });
  return app;
}

const memory = (text: string, extra: Record<string, unknown> = {}) => async () => new Response(JSON.stringify({ responseData: { translatedText: text, match: 0.9 }, quotaFinished: false, responseStatus: 200, ...extra }), { status: 200 });

describe("sentence translation", () => {
  it("returns the translation, sends only the sentence (and the optional e-mail), and caches the answer", async () => {
    let calls = 0;
    let seenUrl = "";
    const app = appWith((async (url: URL) => { calls++; seenUrl = String(url); return memory("Это был яркий день.")(); }) as unknown as typeof fetch, "me@example.com");
    const r1 = await app.inject({ method: "POST", url: "/api/v1/translate", payload: { text: "It was a bright day." } });
    expect(r1.json()).toEqual({ text: "Это был яркий день.", cached: false });
    const r2 = await app.inject({ method: "POST", url: "/api/v1/translate", payload: { text: "It was   a bright day." } });
    expect(r2.json().cached).toBe(true);
    expect(calls).toBe(1);
    expect(seenUrl).toContain("langpair=en%7Cru");
    expect(seenUrl).toContain("de=me%40example.com");
    await app.close();
  });

  it("uses the free DeepL API with a private key, sends the complete sentence and caches it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ translations: [{ text: "???????." }] }), { status: 200 }); }) as typeof fetch;
    const app = appWith(request, undefined, "example-key:fx");
    const text = "word ".repeat(110).trim();
    const result = await app.inject({ method: "POST", url: "/api/v1/translate", payload: { text } });
    expect(result.json()).toEqual({ text: "???????.", cached: false });
    expect(calls[0]!.url).toBe("https://api-free.deepl.com/v2/translate");
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: "DeepL-Auth-Key example-key:fx" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ text: [text], source_lang: "EN", target_lang: "RU" });
    expect((await app.inject({ method: "POST", url: "/api/v1/translate", payload: { text } })).json().cached).toBe(true);
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it("reports the DeepL quota error without switching providers", async () => {
    let calls = 0;
    const request = (async () => { calls++; return new Response("quota", { status: 456 }); }) as typeof fetch;
    const app = appWith(request, undefined, "example-key:fx");
    const result = await app.inject({ method: "POST", url: "/api/v1/translate", payload: { text: "Hello." } });
    expect(result.statusCode).toBe(429);
    expect(result.json().error.code).toBe("TRANSLATE_RATE_LIMIT");
    expect(calls).toBe(1);
    await app.close();
  });

  it("returns DeepL account usage and its actual limit without exposing the key", async () => {
    let called = 0;
    const request = (async (url: string, init?: RequestInit) => {
      called++;
      expect(url).toBe("https://api-free.deepl.com/v2/usage");
      expect(init?.headers).toMatchObject({ Authorization: "DeepL-Auth-Key example-key:fx" });
      return new Response(JSON.stringify({ character_count: 1234, character_limit: 1000000 }), { status: 200 });
    }) as typeof fetch;
    const app = appWith(request, undefined, "example-key:fx");
    const response = await app.inject({ url: "/api/v1/translate/usage" });
    expect(response.json()).toEqual({ available: true, used: 1234, limit: 1000000 });
    expect(response.body).not.toContain("example-key");
    expect(called).toBe(1);
    await app.close();
  });

  it("handles missing keys, invalid data and unavailable DeepL usage", async () => {
    const noKey = appWith((async () => { throw new Error("must not be called"); }) as typeof fetch);
    expect((await noKey.inject({ url: "/api/v1/translate/usage" })).json()).toMatchObject({ available: false });
    const invalid = appWith((async () => new Response(JSON.stringify({ character_count: 1 }), { status: 200 })) as typeof fetch, undefined, "key");
    expect((await invalid.inject({ url: "/api/v1/translate/usage" })).json()).toMatchObject({ available: false });
    const down = appWith((async () => { throw new Error("network"); }) as typeof fetch, undefined, "key");
    expect((await down.inject({ url: "/api/v1/translate/usage" })).json()).toMatchObject({ available: false });
    await noKey.close(); await invalid.close(); await down.close();
  });

  it("reports a used-up quota and a failing service instead of inventing a translation", async () => {
    const quota = appWith((async () => memory("MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS", { quotaFinished: true, responseStatus: 429 })()) as unknown as typeof fetch);
    const q = await quota.inject({ method: "POST", url: "/api/v1/translate", payload: { text: "Hello there." } });
    expect(q.statusCode).toBe(429);
    const down = appWith((async () => new Response("no", { status: 503 })) as unknown as typeof fetch);
    expect((await down.inject({ method: "POST", url: "/api/v1/translate", payload: { text: "Hello there." } })).statusCode).toBe(502);
    expect((await down.inject({ method: "POST", url: "/api/v1/translate", payload: { text: "" } })).statusCode).toBe(400);
    await quota.close();
    await down.close();
  });
});
