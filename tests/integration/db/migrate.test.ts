import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_V1, SettingsV1Schema } from "../../../packages/contracts/src/index.js";
import { createBackup, checkDatabaseFile, listBackups, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { readDbInfo } from "../../../apps/server/src/db/info.js";
import { checksumSql, currentSchemaVersion, MigrationError, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const realMigrations = path.join(projectRoot, "migrations");
let scratch: ReturnType<typeof makeScratchRoot>;
let db: Db | null = null;

beforeEach(() => {
  scratch = makeScratchRoot();
});
afterEach(() => {
  db?.close();
  db = null;
  scratch.cleanup();
});

function open(): Db {
  db = openDatabase(path.join(scratch.root, "db", "t.sqlite"));
  return db;
}

/** Copies the real 001 into a private dir so tests can add/alter migrations without touching the repo. */
function migrationsCopy(): string {
  const dir = path.join(scratch.root, "migrations");
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(realMigrations, "001_foundation.sql"), path.join(dir, "001_foundation.sql"));
  return dir;
}

describe("real SQLite via better-sqlite3 (actual driver, not a mock)", () => {
  it("reports real pragmas, JSON support and SQLite version", () => {
    const info = readDbInfo(open());
    expect(info.pragmas).toEqual({ journal_mode: "wal", foreign_keys: 1, busy_timeout: 5000, synchronous: 2 });
    expect(info.jsonSupport).toBe(true);
    expect(info.sqliteVersion).toMatch(/^3\.\d+\.\d+/);
    expect(info.driver).toBe("better-sqlite3");
  });

  it("enforces foreign keys and JSON CHECK constraints after migration 001", async () => {
    const d = open();
    await runMigrations(d, { migrationsDir: realMigrations, appVersion: "test" });
    expect(() =>
      d.prepare("INSERT INTO skill_revisions(id,skill_id,taxonomy_id,label_en,domain,family,active) VALUES ('x','no-such-skill','no-such-tax','l','d','f',1)").run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() => d.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES ('s2',2,'{not json',?)").run(new Date().toISOString())).toThrow(/CHECK/);
    expect(() => d.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES ('s0',0,'{}',?)").run(new Date().toISOString())).toThrow(/CHECK/);
    expect(() => d.prepare("DELETE FROM taxonomy_versions").run()).toThrow(/FOREIGN KEY/); // ON DELETE RESTRICT
  });
});

describe("migration 001 content", () => {
  it("001 creates only the agreed foundation tables and seeds taxonomy-v1 + settings revision 1", async () => {
    const d = open();
    const r = await runMigrations(d, { migrationsDir: migrationsCopy(), appVersion: "test" });
    expect(r).toMatchObject({ applied: [1], fromVersion: 0, toVersion: 1, premigrationBackup: null, backupSkippedReason: "fresh_database" });

    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(["learning_plans", "schema_migrations", "settings_revisions", "skill_revisions", "skills", "taxonomy_versions"]);

    const tax = d.prepare("SELECT * FROM taxonomy_versions").all() as Array<{ version: string; manifest_hash: string }>;
    expect(tax).toHaveLength(1);
    expect(tax[0]!.version).toBe("taxonomy-v1");
    const file = path.join(projectRoot, "content", "taxonomy", "taxonomy-v1.json");
    expect(tax[0]!.manifest_hash).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));

    const manifest = JSON.parse(readFileSync(file, "utf8")) as { skills: Array<{ id: string; domain: string; family: string }> };
    const skills = d.prepare("SELECT id FROM skills ORDER BY id").all() as Array<{ id: string }>;
    expect(skills.map((s) => s.id)).toEqual(manifest.skills.map((s) => s.id).sort());
    expect(skills).toHaveLength(80);
    const rev = d.prepare("SELECT COUNT(*) AS n FROM skill_revisions WHERE active=1").get() as { n: number };
    expect(rev.n).toBe(80);

    const settings = d.prepare("SELECT revision, values_json FROM settings_revisions").all() as Array<{ revision: number; values_json: string }>;
    expect(settings).toHaveLength(1);
    const { difficultyMin: _min, difficultyMax: _max, ...legacyDefaults } = DEFAULT_SETTINGS_V1;
    expect(SettingsV1Schema.parse(JSON.parse(settings[0]!.values_json))).toEqual(legacyDefaults);

    expect(d.pragma("foreign_key_check")).toEqual([]);
    const ids = (d.prepare("SELECT id FROM taxonomy_versions UNION ALL SELECT id FROM settings_revisions").all() as Array<{ id: string }>).map((x) => x.id);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is idempotent: a second run applies nothing and keeps the original applied_at", async () => {
    const d = open();
    await runMigrations(d, { migrationsDir: realMigrations, appVersion: "test" });
    const before = d.prepare("SELECT * FROM schema_migrations").all();
    expect(before).toHaveLength(22);
    const r = await runMigrations(d, { migrationsDir: realMigrations, appVersion: "other" });
    expect(r.applied).toEqual([]);
    expect(r.backupSkippedReason).toBe("nothing_pending");
    expect(d.prepare("SELECT * FROM schema_migrations").all()).toEqual(before);
  });
});

describe("runner safety", () => {
  it("rolls back a failing migration completely and keeps the previous version", async () => {
    const dir = migrationsCopy();
    const d = open();
    await runMigrations(d, { migrationsDir: dir, appVersion: "test" });

    writeFileSync(path.join(dir, "002_broken.sql"), "CREATE TABLE half_done (id INTEGER PRIMARY KEY);\nINSERT INTO half_done VALUES (1);\nINSERT INTO no_such_table VALUES (1);\n");
    let thrown: unknown;
    await runMigrations(d, {
      migrationsDir: dir,
      appVersion: "test",
      backup: () => createBackup(d, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 1, appVersion: "test" }),
    }).catch((e) => (thrown = e));
    expect(thrown).toBeInstanceOf(MigrationError);
    expect((thrown as MigrationError).code).toBe("MIGRATION_FAILED");
    expect(d.prepare("SELECT 1 FROM sqlite_master WHERE name='half_done'").get()).toBeUndefined();
    expect(currentSchemaVersion(d)).toBe(1);
    expect(d.inTransaction).toBe(false);
    expect(d.prepare("SELECT COUNT(*) AS n FROM skills").get()).toEqual({ n: 80 }); // history intact
    // the pre-migration backup taken before the failed attempt is still a valid restore point
    const [b] = listBackups(path.join(scratch.root, "backups"));
    expect(b?.kind).toBe("premigration");
    expect(verifyBackup(path.join(scratch.root, "backups"), b!)).toMatchObject({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
  });

  it("rolls back a migration that leaves foreign key violations", async () => {
    const dir = migrationsCopy();
    const d = open();
    await runMigrations(d, { migrationsDir: dir, appVersion: "test" });
    writeFileSync(
      path.join(dir, "002_fk_violation.sql"),
      "PRAGMA defer_foreign_keys = ON;\nINSERT INTO skills(id, created_at) VALUES ('tmp.skill', 'now');\nINSERT INTO skill_revisions(id,skill_id,taxonomy_id,label_en,domain,family,active) VALUES ('r','tmp.skill','missing','l','d','f',1);\n",
    );
    await expect(
      runMigrations(d, {
        migrationsDir: dir,
        appVersion: "test",
        backup: () => createBackup(d, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 1, appVersion: "test" }),
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(d.prepare("SELECT 1 FROM skills WHERE id='tmp.skill'").get()).toBeUndefined();
    expect(currentSchemaVersion(d)).toBe(1);
  });

  it("takes a verified pre-migration backup before applying 002 on an existing database", async () => {
    const dir = migrationsCopy();
    const d = open();
    await runMigrations(d, { migrationsDir: dir, appVersion: "test" });
    writeFileSync(path.join(dir, "002_extra.sql"), "CREATE TABLE extra (id INTEGER PRIMARY KEY);\n");
    const backupsDir = path.join(scratch.root, "backups");
    const r = await runMigrations(d, {
      migrationsDir: dir,
      appVersion: "test",
      backup: () => createBackup(d, { backupsDir, kind: "premigration", schemaVersion: currentSchemaVersion(d), appVersion: "test" }),
    });
    expect(r.applied).toEqual([2]);
    expect(r.premigrationBackup).not.toBeNull();
    // the backup holds the pre-migration state: schema v1, no `extra` table
    const copy = openDatabase(path.join(backupsDir, r.premigrationBackup!.file), { readonly: true });
    try {
      expect(currentSchemaVersion(copy)).toBe(1);
      expect(copy.prepare("SELECT 1 FROM sqlite_master WHERE name='extra'").get()).toBeUndefined();
    } finally {
      copy.close();
    }
  });

  it("refuses to run when an applied migration file was edited (checksum)", async () => {
    const dir = migrationsCopy();
    const d = open();
    await runMigrations(d, { migrationsDir: dir, appVersion: "test" });
    writeFileSync(path.join(dir, "001_foundation.sql"), readFileSync(path.join(dir, "001_foundation.sql"), "utf8") + "\n-- tampered\n");
    await expect(runMigrations(d, { migrationsDir: dir, appVersion: "test" })).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
  });

  it("does not treat Windows CRLF line endings as a change", () => {
    const sql = readFileSync(path.join(realMigrations, "001_foundation.sql"), "utf8");
    expect(checksumSql(sql.replace(/\n/g, "\r\n"))).toBe(checksumSql(sql));
  });

  it("refuses a database whose schema is newer than the application", async () => {
    const d = open();
    await runMigrations(d, { migrationsDir: realMigrations, appVersion: "test" });
    d.prepare("INSERT INTO schema_migrations VALUES (999, 'x', 'now', 'future')").run();
    await expect(runMigrations(d, { migrationsDir: realMigrations, appVersion: "test" })).rejects.toMatchObject({ code: "SCHEMA_NEWER_THAN_APP" });
  });

  it("rejects non-contiguous migration numbering", async () => {
    const dir = migrationsCopy();
    writeFileSync(path.join(dir, "003_gap.sql"), "SELECT 1;");
    await expect(runMigrations(open(), { migrationsDir: dir, appVersion: "test" })).rejects.toMatchObject({ code: "MIGRATION_LAYOUT" });
  });
});

describe("settings survive reopen (restart durability)", () => {
  it("keeps appended settings revisions after close and reopen", async () => {
    const d = open();
    await runMigrations(d, { migrationsDir: realMigrations, appVersion: "test" });
    const v2 = JSON.stringify({ ...DEFAULT_SETTINGS_V1, taskCount: 12 });
    d.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES ('rev3',3,?,?)").run(v2, new Date().toISOString());
    d.close();
    db = null;
    const again = open();
    const rows = again.prepare("SELECT revision, values_json FROM settings_revisions ORDER BY revision").all() as Array<{ revision: number; values_json: string }>;
    expect(rows.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(SettingsV1Schema.parse(JSON.parse(rows[2]!.values_json)).taskCount).toBe(12);
    expect(checkDatabaseFile(path.join(scratch.root, "db", "t.sqlite"))).toEqual({ integrity: "ok", foreignKeyViolations: 0 });
  });
});

