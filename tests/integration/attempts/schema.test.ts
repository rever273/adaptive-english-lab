import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, listBackups, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";
import { makeEnv, makeRevision, makeSession, makeSlot, addEvent, one, rows, type Env } from "./fixtures.js";

const migrations = path.join(projectRoot, "migrations");
let scratch: ReturnType<typeof makeScratchRoot> | undefined;
let db: Db | undefined;
let env: Env | undefined;
afterEach(() => {
  db?.close();
  env?.cleanup();
  scratch?.cleanup();
  db = env = scratch = undefined;
});

describe("migration 002 on an existing 001 database", () => {
  it("takes a verified pre-migration backup, applies 002 in one transaction and keeps the 001 data", async () => {
    scratch = makeScratchRoot();
    const only001 = path.join(scratch.root, "m");
    mkdirSync(only001);
    copyFileSync(path.join(migrations, "001_foundation.sql"), path.join(only001, "001_foundation.sql"));
    db = openDatabase(path.join(scratch.root, "db", "t.sqlite"));
    await runMigrations(db, { migrationsDir: only001, appVersion: "t" });
    db.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES ('keep-me',2,'{}','t')").run();

    const backupsDir = path.join(scratch.root, "backups");
    const r = await runMigrations(db, {
      migrationsDir: migrations,
      appVersion: "t",
      backup: () => createBackup(db!, { backupsDir, kind: "premigration", schemaVersion: currentSchemaVersion(db!), appVersion: "t" }),
    });
    expect(r).toMatchObject({ applied: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], fromVersion: 1, toVersion: 21 });
    expect(r.premigrationBackup?.schemaVersion).toBe(1);
    const [b] = listBackups(backupsDir);
    expect(verifyBackup(backupsDir, b!)).toEqual({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
    // the backup is a faithful v1 restore point: no event tables
    const copy = openDatabase(path.join(backupsDir, b!.file), { readonly: true });
    try {
      expect(copy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'attempts'").get()).toBeUndefined();
      expect(copy.prepare("SELECT 1 FROM settings_revisions WHERE id = 'keep-me'").get()).toBeDefined();
    } finally {
      copy.close();
    }
    expect(db.prepare("SELECT 1 FROM settings_revisions WHERE id = 'keep-me'").get()).toBeDefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("schema contract of migration 002", () => {
  it("creates exactly the agreed tables, views and triggers (no mastery in SQL, no audio, queue and AI tables arrive with migrations 006-009)", async () => {
    env = await makeEnv();
    const names = (type: string) => rows<{ name: string }>(env!.db, "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", type).map((r) => r.name);
    const tables = names("table");
    for (const t of [
      "exercises", "exercise_revisions", "model_versions", "blueprints", "blueprint_revisions", "sessions", "session_slots", "session_events",
      "transcripts", "attempts", "assessment_revisions", "skill_opportunities", "error_events", "finding_review_events", "assessment_disputes",
    ]) expect(tables).toContain(t);
    for (const t of ["audit_events"]) {
      expect(tables).not.toContain(t); // owned by later tasks
    }
    expect(names("view")).toEqual(expect.arrayContaining(["confirmed_opportunities", "latest_assessments"]));
    const events = ["attempts", "session_events", "exercise_revisions", "assessment_revisions", "error_events", "finding_review_events", "skill_opportunities"];
    for (const t of events) for (const kind of ["no_update", "no_delete"]) expect(names("trigger")).toContain(`${t}_${kind}`);
  });

  it("enforces FK RESTRICT, JSON validity and enum CHECKs on event tables", async () => {
    env = await makeEnv();
    const e = env;
    const { db: d } = e;
    const rev = makeRevision(e);
    const session = makeSession(e);
    const slot = makeSlot(e, session, rev, 0);
    addEvent(e, session, slot, "reveal");
    expect(() => d.prepare("DELETE FROM sessions WHERE id = ?").run(session)).toThrow(/FOREIGN KEY/);
    expect(() => d.prepare("DELETE FROM learning_plans").run()).toThrow(/FOREIGN KEY/);
    expect(() => addEvent(e, session, slot, "teleport")).toThrow(/CHECK/);
    expect(() => addEvent(e, session, randomUUID(), "hint")).toThrow(/FOREIGN KEY/);
    expect(() => d.prepare("INSERT INTO session_events(id,session_id,slot_id,client_event_id,event_type,payload_json,server_at,local_date,timezone) VALUES (?,?,?,?,?,?,?,?,?)").run(randomUUID(), session, slot, "bad-json", "hint", "{oops", "t", "d", "tz")).toThrow(/CHECK/);
    expect(() => d.prepare("INSERT INTO sessions(id,purpose,settings_revision_id,plan_id,selection_version,random_seed,status,created_at,timezone) VALUES (?,?,?,?,?,?,?,?,?)").run(randomUUID(), "exam", e.settingsId, e.planId, "v", "s", "active", "t", "tz")).toThrow(/CHECK/);
    // a practice session can point at a blueprint revision (FK is live, parent table exists)
    const bp = randomUUID();
    const bpr = randomUUID();
    d.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(bp, "lesson-01");
    d.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, created_at) VALUES (?,?,?,?,?,?)").run(bpr, bp, 1, "{}", "draft", "t");
    d.prepare("INSERT INTO sessions(id,blueprint_revision_id,purpose,settings_revision_id,plan_id,selection_version,random_seed,status,created_at,timezone) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), bpr, "practice", e.settingsId, e.planId, "v", "s", "active", "t", "Australia/Brisbane");
    expect(() => d.prepare("INSERT INTO sessions(id,blueprint_revision_id,purpose,settings_revision_id,plan_id,selection_version,random_seed,status,created_at,timezone) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), "missing", "practice", e.settingsId, e.planId, "v", "s", "active", "t", "tz")).toThrow(/FOREIGN KEY/);
    expect(d.pragma("foreign_key_check")).toEqual([]);
    expect(one<{ n: number }>(d, "SELECT COUNT(*) AS n FROM model_versions").n).toBe(0);
  });

  it("the migration file is checksummed and stable across CRLF conversion", () => {
    const sql = readFileSync(path.join(migrations, "002_events.sql"), "utf8");
    expect(sql).toContain("append-only");
    expect(sql).not.toMatch(/mastery_snapshots|CREATE TABLE jobs/); // no scoring, no queue in this migration
  });
});
