import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";
import { registerVocabularySpeechRoutes, SPEECH_MODEL, voiceFolder } from "../../../apps/server/src/routes/vocabularySpeech.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

describe("several ElevenLabs voices", () => {
  it("picks a voice at random with equal weight, keeps each voice in its own folder, and finds audio in any folder (also old flat files)", async () => {
    scratch = makeScratchRoot();
    db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const cacheDir = path.join(scratch.root, "speech");
    const used: string[] = [];
    const bodies: Array<{ text: string; model_id: string; language_code: string }> = [];
    const mock: typeof fetch = async (url, init) => {
      const voice = /text-to-speech\/([^/]+)\//.exec(String(url))![1]!;
      used.push(voice);
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(`audio-${voice}`, { status: 200 });
    };
    // the "random" numbers walk through the thirds of [0, 1): one voice each
    const draws = [0.1, 0.5, 0.9];
    let n = 0;
    const app = Fastify();
    registerErrorHandling(app);
    registerVocabularySpeechRoutes(app, db, { now: () => new Date(), newId: () => `id${n++}` }, { key: "k", voiceIds: ["voiceA", "voice-B", "voiceC"], cacheDir, request: mock, random: () => draws[used.length % 3]! });
    const speak = (text: string) => app.inject({ method: "POST", url: "/api/v1/vocabulary-speech/text", payload: { text } });
    expect((await speak("harsh")).body).toBe("audio-voiceA");
    expect((await speak("gentle")).body).toBe("audio-voice-B");
    expect((await speak("ancient")).body).toBe("audio-voiceC");
    expect(used).toEqual(["voiceA", "voice-B", "voiceC"]);
    // every word is read as English
    expect(bodies.every((b) => b.model_id === SPEECH_MODEL && b.language_code === "en")).toBe(true);
    // a full stop ends every word, so the model does not run on past it ("dinner" read as "dinners")
    expect(bodies.map((b) => b.text)).toEqual(["harsh.", "gentle.", "ancient."]);
    expect(readdirSync(cacheDir).sort()).toEqual(["voice-B", "voiceA", "voiceC"]);
    expect(existsSync(path.join(cacheDir, voiceFolder("voice-B")))).toBe(true);

    // asking again, in any case, reads the stored file of whichever voice made it: no new request
    expect((await speak("Gentle")).body).toBe("audio-voice-B");
    expect(used).toHaveLength(3);

    // a file made before there were several voices (flat folder, named for the first voice) still counts
    const legacy = createHash("sha256").update(JSON.stringify(["voiceA", SPEECH_MODEL, "old word"])).digest("hex");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, `${legacy}.mp3`), "legacy-audio");
    expect((await speak("old word")).body).toBe("legacy-audio");
    expect(used).toHaveLength(3);

    // a folder of a voice that is no longer configured is searched too
    const hash = createHash("sha256").update(JSON.stringify([SPEECH_MODEL, "full-stop", "retired"])).digest("hex");
    mkdirSync(path.join(cacheDir, "oldVoice"), { recursive: true });
    writeFileSync(path.join(cacheDir, "oldVoice", `${hash}.mp3`), "from-old-voice");
    expect((await speak("retired")).body).toBe("from-old-voice");

    // a clip of the old model (it guessed the language and read some words as French) is not reused
    const old = createHash("sha256").update(JSON.stringify(["eleven_multilingual_v2", "chance"])).digest("hex");
    writeFileSync(path.join(cacheDir, "oldVoice", `${old}.mp3`), "old-model");
    expect((await speak("chance")).body).not.toBe("old-model");

    expect((await speak("12345")).statusCode).toBe(400); // only English words and short phrases
    expect((await app.inject({ url: "/api/v1/vocabulary-speech" })).json()).toMatchObject({ configured: true });
    await app.close();
  });

  it("gives every voice the same chance", async () => {
    scratch = makeScratchRoot();
    db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const counts = new Map<string, number>();
    const mock: typeof fetch = async (url) => {
      const voice = /text-to-speech\/([^/]+)\//.exec(String(url))![1]!;
      counts.set(voice, (counts.get(voice) ?? 0) + 1);
      return new Response("x", { status: 200 });
    };
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const app = Fastify();
    registerErrorHandling(app);
    registerVocabularySpeechRoutes(app, db, { now: () => new Date(), newId: () => "x" }, { key: "k", voiceIds: ["a", "b", "c"], cacheDir: path.join(scratch.root, "c"), request: mock, random });
    for (let i = 0; i < 150; i++) await app.inject({ method: "POST", url: "/api/v1/vocabulary-speech/text", payload: { text: `word${"abcdefghij"[i % 10]} ${"klmnopqrst"[Math.floor(i / 10) % 10]}${"uvwxyzabcd"[Math.floor(i / 100)]}` } });
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    for (const v of ["a", "b", "c"]) expect(counts.get(v)!).toBeGreaterThan(25);
    await app.close();
  });

  it("the cached route never asks ElevenLabs: a stored clip is served, a missing one gives 204", async () => {
    scratch = makeScratchRoot();
    db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    let requests = 0;
    const mock: typeof fetch = async () => { requests++; return new Response("mp3", { status: 200 }); };
    const app = Fastify();
    registerErrorHandling(app);
    registerVocabularySpeechRoutes(app, db, { now: () => new Date(), newId: () => "x" }, { key: "k", voiceIds: ["a"], cacheDir: path.join(scratch.root, "c"), request: mock, random: () => 0 });
    const cached = (text: string) => app.inject({ method: "POST", url: "/api/v1/vocabulary-speech/cached", payload: { text } });
    expect((await cached("achieve")).statusCode).toBe(204);
    expect(requests).toBe(0);
    expect((await app.inject({ method: "POST", url: "/api/v1/vocabulary-speech/text", payload: { text: "achieve" } })).statusCode).toBe(200);
    expect(requests).toBe(1);
    const again = await cached("achieve");
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe("mp3");
    expect(requests).toBe(1);
    await app.close();
  });
});
