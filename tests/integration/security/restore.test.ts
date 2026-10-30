// TASK_018 / A10, A16: backup corruption is refused, a valid restore brings back EXACTLY the backup's raw events (and exports what it rolls back),
// any failure after the swap puts the previous data back, and an id can never be a path.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, listBackups } from "../../../apps/server/src/db/backup.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { RestoreError, restoreBackup } from "../../../apps/server/src/db/restore.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { projectRoot } from "../helpers.js";
import { makeEnv, makeRevision, makeSession, makeSlot, addEvent, exactSetAssessor, one, rows, type Env } from "../attempts/fixtures.js";

let env: Env | null = null;
afterEach(() => {
  try {
    env?.cleanup();
  } catch {
    /* already closed */
  }
  env = null;
});

const dbFile = (e: Env) => path.join(e.scratch.root, "db", "t.sqlite");
const backupsDir = (e: Env) => path.join(e.scratch.root, "backups");
const base = (e: Env) => ({ dbPath: dbFile(e), backupsDir: backupsDir(e), migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });

/** one more answered task through the real attempt path */
function answerOne(e: Env, text: string): string {
  const revisionId = makeRevision(e);
  const sessionId = makeSession(e);
  const slotId = makeSlot(e, sessionId, revisionId, 0);
  addEvent(e, sessionId, slotId, "reveal");
  const deps = { ...e.deps, assessor: exactSetAssessor() };
  const r = recordAttempt(e.db, deps, { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
  addEvent(e, sessionId, slotId, "continue");
  void text;
  return r.body.attemptId;
}
const digestOf = (db: ReturnType<typeof openDatabase>, sql: string): string => createHash("sha256").update(JSON.stringify(db.prepare(sql).all())).digest("hex");
const RAW = "SELECT id, slot_id, submission_id, attempt_no, raw_answer_json, submitted_at FROM attempts ORDER BY id";
const EVENTS = "SELECT id, session_id, slot_id, event_type, server_at FROM session_events ORDER BY id";

async function twoStates() {
  env = await makeEnv();
  answerOne(env, "one");
  const backup = await createBackup(env.db, { backupsDir: backupsDir(env), kind: "manual", schemaVersion: 13, appVersion: "test" });
  const atBackup = { raw: digestOf(env.db, RAW), events: digestOf(env.db, EVENTS), attempts: one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts").n };
  const later = [answerOne(env, "two"), answerOne(env, "three")];
  const before = { raw: digestOf(env.db, RAW), events: digestOf(env.db, EVENTS) };
  env.db.pragma("wal_checkpoint(TRUNCATE)");
  env.db.close();
  return { backup, atBackup, later, before };
}

describe("restore: the exact raw history of the backup comes back, and what it rolls back is exported first", () => {
  it("a dry run changes nothing and states how many newer rows would be rolled back", async () => {
    const { backup } = await twoStates();
    const bytes = readFileSync(dbFile(env!));
    const r = await restoreBackup({ ...base(env!), backupId: backup.file, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, rolledBack: { attempts: 2 }, backupSchemaVersion: expect.any(Number), willMigrateOnStart: false });
    expect(r.rolledBack.sessionEvents).toBeGreaterThanOrEqual(4);
    expect(readFileSync(dbFile(env!)).equals(bytes)).toBe(true);
    expect(readdirSync(backupsDir(env!)).filter((f) => f.startsWith("restore-delta"))).toEqual([]);
  });

  it("without the user's explicit confirmation nothing happens", async () => {
    const { backup } = await twoStates();
    const bytes = readFileSync(dbFile(env!));
    for (const confirmId of [undefined, "", "manual-20200101T000000Z-aaaaaa.sqlite"]) {
      await expect(restoreBackup({ ...base(env!), backupId: backup.file, confirmId })).rejects.toMatchObject({ code: "RESTORE_NOT_CONFIRMED" });
    }
    expect(readFileSync(dbFile(env!)).equals(bytes)).toBe(true);
  });

  it("a valid, confirmed restore: raw attempts and events equal the backup's exactly; a verified safety backup and a delta export hold the rolled-back rows", async () => {
    const { backup, atBackup, later, before } = await twoStates();
    const r = await restoreBackup({ ...base(env!), backupId: backup.file, confirmId: backup.file });
    expect(r.rolledBack.attempts).toBe(2);
    expect(r.safetyBackup).not.toBeNull();
    expect(r.deltaExport).toMatch(/^restore-delta-\d{8}T\d{6}Z\.json$/);

    const restored = openDatabase(dbFile(env!), { readonly: true });
    try {
      expect(one<{ n: number }>(restored, "SELECT COUNT(*) AS n FROM attempts").n).toBe(atBackup.attempts);
      expect(digestOf(restored, RAW)).toBe(atBackup.raw); // byte-for-byte the same raw answers
      expect(digestOf(restored, EVENTS)).toBe(atBackup.events);
      expect(restored.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      restored.close();
    }
    // the state from before the restore is not lost: the safety backup is a verified, complete copy
    const safety = listBackups(backupsDir(env!)).find((m) => m.file === r.safetyBackup!.file)!;
    const safetyDb = new (await import("better-sqlite3")).default(path.join(backupsDir(env!), safety.file), { readonly: true });
    try {
      expect(createHash("sha256").update(JSON.stringify(safetyDb.prepare(RAW).all())).digest("hex")).toBe(before.raw);
    } finally {
      safetyDb.close();
    }
    // the delta export names exactly the rolled-back attempts
    const delta = JSON.parse(readFileSync(path.join(backupsDir(env!), r.deltaExport!), "utf8")) as { schema_version: string; attempts: Array<{ id: string }>; counts: { attempts: number } };
    expect(delta.schema_version).toBe("restore-delta-v1");
    expect(delta.attempts.map((a) => a.id).sort()).toEqual([...later].sort());
    expect(existsSync(`${dbFile(env!)}.pre-restore`)).toBe(false);
    expect(existsSync(`${dbFile(env!)}.restoring`)).toBe(false);
  });
});

describe("restore refuses what it must not use", () => {
  it("a damaged backup file (flipped bytes, truncation) or a wrong checksum is rejected and the live data is untouched", async () => {
    const { backup } = await twoStates();
    const live = readFileSync(dbFile(env!));
    const file = path.join(backupsDir(env!), backup.file);
    const original = readFileSync(file);

    const flipped = Buffer.from(original);
    flipped[Math.floor(flipped.length / 2)] ^= 0xff;
    writeFileSync(file, flipped);
    await expect(restoreBackup({ ...base(env!), backupId: backup.file, confirmId: backup.file })).rejects.toMatchObject({ code: "RESTORE_BACKUP_INVALID" });

    writeFileSync(file, original.subarray(0, Math.floor(original.length / 3)));
    await expect(restoreBackup({ ...base(env!), backupId: backup.file, confirmId: backup.file })).rejects.toMatchObject({ code: "RESTORE_BACKUP_INVALID" });

    writeFileSync(file, original);
    const manifestPath = `${file}.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256: string };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    await expect(restoreBackup({ ...base(env!), backupId: backup.file, confirmId: backup.file })).rejects.toMatchObject({ code: "RESTORE_BACKUP_INVALID", details: { checksumOk: false } });

    expect(readFileSync(dbFile(env!)).equals(live)).toBe(true);
    expect(readdirSync(backupsDir(env!)).filter((f) => f.startsWith("restore-delta") || f.startsWith("manual-") && f !== backup.file && f !== `${backup.file}.json`)).toEqual([]); // no safety backup for a refused restore
  });

  it("a backup id is a server-generated file name, never a path; unknown ids are refused", async () => {
    await twoStates();
    for (const id of ["../db/t.sqlite", "..\\..\\x.sqlite", "C:\\Windows\\win.ini", "/etc/passwd", "manual-20261030T010203Z-ab12cd.sqlite/../../x", "", "manual-20261030T010203Z-ab12cd.sqlite\u0000.txt", "x".repeat(300)]) {
      await expect(restoreBackup({ ...base(env!), backupId: id, dryRun: true }), id).rejects.toMatchObject({ code: "RESTORE_BAD_ID" });
    }
    await expect(restoreBackup({ ...base(env!), backupId: "manual-20261030T010203Z-ab12cd.sqlite", dryRun: true })).rejects.toMatchObject({ code: "RESTORE_UNKNOWN_BACKUP" });
  });

  it("a backup of a NEWER schema than this program knows is refused (an older program never opens a newer database)", async () => {
    env = await makeEnv();
    env.db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at, app_version) VALUES (99, 'x', ?, 'future')").run(new Date().toISOString());
    const b = await createBackup(env.db, { backupsDir: backupsDir(env), kind: "manual", schemaVersion: 99, appVersion: "future" });
    env.db.prepare("DELETE FROM schema_migrations WHERE version = 99").run();
    env.db.close();
    await expect(restoreBackup({ ...base(env), backupId: b.file, confirmId: b.file })).rejects.toMatchObject({ code: "RESTORE_SCHEMA_NEWER" });
  });
});

describe("restore failure rolls back to the previous data", () => {
  it("a failure after the file swap puts the previous database back exactly; the safety backup stays", async () => {
    const { backup, before } = await twoStates();
    await expect(
      restoreBackup({
        ...base(env!),
        backupId: backup.file,
        confirmId: backup.file,
        afterReplace: () => {
          throw new Error("simulated crash after the swap");
        },
      }),
    ).rejects.toMatchObject({ code: "RESTORE_FAILED", details: { safetyBackup: expect.stringMatching(/^manual-/) } });
    const db = openDatabase(dbFile(env!), { readonly: true });
    try {
      expect(digestOf(db, RAW)).toBe(before.raw);
      expect(digestOf(db, EVENTS)).toBe(before.events);
    } finally {
      db.close();
    }
    expect(existsSync(`${dbFile(env!)}.pre-restore`)).toBe(false);
    expect(listBackups(backupsDir(env!)).filter((m) => m.kind === "manual").length).toBe(2); // the original backup + the safety backup
  });

  it("a backup whose applied migrations do not match this program's files is rolled back after the swap", async () => {
    env = await makeEnv();
    answerOne(env, "x");
    env.db.pragma("wal_checkpoint(TRUNCATE)");
    const good = one<{ checksum: string }>(env.db, "SELECT checksum FROM schema_migrations WHERE version = 2").checksum;
    env.db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 2").run();
    const bad = await createBackup(env.db, { backupsDir: backupsDir(env), kind: "manual", schemaVersion: 13, appVersion: "test" });
    env.db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2").run(good);
    answerOne(env, "y"); // newer data that must survive the failed restore
    const raw = digestOf(env.db, RAW);
    env.db.pragma("wal_checkpoint(TRUNCATE)");
    env.db.close();
    await expect(restoreBackup({ ...base(env), backupId: bad.file, confirmId: bad.file })).rejects.toMatchObject({ code: "RESTORE_CHECKSUM" });
    const db = openDatabase(dbFile(env), { readonly: true });
    try {
      expect(digestOf(db, RAW)).toBe(raw);
      expect(rows<{ checksum: string }>(db, "SELECT checksum FROM schema_migrations WHERE version = 2")[0]!.checksum).not.toBe("tampered");
    } finally {
      db.close();
    }
  });
});
