import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { importCleaned } from "../../../apps/server/src/domain/grammarCloze/importer.js";
import { excludeItem, sessionView, startSession, submitAnswer } from "../../../apps/server/src/domain/grammarCloze/repository.js";
import { activityProgress } from "../../../apps/server/src/domain/sessions/xp.js";
import { awardModeXp } from "../../../apps/server/src/domain/sessions/modeXp.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };
let db: Db;
let cleanup: () => void;
beforeEach(async () => {
  const scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  cleanup = () => { db.close(); scratch.cleanup(); };
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  const items = Array.from({ length: 20 }, (_, i) => ({ sourceIndex: i + 1, gappedText: `She ___ to school number ${i + 1}.`, solution: "goes", distractors: ["go"], filledText: `She goes to school number ${i + 1}.`, sourceTopic: "present_simple", skillId: null, skillConfidence: "general" as const, status: "validated" as const, flagReasons: [], contentHash: `h${i}` }));
  importCleaned(db, { source: "zanichelli", sourceSha256: "s", cleanVersion: "c", classifierVersion: "k", configSha256: "x", items }, { apply: true });
});
afterEach(() => cleanup());

describe("XP for the newer modes", () => {
  it("Grammar Cloze: 10 Grammar XP per RIGHT answer, once per answer, none for a mistake or an exclusion", () => {
    const { sessionId } = startSession(db, deps, "t");
    const v = sessionView(db, sessionId);
    expect(activityProgress(db, "grammar").total).toBe(0);
    const id = randomUUID();
    submitAnswer(db, deps, sessionId, { id, position: 1, chosen: "goes" });
    submitAnswer(db, deps, sessionId, { id, position: 1, chosen: "goes" }); // the same click twice
    submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 2, chosen: v.slots[1]!.options.find((o) => o !== "goes")! }); // a mistake earns nothing
    excludeItem(db, deps, v.slots[2]!.itemId, { sessionId });
    expect(activityProgress(db, "grammar").total).toBe(10);
    expect(activityProgress(db, "vocabulary").total).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM mode_xp_events").get()).toEqual({ n: 1 });
    expect(activityProgress(db, "grammar")).toMatchObject({ level: 1, withinLevel: 10, threshold: 100 });
  });

  it("the ledger is append-only and refuses XP without the answer, the completed lesson or the message behind it", () => {
    const at = new Date().toISOString();
    expect(() => awardModeXp(db, { id: randomUUID(), source: "grammarCloze", sourceId: "nothing", amount: 10, at })).toThrow(/requires/);
    expect(() => awardModeXp(db, { id: randomUUID(), source: "wordLesson", sourceId: "nothing", amount: 50, at })).toThrow(/requires/);
    expect(() => awardModeXp(db, { id: randomUUID(), source: "conversation", sourceId: "nothing", amount: 10, at })).toThrow(/requires/);
    const { sessionId } = startSession(db, deps, "t");
    submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 1, chosen: "goes" });
    expect(() => db.prepare("UPDATE mode_xp_events SET amount = 999").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM mode_xp_events").run()).toThrow(/append-only/);
  });

  it("Conversation has its own track that starts at zero", () => {
    expect(activityProgress(db, "conversation")).toMatchObject({ total: 0, level: 1 });
  });
});
