import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { clozeAnalytics } from "../../../apps/server/src/domain/grammarCloze/analytics.js";
import { importCleaned } from "../../../apps/server/src/domain/grammarCloze/importer.js";
import { recordClozeActivity } from "../../../apps/server/src/domain/grammarCloze/activity.js";
import { completeSession, sessionView, startSession, submitAnswer } from "../../../apps/server/src/domain/grammarCloze/repository.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";
import { registerGrammarClozeRoutes } from "../../../apps/server/src/routes/grammarCloze.js";
import { registerJourneyRoutes } from "../../../apps/server/src/routes/journey.js";
import { registerSettingsRoutes } from "../../../apps/server/src/routes/settings.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };
let db: Db;
let cleanup: () => void;
beforeEach(async () => {
  const scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  cleanup = () => { db.close(); scratch.cleanup(); };
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  const items = Array.from({ length: 30 }, (_, i) => ({ sourceIndex: i + 1, gappedText: `She ___ to school number ${i + 1}.`, solution: "goes", distractors: ["go"], filledText: `She goes to school number ${i + 1}.`, sourceTopic: "present_simple", skillId: i % 2 ? "agreement.third_person" : null, skillConfidence: i % 2 ? ("exact" as const) : ("general" as const), status: "validated" as const, flagReasons: [], contentHash: `h${i}` }));
  importCleaned(db, { source: "zanichelli", sourceSha256: "s", cleanVersion: "c", classifierVersion: "k", configSha256: "x", items }, { apply: true });
});
afterEach(() => cleanup());

describe("analytics and journey", () => {
  it("is empty before any answer and counts only Cloze answers afterwards", () => {
    expect(clozeAnalytics(db, "30", new Date())).toMatchObject({ totals: { answered: 0 }, byRule: [], byDay: [] });
    const { sessionId } = startSession(db, { ...deps, now: () => new Date(Date.now() - 60000) }, "tab");
    for (const s of sessionView(db, sessionId).slots) submitAnswer(db, deps, sessionId, { id: randomUUID(), position: s.position, chosen: s.position % 4 === 0 ? s.options.find((o) => o !== "goes")! : "goes", responseMs: 2000 });
    completeSession(db, deps, sessionId);
    const a = clozeAnalytics(db, "30", new Date());
    expect(a.totals).toMatchObject({ sessions: 1, answered: 15, incorrect: 3, correct: 12 });
    expect(a.byDay.reduce((n, d) => n + d.answered, 0)).toBe(15);
    expect(a.byRule.some((r) => r.name === "General Grammar")).toBe(true);
    expect(a.responseMs.median).toBe(2000);
    expect(a.stages[0]).toMatchObject({ processed: 15, total: 30, percent: "50.00" });
    expect(clozeAnalytics(db, "7", new Date(Date.now() + 40 * 86400000)).totals.answered).toBe(0); // outside the period
    expect(a.byDay[0]!.medianMs).toBe(2000);
    expect(a.weekly.reduce((n, x) => n + x.answered, 0)).toBe(15);
    expect(a.weekly[0]!.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.comparison.current.answered).toBe(15);
    expect(a.comparison.previous.answered).toBe(0);
    expect(a.progress.at(-1)).toMatchObject({ processed: 15 });
    expect(a.ruleSeries.series.length).toBe(a.byRule.length);
    expect(a.ruleSeries.series[0]!.counts.reduce((n, x) => n + x, 0)).toBe(a.ruleSeries.series[0]!.answered);
    expect(a.ruleSeries.series.every((x) => x.accuracy.length === a.ruleSeries.labels.length)).toBe(true);
  });

  it("counts Cloze time once in the Journey, as its own mode, and old settings still load", async () => {
    const app = Fastify();
    registerErrorHandling(app);
    registerJourneyRoutes(app, db);
    registerSettingsRoutes(app, db, { now: deps.now });
    registerGrammarClozeRoutes(app, db, deps);
    try {
      const old = await app.inject({ method: "POST", url: "/api/v1/settings", payload: { dailyMinutes: { grammar: 15, vocabulary: 10, words: 5, books: 10, dictation: 5 }, dailyOrder: ["books", "grammar", "vocabulary", "words", "dictation"] } });
      expect(old.statusCode).toBe(200);
      const { sessionId } = startSession(db, { ...deps, now: () => new Date(Date.now() - 60000) }, "tab");
      const end = Date.now() - 2000;
      recordClozeActivity(db, deps, sessionId, { id: randomUUID(), tabId: "tab", startMs: end - 9000, endMs: end });
      const j = (await app.inject({ url: "/api/v1/journey" })).json();
      expect(j.dailyMinutes.grammarCloze).toBe(10);
      expect(j.dailyOrder).toContain("grammarCloze");
      expect(j.totals.grammarCloze).toBe(9000);
      expect(j.totals.grammar).toBe(0);
      const total = Object.values(j.totals as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(total).toBe(9000); // no double counting
      const set = await app.inject({ method: "POST", url: "/api/v1/settings", payload: { clozeTaskCount: 20, dailyMinutes: { grammar: 15, vocabulary: 10, words: 5, books: 10, dictation: 5, grammarCloze: 12 } } });
      expect(set.statusCode).toBe(200);
      expect((await app.inject({ url: "/api/v1/journey" })).json().dailyMinutes.grammarCloze).toBe(12);
      const a = await app.inject({ url: "/api/v1/grammar-cloze/analytics?days=7" });
      expect(a.statusCode).toBe(200);
      expect((await app.inject({ url: "/api/v1/grammar-cloze/analytics?days=3" })).statusCode).toBe(400);
      const ov = (await app.inject({ url: "/api/v1/grammar-cloze/overview" })).json();
      expect(ov).toMatchObject({ available: true, taskCount: 20, activeSession: { id: sessionId } });
    } finally {
      await app.close();
    }
  });
});
