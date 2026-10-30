import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BackupError, checkDatabaseFile, createBackup, listBackups, verifyBackup, type BackupManifest } from "./backup.js";
import { currentSchemaVersion, loadMigrations } from "./migrate.js";
import { assertDatabaseHealthy, openDatabase } from "./open.js";

/** The only accepted form of a backup id: a server-generated file name (spec/11). Anything else, e.g. a path, is refused before any file is touched. */
export const BACKUP_ID_RE = /^(daily|premigration|manual)-\d{8}T\d{6}Z-[0-9a-f]{6}\.sqlite$/;

export class RestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

export interface RestoreOptions {
  dbPath: string;
  backupsDir: string;
  migrationsDir: string;
  appVersion: string;
  backupId: string;
  /** the user's explicit command: must repeat the backup id. Not needed for a dry run. */
  confirmId?: string;
  dryRun?: boolean;
  now?: Date;
  /** test hook: runs after the file was replaced and before the checks; throwing triggers the rollback */
  afterReplace?: () => void;
}

/** What a restore would take away: rows that exist now but not in the backup. The raw history of the backup itself is never changed. */
export interface RolledBack {
  attempts: number;
  sessionEvents: number;
  tutorMessages: number;
  vocabularyEntries: number;
  vocabularyRevisions: number;
  newestCurrentEventAt: string | null;
  backupNewestEventAt: string | null;
}

export interface RestoreReport {
  dryRun: boolean;
  backup: BackupManifest;
  backupSchemaVersion: number;
  appSchemaVersion: number;
  willMigrateOnStart: boolean;
  rolledBack: RolledBack;
  safetyBackup: BackupManifest | null;
  deltaExport: string | null;
  note: string;
}

