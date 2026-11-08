import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordLessonActivity } from "../../../apps/server/src/domain/wordLessons/activity.js";
import { recordPracticeActivity } from "../../../apps/server/src/domain/sessions/activity.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";
import { registerJourneyRoutes } from "../../../apps/server/src/routes/journey.js";
import { registerSettingsRoutes } from "../../../apps/server/src/routes/settings.js";
import { makeEnv, makeSession, type Env } from "../attempts/fixtures.js";

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(() => env.cleanup());

/** a minimal ready lesson and an open run (the content is not needed to measure time) */
function openRun(startedAt: number): string {
  const { db } = env;
  const entry = randomUUID();
  const lesson = randomUUID();
  const run = randomUUID();
  db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, surface_forms_json, created_at) VALUES (?,?,?,?,?,?)").run(entry, "overlook", "verb", "en", "[]", new Date().toISOString());
  db.prepare("INSERT INTO word_lessons(id, entry_id, lemma, sense_json, plan_json, status, content_json, content_status, schema_version, settings_revision, created_at, ready_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(lesson, entry, "overlook", "{}", "{}", "ready", "{}", "validated", "word-lesson-v1", 1, new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO word_lesson_runs(id, lesson_id, tab_id, seed, status, started_at) VALUES (?,?,?,?,?,?)").run(run, lesson, "tab", 1, "active", new Date(startedAt).toISOString());
  return run;
}

describe("word lesson time", () => {
  it("records a visible interval once and shows it in today's plan and the lifetime total under its own mode", async () => {
    const now = Date.now();
    const run = openRun(now - 60_000);
    const iv = { id: randomUUID(), tabId: "tab", startMs: now - 9000, endMs: now - 4000 };
    expect(recordLessonActivity(env.db, { now: () => new Date(), newId: randomUUID }, run, iv)).toEqual({ recorded: true });
    expect(recordLessonActivity(env.db, { now: () => new Date(), newId: randomUUID }, run, iv)).toEqual({ recorded: false });
    expect(() => recordLessonActivity(env.db, { now: () => new Date(), newId: randomUUID }, run, { ...iv, startMs: iv.startMs + 1 })).toThrow(/already used/);
    expect(() => recordLessonActivity(env.db, { now: () => new Date(), newId: randomUUID }, run, { id: randomUUID, tabId: "other", startMs: now - 2000, endMs: now - 1000 } as never)).toThrow();
    expect(() => recordLessonActivity(env.db, { now: () => new Date(), newId: randomUUID }, run, { id: randomUUID(), tabId: "tab", startMs: now - 3000, endMs: now - 3000 })).toThrow(/Invalid/);
    const a = Fastify();
    registerErrorHandling(a);
    registerJourneyRoutes(a, env.db);
    try {
      const j = (await a.inject({ url: "/api/v1/journey" })).json();
      expect(j.totals.wordLesson).toBe(5000);
      expect(j.todayMs.wordLesson).toBe(5000);
      expect(j.totals.grammar).toBe(0);
    } finally {
      await a.close();
    }
  });

  it("never counts one moment twice: lesson, practice and typing intervals may not overlap, whichever is recorded second", async () => {
    const start = Date.now() - 10_000;
    const run = openRun(start - 1000);
    const deps = { now: () => new Date(), newId: randomUUID };
    recordLessonActivity(env.db, deps, run, { id: randomUUID(), tabId: "tab", startMs: start, endMs: start + 5000 });
    // practice over the same time
    env.clock.current = new Date(start - 2000);
    const s = makeSession(env);
    takeLease(env.db, env.deps, s, "ptab");
    env.clock.current = new Date(start + 6000);
    expect(() => recordPracticeActivity(env.db, env.deps, s, { id: randomUUID(), tabId: "ptab", startMs: start + 2000, endMs: start + 6000 })).toThrow(/overlaps/);
    // typing over the same time (through the route)
    env.db.prepare("INSERT INTO typing_sessions(id,mode,status,level_number,settings_revision,settings_json,plan_json,started_at,active_ms) VALUES (?,?,?,?,?,?,?,?,?)").run("typing-x", "words", "active", 1, 1, "{}", "{}", new Date(start - 5000).toISOString(), 0);
    const a = Fastify();
    registerErrorHandling(a);
    registerJourneyRoutes(a, env.db);
    try {
      const res = await a.inject({ method: "POST", url: "/api/v1/journey/typing-interval", payload: { id: randomUUID(), sessionId: "typing-x", mode: "words", startMs: start + 1000, endMs: start + 3000 } });
      expect(res.statusCode).toBe(409);
      // a free moment is fine, and a lesson interval over the typing one is refused
      const free = await a.inject({ method: "POST", url: "/api/v1/journey/typing-interval", payload: { id: randomUUID(), sessionId: "typing-x", mode: "words", startMs: start + 7000, endMs: start + 9000 } });
      expect(free.statusCode).toBe(200);
      expect(() => recordLessonActivity(env.db, deps, run, { id: randomUUID(), tabId: "tab", startMs: start + 7500, endMs: start + 8500 })).toThrow(/overlaps/);
    } finally {
      await a.close();
    }
  });

  it("settings saved before the sixth mode still load: the journey shows six modes, wordLesson defaults to 5 minutes and is appended to the order", async () => {
    const a = Fastify();
    registerErrorHandling(a);
    registerJourneyRoutes(a, env.db);
    registerSettingsRoutes(a, env.db, { now: env.deps.now });
    try {
      const old = await a.inject({ method: "POST", url: "/api/v1/settings", payload: { dailyMinutes: { grammar: 15, vocabulary: 10, words: 5, books: 10, dictation: 5 }, dailyOrder: ["books", "grammar", "vocabulary", "words", "dictation"] } });
      expect(old.statusCode).toBe(200);
      const j = (await a.inject({ url: "/api/v1/journey" })).json();
      expect(j.dailyMinutes).toEqual({ grammar: 15, vocabulary: 10, words: 5, books: 10, dictation: 5, wordLesson: 5 });
      expect(j.dailyOrder).toEqual(["books", "grammar", "vocabulary", "words", "dictation", "wordLesson"]);
      const upd = await a.inject({ method: "POST", url: "/api/v1/settings", payload: { dailyMinutes: { grammar: 15, vocabulary: 10, words: 5, books: 10, dictation: 5, wordLesson: 8 }, dailyOrder: ["wordLesson", "books", "grammar", "vocabulary", "words", "dictation"] } });
      expect(upd.statusCode).toBe(200);
      const k = (await a.inject({ url: "/api/v1/journey" })).json();
      expect(k.dailyMinutes.wordLesson).toBe(8);
      expect(k.dailyOrder[0]).toBe("wordLesson");
    } finally {
      await a.close();
    }
  });
});
