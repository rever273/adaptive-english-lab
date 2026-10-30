import { existsSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { createBackup, hasRecentDailyBackup, pruneBackups, type BackupManifest } from "./backup.js";
import { currentSchemaVersion, runMigrations, type MigrateResult } from "./migrate.js";
import { assertDatabaseHealthy, openDatabase, type Db } from "./open.js";

export interface PrepareResult {
  db: Db;
  migration: MigrateResult;
  dailyBackup: BackupManifest | null;
  createdNewDatabase: boolean;
}

/**
 * Startup sequence for the database: open -> health check -> migrate (pre-migration backup) -> daily backup.
 * Throws on a corrupt or newer-than-app database; never replaces an existing file with an empty one.
 */
export async function prepareDatabase(config: AppConfig): Promise<PrepareResult> {
  const createdNewDatabase = !existsSync(config.dbPath);
  const db = openDatabase(config.dbPath);
  try {
    assertDatabaseHealthy(db);
    const migration = await runMigrations(db, {
      migrationsDir: config.migrationsDir,
      appVersion: config.appVersion,
      backup: () =>
        createBackup(db, {
          backupsDir: config.backupsDir,
          kind: "premigration",
          schemaVersion: currentSchemaVersion(db),
          appVersion: config.appVersion,
        }),
    });
    let dailyBackup: BackupManifest | null = null;
    if (!hasRecentDailyBackup(config.backupsDir) && !createdNewDatabase) {
      dailyBackup = await createBackup(db, {
        backupsDir: config.backupsDir,
        kind: "daily",
        schemaVersion: currentSchemaVersion(db),
        appVersion: config.appVersion,
      });
    }
    pruneBackups(config.backupsDir);
    return { db, migration, dailyBackup, createdNewDatabase };
  } catch (err) {
    db.close();
    throw err;
  }
}
