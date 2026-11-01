import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { BackupManifest } from "./backup.js";
import type { Db } from "./open.js";

export class MigrationError extends Error {
  constructor(
    readonly code: "CHECKSUM_MISMATCH" | "SCHEMA_NEWER_THAN_APP" | "MIGRATION_FAILED" | "MIGRATION_LAYOUT" | "APPLIED_MIGRATION_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

/** SHA-256 over LF-normalised text so Windows line-ending conversion never changes a checksum. */
export function checksumSql(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(f);
    if (!m) throw new MigrationError("MIGRATION_LAYOUT", `bad migration file name: ${f}`);
    const sql = readFileSync(path.join(dir, f), "utf8");
    out.push({ version: Number(m[1]), name: m[2]!, sql, checksum: checksumSql(sql) });
  }
  out.forEach((mig, i) => {
    if (mig.version !== i + 1) {
      throw new MigrationError("MIGRATION_LAYOUT", `migration versions must be contiguous from 001; found ${mig.version} at position ${i + 1}`);
    }
  });
  return out;
}

export function currentSchemaVersion(db: Db): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!exists) return 0;
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  return row.v;
}

export interface MigrateOptions {
  migrationsDir: string;
  appVersion: string;
  /** Called with the DB at its pre-migration state; only when applied migrations exist and others are pending. */
  backup?: () => Promise<BackupManifest>;
}

export interface MigrateResult {
  applied: number[];
  fromVersion: number;
  toVersion: number;
  premigrationBackup: BackupManifest | null;
  backupSkippedReason: "fresh_database" | "nothing_pending" | null;
}

export async function runMigrations(db: Db, opts: MigrateOptions): Promise<MigrateResult> {
  const files = loadMigrations(opts.migrationsDir);
  const fromVersion = currentSchemaVersion(db);

  if (fromVersion > files.length) {
    throw new MigrationError(
      "SCHEMA_NEWER_THAN_APP",
      `database schema version ${fromVersion} is newer than this application (${files.length}); refusing to open it writable`,
    );
  }
  if (fromVersion > 0) {
    const rows = db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; checksum: string }>;
    for (const r of rows) {
      const f = files.find((x) => x.version === r.version);
      if (!f) throw new MigrationError("APPLIED_MIGRATION_MISSING", `applied migration ${r.version} has no file`);
      if (f.checksum !== r.checksum) {
        throw new MigrationError("CHECKSUM_MISMATCH", `migration ${r.version} (${f.name}) changed after it was applied`);
      }
    }
  }

  const pending = files.filter((f) => f.version > fromVersion);
  if (pending.length === 0) {
    return { applied: [], fromVersion, toVersion: fromVersion, premigrationBackup: null, backupSkippedReason: "nothing_pending" };
  }

  let premigrationBackup: BackupManifest | null = null;
  let backupSkippedReason: MigrateResult["backupSkippedReason"] = null;
  if (fromVersion === 0) {
    backupSkippedReason = "fresh_database";
  } else if (opts.backup) {
    premigrationBackup = await opts.backup();
  } else {
    throw new MigrationError("MIGRATION_FAILED", "pending migrations on an existing database require a pre-migration backup callback");
  }

  const applied: number[] = [];
  for (const mig of pending) {
    // SQLite requires foreign_keys to be disabled outside the transaction when rebuilding a referenced parent.
    // The entire copy and FK verification remain atomic, and the setting is restored on every exit path.
    const rebuildReferencedTable = mig.version === 20 && mig.name === "exercise_c2";
    try {
      if (rebuildReferencedTable) {
        db.pragma("foreign_keys = OFF");
        if (db.pragma("foreign_keys", { simple: true }) !== 0) throw new Error("could not disable foreign keys for table rebuild");
        db.pragma("legacy_alter_table = ON");
      }
      db.exec("BEGIN IMMEDIATE");
      db.exec(mig.sql);
      db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at, app_version) VALUES (?, ?, ?, ?)").run(
        mig.version,
        mig.checksum,
        new Date().toISOString(),
        opts.appVersion,
      );
      const fk = db.pragma("foreign_key_check") as unknown[];
      if (fk.length > 0) throw new Error(`foreign_key_check reported ${fk.length} violation(s)`);
      db.exec("COMMIT");
    } catch (err) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw new MigrationError("MIGRATION_FAILED", `migration ${mig.version} (${mig.name}) failed and was rolled back: ${(err as Error).message}`);
    } finally {
      if (rebuildReferencedTable) {
        db.pragma("legacy_alter_table = OFF");
        db.pragma("foreign_keys = ON");
      }
    }
    applied.push(mig.version);
  }
  return { applied, fromVersion, toVersion: currentSchemaVersion(db), premigrationBackup, backupSkippedReason };
}
