import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTranslateRoutes } from "../../../apps/server/src/routes/translate.js";
import { ApiError } from "../../../apps/server/src/errors.js";

function appWith(request: typeof fetch, email?: string) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    return reply.code(500).send({ error: { code: "INTERNAL", message: String(err) } });
  });
  registerTranslateRoutes(app, { request, ...(email ? { email } : {}) });
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