const tableExists = (db: Database.Database, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
const ids = (db: Database.Database, table: string): Set<string> => (tableExists(db, table) ? new Set((db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>).map((r) => r.id)) : new Set());
const newest = (db: Database.Database, table: string, col: string): string | null => (tableExists(db, table) ? ((db.prepare(`SELECT MAX(${col}) AS m FROM ${table}`).get() as { m: string | null }).m ?? null) : null);

/** Rows in `current` that the backup does not have, by primary key. Read-only on both files. */
function diffAgainstBackup(currentPath: string, backupPath: string): { summary: RolledBack; rows: { attempts: unknown[]; sessionEvents: unknown[] } } {
  const empty = { summary: { attempts: 0, sessionEvents: 0, tutorMessages: 0, vocabularyEntries: 0, vocabularyRevisions: 0, newestCurrentEventAt: null, backupNewestEventAt: null }, rows: { attempts: [], sessionEvents: [] } };
  const b = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const backupNewest = newest(b, "session_events", "server_at");
    if (!existsSync(currentPath)) return { ...empty, summary: { ...empty.summary, backupNewestEventAt: backupNewest } };
    const c = new Database(currentPath, { readonly: true, fileMustExist: true });
    try {
      const gone = (table: string): string[] => {
        const have = ids(b, table);
        return [...ids(c, table)].filter((id) => !have.has(id));
      };
      const attempts = gone("attempts");
      const events = gone("session_events");
      const pick = (table: string, wanted: string[]): unknown[] => {
        if (wanted.length === 0) return [];
        const stmt = c.prepare(`SELECT * FROM ${table} WHERE id = ?`);
        return wanted.map((id) => stmt.get(id));
      };
      return {
        summary: {
          attempts: attempts.length,
          sessionEvents: events.length,
          tutorMessages: gone("tutor_messages").length,
          vocabularyEntries: gone("vocabulary_entries").length,
          vocabularyRevisions: gone("vocabulary_revisions").length,
          newestCurrentEventAt: newest(c, "session_events", "server_at"),
          backupNewestEventAt: backupNewest,
        },
        rows: { attempts: pick("attempts", attempts), sessionEvents: pick("session_events", events) },
      };
    } finally {
      c.close();
    }
  } finally {
    b.close();
  }
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Restore workflow (spec/11), run with the application STOPPED (maintenance): known backup id -> checksum, integrity and schema checks ->
 * what would be rolled back is computed and exported -> the current database is saved as a verified safety backup -> the validated copy
 * replaces it -> reopen and re-check -> on ANY failure the previous file is put back. It never opens a newer schema, never copies a WAL as a
 * main file, and never runs without the user repeating the backup id.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  if (!BACKUP_ID_RE.test(opts.backupId)) throw new RestoreError("RESTORE_BAD_ID", "A backup id is a server-generated file name such as manual-20261030T010203Z-ab12cd.sqlite");
  const backup = listBackups(opts.backupsDir).find((m) => m.file === opts.backupId);
  if (!backup) throw new RestoreError("RESTORE_UNKNOWN_BACKUP", "No such backup with a manifest in the backups folder");
  const backupFile = path.join(opts.backupsDir, backup.file);

  const check = verifyBackup(opts.backupsDir, backup);
  if (!check.checksumOk || check.integrity !== "ok" || check.foreignKeyViolations !== 0) {
    throw new RestoreError("RESTORE_BACKUP_INVALID", "The backup failed verification and was not used", { checksumOk: check.checksumOk, integrity: check.integrity, foreignKeyViolations: check.foreignKeyViolations });
  }
  const probe = new Database(backupFile, { readonly: true, fileMustExist: true });
  let backupSchema: number;
  try {
    backupSchema = currentSchemaVersion(probe);
  } finally {
    probe.close();
  }
  const appSchema = loadMigrations(opts.migrationsDir).length;
  if (backupSchema > appSchema) {
    throw new RestoreError("RESTORE_SCHEMA_NEWER", `The backup has schema ${backupSchema} but this application only knows ${appSchema}; an older program never opens a newer database`, { backupSchema, appSchema });
  }

  const diff = diffAgainstBackup(opts.dbPath, backupFile);
  const base: RestoreReport = {
    dryRun: Boolean(opts.dryRun),
    backup,
    backupSchemaVersion: backupSchema,
    appSchemaVersion: appSchema,
    willMigrateOnStart: backupSchema < appSchema,
    rolledBack: diff.summary,
    safetyBackup: null,
    deltaExport: null,
    note: "",
  };
  if (opts.dryRun) return { ...base, note: "Dry run: nothing was changed." };
  if (opts.confirmId !== opts.backupId) throw new RestoreError("RESTORE_NOT_CONFIRMED", "Restore replaces the current data. Repeat the backup id to confirm it.", { rolledBack: diff.summary });

  const now = opts.now ?? new Date();
  let safety: BackupManifest | null = null;
  let deltaExport: string | null = null;
  const preRestore = `${opts.dbPath}.pre-restore`;
  const incoming = `${opts.dbPath}.restoring`;
  if (existsSync(opts.dbPath)) {
    const cur = openDatabase(opts.dbPath);
    try {
      safety = await createBackup(cur, { backupsDir: opts.backupsDir, kind: "manual", schemaVersion: currentSchemaVersion(cur), appVersion: opts.appVersion, now });
      cur.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      cur.close();
    }
    const safetyCheck = verifyBackup(opts.backupsDir, safety);
    if (!safetyCheck.checksumOk || safetyCheck.integrity !== "ok") throw new RestoreError("RESTORE_SAFETY_FAILED", "The safety backup of the current data could not be verified; nothing was changed");
    mkdirSync(opts.backupsDir, { recursive: true });
    deltaExport = path.join(opts.backupsDir, `restore-delta-${stamp(now)}.json`);
    writeFileSync(`${deltaExport}.tmp`, JSON.stringify({ schema_version: "restore-delta-v1", exportedAt: now.toISOString(), restoredFrom: backup.file, safetyBackup: safety.file, note: "Rows present before the restore but not in the restored backup. This file is a record, not an executable restore.", counts: diff.summary, attempts: diff.rows.attempts, sessionEvents: diff.rows.sessionEvents }, null, 2));
    renameSync(`${deltaExport}.tmp`, deltaExport);
  }

  try {
    rmSync(incoming, { force: true });
    copyFileSync(backupFile, incoming);
    const copyCheck = checkDatabaseFile(incoming);
    if (copyCheck.integrity !== "ok" || copyCheck.foreignKeyViolations !== 0) throw new RestoreError("RESTORE_COPY_INVALID", "The copied backup failed verification");
    rmSync(preRestore, { force: true });
    if (existsSync(opts.dbPath)) renameSync(opts.dbPath, preRestore);
    rmSync(`${opts.dbPath}-wal`, { force: true });
    rmSync(`${opts.dbPath}-shm`, { force: true });
    renameSync(incoming, opts.dbPath);
    opts.afterReplace?.();
    const db = openDatabase(opts.dbPath);
    try {
      assertDatabaseHealthy(db);
      const fk = db.pragma("foreign_key_check") as unknown[];
      if (fk.length > 0) throw new RestoreError("RESTORE_FK", "The restored database has foreign-key violations");
      const applied = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; checksum: string }>;
      const files = loadMigrations(opts.migrationsDir);
      for (const row of applied) {
        const f = files[row.version - 1];
        if (!f || f.checksum !== row.checksum) throw new RestoreError("RESTORE_CHECKSUM", `Applied migration ${row.version} does not match the files of this program`);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // put the previous database back exactly as it was
    rmSync(incoming, { force: true });
    rmSync(opts.dbPath, { force: true });
    rmSync(`${opts.dbPath}-wal`, { force: true });
    rmSync(`${opts.dbPath}-shm`, { force: true });
    if (existsSync(preRestore)) renameSync(preRestore, opts.dbPath);
    if (err instanceof RestoreError || err instanceof BackupError) throw new RestoreError(err instanceof RestoreError ? err.code : err.code, `${err.message} The previous data was put back.`, { safetyBackup: safety?.file ?? null });
    throw new RestoreError("RESTORE_FAILED", `Restore failed and the previous data was put back: ${(err as Error).message}`, { safetyBackup: safety?.file ?? null });
  }
  rmSync(preRestore, { force: true });
  return {
    ...base,
    safetyBackup: safety,
    deltaExport: deltaExport ? path.basename(deltaExport) : null,
    note: `Restored ${backup.file}. Start the application: queue leases left from before are recovered at startup, and ${base.willMigrateOnStart ? "pending migrations run with a pre-migration backup" : "the schema is current"}.`,
  };
}
