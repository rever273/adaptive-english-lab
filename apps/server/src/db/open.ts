import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
}

/** Opens SQLite with the safe defaults from spec/03: WAL, FK on, busy_timeout 5000, synchronous FULL. */
export function openDatabase(dbPath: string, opts: OpenOptions = {}): Db {
  if (!opts.readonly) mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  try {
    db.pragma("busy_timeout = 5000");
    if (!opts.readonly) db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = FULL");
  } catch (err) {
    db.close(); // e.g. SQLITE_NOTADB on a corrupt file: release the handle, leave the file untouched
    throw err;
  }
  return db;
}

export class DatabaseUnhealthyError extends Error {
  readonly code = "DB_UNHEALTHY";
}

/** Quick structural check at startup. A corrupt DB must never be silently replaced by an empty one. */
export function assertDatabaseHealthy(db: Db): void {
  const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
  const ok = rows.length === 1 && rows[0]?.quick_check === "ok";
  if (!ok) {
    throw new DatabaseUnhealthyError(`SQLite quick_check failed: ${rows.map((r) => r.quick_check).join("; ")}`);
  }
}
