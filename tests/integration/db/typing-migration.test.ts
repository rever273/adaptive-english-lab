import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

async function setup(): Promise<Db> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  return db;
}

describe("typing migration 026 (triggers and indexes)", () => {
  it("reaches schema version 26 and applies the typing tables", async () => {
    const d = await setup();
    expect((d.prepare("SELECT MAX(version) AS n FROM schema_migrations").get() as { n: number }).n).toBe(26);
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'typing_%'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["typing_books", "typing_sessions", "typing_word_bank", "typing_words", "typing_xp_events"]);
  });

  it("freezes a finished session: no update is allowed", async () => {
    const d = await setup();
    const id = "s1";
    d.prepare("INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at) VALUES (?, 'words', 'active', 1, 1, '{}', '{\"words\":[]}', 'now')").run(id);
    d.prepare("UPDATE typing_sessions SET status='completed', ended_at='later' WHERE id=?").run(id);
    expect(() => d.prepare("UPDATE typing_sessions SET status='active' WHERE id=?").run(id)).toThrow(/frozen|never changes/);
  });

  it("allows only destroyed_at to change once in typing_words", async () => {
    const d = await setup();
    d.prepare("INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at) VALUES ('s2', 'words', 'active', 1, 1, '{}', '{\"words\":[{\"planIndex\":0,\"lemma\":\"cat\"}]}', 'now')").run();
    d.prepare("INSERT INTO typing_words(id, session_id, plan_index, appearance_order, lemma, source, shown_at) VALUES ('w1', 's2', 0, 0, 'cat', 'general', 'now')").run();
    d.prepare("UPDATE typing_words SET destroyed_at = 'now' WHERE id = 'w1'").run();
    expect(() => d.prepare("UPDATE typing_words SET destroyed_at = 'later' WHERE id = 'w1'").run()).toThrow(/only destroyed_at/);
    expect(() => d.prepare("UPDATE typing_words SET lemma = 'dog' WHERE id = 'w1'").run()).toThrow(/only destroyed_at/);
  });

  it("rejects XP without a completed session", async () => {
    const d = await setup();
    d.prepare("INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at) VALUES ('s3', 'words', 'active', 1, 1, '{}', '{\"words\":[]}', 'now')").run();
    expect(() => d.prepare("INSERT INTO typing_xp_events(id, session_id, amount, rule_version, created_at) VALUES ('x1', 's3', 10, 'typing-xp-v1', 'now')").run()).toThrow(/completed session/);
  });

  it("enforces one active session and one completed level per mode via unique indexes", async () => {
    const d = await setup();
    d.prepare("INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at) VALUES ('a', 'words', 'active', 1, 1, '{}', '{\"words\":[]}', 'now')").run();
    expect(() => d.prepare("INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at) VALUES ('b', 'words', 'active', 2, 1, '{}', '{\"words\":[]}', 'now')").run()).toThrow(/UNIQUE|typing_one_active/);
  });
});
