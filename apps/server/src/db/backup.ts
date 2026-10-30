import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./open.js";

export type BackupKind = "daily" | "premigration" | "manual";

/** Sidecar manifest written next to every verified backup. A .sqlite file without one is not a backup. */
export interface BackupManifest {
  file: string;
  kind: BackupKind;
  sha256: string;
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  status: "ready";
}

export class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

export interface IntegrityResult {
  integrity: string;
  foreignKeyViolations: number;
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** integrity_check + foreign_key_check on a standalone copy (never on the live WAL database). */
export function checkDatabaseFile(file: string): IntegrityResult {
  const db = new Database(file, { fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const integrity = rows.map((r) => r.integrity_check).join("; ");
    const fk = db.pragma("foreign_key_check") as unknown[];
    return { integrity, foreignKeyViolations: fk.length };
  } finally {
    db.close();
  }
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface CreateBackupOptions {
  backupsDir: string;
  kind: BackupKind;
  schemaVersion: number;
  appVersion: string;
  now?: Date;
}

/**
 * SQLite online backup API -> temp file under the backups root -> converted to a standalone
 * rollback-journal file -> integrity_check/foreign_key_check -> SHA256 -> atomic rename -> manifest.
 * Server-generated file name only (spec/11).
 */
export async function createBackup(db: Db, opts: CreateBackupOptions): Promise<BackupManifest> {
  mkdirSync(opts.backupsDir, { recursive: true });
  const now = opts.now ?? new Date();
  const base = `${opts.kind}-${stamp(now)}-${randomBytes(3).toString("hex")}`;
  const finalPath = path.join(opts.backupsDir, `${base}.sqlite`);
  const tmpPath = path.join(opts.backupsDir, `${base}.sqlite.tmp`);
  try {
    await db.backup(tmpPath);
    const copy = new Database(tmpPath);
    try {
      copy.pragma("journal_mode = DELETE");
    } finally {
      copy.close();
    }
    const check = checkDatabaseFile(tmpPath);
    if (check.integrity !== "ok" || check.foreignKeyViolations !== 0) {
      throw new BackupError(
        "BACKUP_INVALID",
        `backup failed verification (integrity=${check.integrity}, fk_violations=${check.foreignKeyViolations})`,
      );
    }
    const sha256 = sha256File(tmpPath);
    renameSync(tmpPath, finalPath);
    const manifest: BackupManifest = {
      file: path.basename(finalPath),
      kind: opts.kind,
      sha256,
      schemaVersion: opts.schemaVersion,
      appVersion: opts.appVersion,
      createdAt: now.toISOString(),
      status: "ready",
    };
    const manifestPath = `${finalPath}.json`;
    writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
    renameSync(`${manifestPath}.tmp`, manifestPath);
    return manifest;
  } catch (err) {
    rmSync(tmpPath, { force: true });
    rmSync(finalPath, { force: true });
    throw err;
  }
}

export function listBackups(backupsDir: string): BackupManifest[] {
  if (!existsSync(backupsDir)) return [];
  const out: BackupManifest[] = [];
  for (const name of readdirSync(backupsDir)) {
    if (!name.endsWith(".sqlite.json")) continue;
    try {
      const m = JSON.parse(readFileSync(path.join(backupsDir, name), "utf8")) as BackupManifest;
      if (m.status === "ready" && existsSync(path.join(backupsDir, m.file))) out.push(m);
    } catch {
      // unreadable manifest: not a usable backup, left untouched on disk
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Re-verifies a stored backup: checksum + integrity + foreign keys. */
export function verifyBackup(backupsDir: string, manifest: BackupManifest): IntegrityResult & { checksumOk: boolean } {
  const file = path.join(backupsDir, manifest.file);
  const checksumOk = sha256File(file) === manifest.sha256;
  try {
    return { checksumOk, ...checkDatabaseFile(file) };
  } catch (err) {
    // a damaged file may not even open: report it as a failed verification instead of throwing
    return { checksumOk, integrity: `unreadable: ${(err as Error).message}`, foreignKeyViolations: -1 };
  }
}

/** Retention (spec/11): newest 7 daily + 3 pre-migration; manual kept. Never leaves zero verified backups. */
export function pruneBackups(backupsDir: string, keep = { daily: 7, premigration: 3 }): string[] {
  const all = listBackups(backupsDir);
  const removed: string[] = [];
  for (const kind of ["daily", "premigration"] as const) {
    const surplus = all.filter((b) => b.kind === kind).slice(keep[kind]);
    for (const b of surplus) {
      const remaining = all.length - removed.length;
      if (remaining <= 1) break;
      rmSync(path.join(backupsDir, b.file), { force: true });
      rmSync(path.join(backupsDir, `${b.file}.json`), { force: true });
      removed.push(b.file);
    }
  }
  return removed;
}

/** True when a daily backup newer than 24 h exists (at most one clean-start backup per day). */
export function hasRecentDailyBackup(backupsDir: string, now = new Date()): boolean {
  return listBackups(backupsDir).some((b) => b.kind === "daily" && now.getTime() - Date.parse(b.createdAt) < 24 * 3600 * 1000);
}

export function fileSize(file: string): number {
  return statSync(file).size;
}
