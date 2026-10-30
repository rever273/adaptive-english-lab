import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, hasRecentDailyBackup, listBackups, pruneBackups, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { prepareDatabase } from "../../../apps/server/src/db/prepare.js";
import { makeScratchRoot, projectRoot, testConfig } from "../helpers.js";

let scratch: ReturnType<typeof makeScratchRoot>;
let db: Db | null = null;
const backupsDir = () => path.join(scratch.root, "backups");

beforeEach(async () => {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "t.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
});
afterEach(() => {
  db?.close();
  db = null;
  scratch.cleanup();
});

describe("SQLite backup API", () => {
  it("includes data that is still only in the WAL and yields a standalone, verified file", async () => {
    // Insert after open without checkpointing: rows live in the -wal file, which a plain file copy would miss.
    db!.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES ('wal-row',2,'{}',?)").run(new Date().toISOString());
    expect(existsSync(path.join(scratch.root, "db", "t.sqlite-wal"))).toBe(true);

    const m = await createBackup(db!, { backupsDir: backupsDir(), kind: "manual", schemaVersion: 1, appVersion: "test" });
    expect(m).toMatchObject({ kind: "manual", schemaVersion: 1, status: "ready" });
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(backupsDir()).sort()).toEqual([m.file, `${m.file}.json`].sort()); // no leftover .tmp, no -wal/-shm
    expect(verifyBackup(backupsDir(), m)).toEqual({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });

    const copy = openDatabase(path.join(backupsDir(), m.file), { readonly: true });
    try {
      expect((copy.prepare("SELECT COUNT(*) AS n FROM settings_revisions").get() as { n: number }).n).toBe(2);
      expect((copy.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number }).n).toBe(80);
    } finally {
      copy.close();
    }
  });

  it("detects a tampered backup through the checksum", async () => {
    const m = await createBackup(db!, { backupsDir: backupsDir(), kind: "manual", schemaVersion: 1, appVersion: "test" });
    const file = path.join(backupsDir(), m.file);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(file, bytes);
    const v = verifyBackup(backupsDir(), m);
    expect(v.checksumOk).toBe(false);
    // a flipped byte may land in unused page space (integrity still "ok") or break the file: either way the checksum is the guard
    expect(v.checksumOk && v.integrity === "ok" && v.foreignKeyViolations === 0).toBe(false);
  });

  it("ignores a .sqlite file that has no manifest (incomplete backup)", async () => {
    const m = await createBackup(db!, { backupsDir: backupsDir(), kind: "manual", schemaVersion: 1, appVersion: "test" });
    copyFileSync(path.join(backupsDir(), m.file), path.join(backupsDir(), "orphan.sqlite"));
    expect(listBackups(backupsDir()).map((b) => b.file)).toEqual([m.file]);
  });

  it("keeps 7 daily + 3 pre-migration, never deletes manual or the last verified backup", async () => {
    const base = Date.parse("2026-10-01T00:00:00Z");
    for (let i = 0; i < 9; i++) {
      await createBackup(db!, { backupsDir: backupsDir(), kind: "daily", schemaVersion: 1, appVersion: "t", now: new Date(base + i * 86400_000) });
    }
    for (let i = 0; i < 5; i++) {
      await createBackup(db!, { backupsDir: backupsDir(), kind: "premigration", schemaVersion: 1, appVersion: "t", now: new Date(base + i * 3600_000) });
    }
    await createBackup(db!, { backupsDir: backupsDir(), kind: "manual", schemaVersion: 1, appVersion: "t", now: new Date(base) });
    const removed = pruneBackups(backupsDir());
    expect(removed).toHaveLength(4);
    const left = listBackups(backupsDir());
    expect(left.filter((b) => b.kind === "daily")).toHaveLength(7);
    expect(left.filter((b) => b.kind === "premigration")).toHaveLength(3);
    expect(left.filter((b) => b.kind === "manual")).toHaveLength(1);
    // newest survive
    expect(left.filter((b) => b.kind === "daily").map((b) => b.createdAt)).toContain(new Date(base + 8 * 86400_000).toISOString());
    expect(readdirSync(backupsDir()).filter((f) => f.endsWith(".sqlite"))).toHaveLength(11);
    expect(hasRecentDailyBackup(backupsDir(), new Date(base + 8.5 * 86400_000))).toBe(true);
    expect(hasRecentDailyBackup(backupsDir(), new Date(base + 10 * 86400_000))).toBe(false);
  });
});

describe("startup preparation", () => {
  it("first start creates DB + schema without backup; next start takes one daily backup and no more that day", async () => {
    db!.close();
    db = null;
    const cfg = testConfig(path.join(scratch.root, "app"), 4999);
    const first = await prepareDatabase(cfg);
    expect(first.createdNewDatabase).toBe(true);
    expect(first.migration.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(first.dailyBackup).toBeNull();
    first.db.close();

    const second = await prepareDatabase(cfg);
    expect(second.migration.applied).toEqual([]);
    expect(second.dailyBackup?.kind).toBe("daily");
    second.db.close();

    const third = await prepareDatabase(cfg);
    expect(third.dailyBackup).toBeNull();
    third.db.close();
    expect(listBackups(cfg.backupsDir)).toHaveLength(1);
  });

  it("never replaces a corrupt database with an empty one", async () => {
    db!.close();
    db = null;
    const cfg = testConfig(path.join(scratch.root, "app"), 4999);
    const dbDir = path.dirname(cfg.dbPath);
    const garbage = Buffer.from("this is definitely not a sqlite database ".repeat(200));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(cfg.dbPath, garbage);
    await expect(prepareDatabase(cfg)).rejects.toThrow();
    expect(readFileSync(cfg.dbPath).equals(garbage)).toBe(true);
  });
});
