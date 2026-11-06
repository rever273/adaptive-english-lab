import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";
import { registerTypingBookSpeechRoutes, speakable } from "../../../apps/server/src/routes/typingBookSpeech.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";
import { VoiceService } from "../../../apps/server/src/domain/voices/service.js";
import type { DictationEnv } from "../../../apps/server/src/domain/typing/dictation/lessons.js";

function envWith(calls: Array<{ text: string; speakerId: number }>, available = true): DictationEnv {
  return {
    tts: {
      available: () => (available ? { ok: true, modelSha256: "a".repeat(64) } : { ok: false, reason: "tts_not_installed" }),
      synthesize: async ({ text, speakerId }) => { calls.push({ text, speakerId }); return Buffer.from(`RIFF-${speakerId}-${text}`); },
      stop: async () => {},
    },
    asr: { available: () => true, transcribe: async () => ({ text: "", model: "x" }), stop: async () => {} },
    voices: new VoiceService(),
    topics: [],
    audioDir: "unused",
  };
}

async function app(env: DictationEnv) {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  const a = Fastify();
  registerErrorHandling(a);
  registerTypingBookSpeechRoutes(a, db, env);
  a.addHook("onClose", async () => { db.close(); scratch.cleanup(); });
  return a;
}

describe("Books: read the previous sentence aloud", () => {
  it("makes the audio once, keeps it only in memory, and uses one voice for a whole paragraph", async () => {
    const calls: Array<{ text: string; speakerId: number }> = [];
    const a = await app(envWith(calls));
    const post = (text: string, paragraph: number) => a.inject({ method: "POST", url: "/api/v1/typing/books/speech", payload: { text, sessionId: "s1", paragraph } });
    const r1 = await post("It was a bright cold day in April.", 0);
    expect(r1.statusCode).toBe(200);
    expect(r1.headers["content-type"]).toContain("audio/wav");
    const r2 = await post("It was a bright cold day in April.", 0); // again: served from the memory cache
    expect(r2.rawPayload.equals(r1.rawPayload)).toBe(true);
    expect(calls).toHaveLength(1);
    const r3 = await post("The clocks were striking thirteen.", 0); // same paragraph: same voice
    expect(calls[1]!.speakerId).toBe(calls[0]!.speakerId);
    expect(r3.statusCode).toBe(200);
    const voices = new Set<number>();
    for (let p = 1; p <= 12; p++) { await post(`Sentence number ${p} is here.`, p); voices.add(calls[calls.length - 1]!.speakerId); }
    expect(voices.size).toBeGreaterThan(1); // other paragraphs get other voices
    await a.close();
  });

  it("plays practice sentences through weighted listening voices without persisting audio", async () => {
    const calls: Array<{ text: string; speakerId: number }> = [];
    const env = envWith(calls);
    const purposes: string[] = [];
    const pick = env.voices.pick.bind(env.voices);
    env.voices.pick = (db, opts) => { purposes.push(opts.purpose); return pick(db, opts); };
    const a = await app(env);
    const res = await a.inject({ method: "POST", url: "/api/v1/practice/speech", payload: { text: "This sentence has a mistake." } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls[0]?.text).toBe("This sentence has a mistake.");
    expect(purposes).toEqual(["listening"]);
    expect((await a.inject({ method: "POST", url: "/api/v1/practice/speech", payload: { text: "x" } })).statusCode).toBe(400);
    await a.close();
  });

  it("starts the engine ahead of time, refuses clearly without Piper, and rejects bad input", async () => {
    const warm: string[] = [];
    const env = envWith([]);
    env.tts.warm = async () => { warm.push("warm"); };
    const a = await app(env);
    expect((await a.inject({ method: "POST", url: "/api/v1/typing/books/speech/warm" })).statusCode).toBe(202);
    expect(warm).toEqual(["warm"]);
    expect((await a.inject({ method: "POST", url: "/api/v1/typing/books/speech", payload: { text: "x", sessionId: "s", paragraph: 0 } })).statusCode).toBe(400);
    await a.close();
    const b = await app(envWith([], false));
    const res = await b.inject({ method: "POST", url: "/api/v1/typing/books/speech", payload: { text: "Hello there, friend.", sessionId: "s", paragraph: 0 } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("dictation:setup");
    await b.close();
    expect(speakable("Hello\n\n  there\u0007.")).toBe("Hello there .");
  });
});
