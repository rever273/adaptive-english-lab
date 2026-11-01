import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { GroqWorker, groqLimits } from "../../../apps/server/src/adapters/stt/groqWorker.js";
import { registerGroqStatusRoute } from "../../../apps/server/src/routes/groqStatus.js";

const status = async (options: Parameters<typeof registerGroqStatusRoute>[1]) => {
  const app = Fastify();
  registerGroqStatusRoute(app, options);
  try { return (await app.inject({ url: "/api/v1/groq-status" })).json(); } finally { await app.close(); }
};

describe("Groq status", () => {
  it("says so when there is no key, and reports a working or rejected key", async () => {
    expect(await status({})).toMatchObject({ configured: false, reachable: false });
    expect(await status({ key: "k", request: async () => Response.json({ data: [] }) })).toMatchObject({ configured: true, reachable: true });
    expect(await status({ key: "k", request: async () => new Response("no", { status: 401 }) })).toMatchObject({ configured: true, reachable: false, reason: "Groq rejected the API key." });
    expect(await status({ key: "k", request: async () => { throw new Error("offline"); } })).toMatchObject({ reachable: false, reason: "Could not reach Groq." });
  });
  it("keeps the rate-limit headers of the latest transcription, and nothing else", async () => {
    const worker = new GroqWorker("k", async () => Response.json({ text: "hello" }, { headers: { "x-ratelimit-remaining-requests": "99", "x-ratelimit-reset-requests": "1s", "set-cookie": "secret=1" } }));
    await worker.start();
    await worker.transcribe(Buffer.alloc(32000));
    expect(groqLimits.headers).toEqual({ "x-ratelimit-remaining-requests": "99", "x-ratelimit-reset-requests": "1s" });
    expect((await status({ key: "k", request: async () => Response.json({}) })).limits).toMatchObject({ status: 200, headers: { "x-ratelimit-remaining-requests": "99" } });
  });
});
