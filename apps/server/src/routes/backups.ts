import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { BackupError, createBackup, listBackups, verifyBackup } from "../db/backup.js";
import { currentSchemaVersion } from "../db/migrate.js";
import { RestoreError, restoreBackup } from "../db/restore.js";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";

const ValidateBody = z.object({ backupId: z.string().min(1).max(100) }).strict();

/**
 * Backups (spec/02, spec/11). Creating and checking a backup is safe while the app runs. The restore itself is a maintenance operation on a STOPPED
 * app (`npm run restore`): here it can only be validated, which shows exactly which newer rows a restore would roll back.
 */
export function registerBackupRoutes(app: FastifyInstance, db: Db, config: Pick<AppConfig, "dbPath" | "backupsDir" | "migrationsDir" | "appVersion">): void {
  app.get("/api/v1/backups", async () => ({
    backups: listBackups(config.backupsDir).map((m) => ({ id: m.file, kind: m.kind, createdAt: m.createdAt, schemaVersion: m.schemaVersion, appVersion: m.appVersion, sha256: m.sha256 })),
  }));

  app.post("/api/v1/backups", async (_req, reply) => {
    try {
      const m = await createBackup(db, { backupsDir: config.backupsDir, kind: "manual", schemaVersion: currentSchemaVersion(db), appVersion: config.appVersion });
      const check = verifyBackup(config.backupsDir, m);
      return reply.code(201).send({ id: m.file, kind: m.kind, createdAt: m.createdAt, schemaVersion: m.schemaVersion, sha256: m.sha256, verified: check.checksumOk && check.integrity === "ok" && check.foreignKeyViolations === 0 });
    } catch (e) {
      if (e instanceof BackupError) throw new ApiError(500, e.code, "The backup could not be verified and was not kept");
      throw e;
    }
  });

  app.post("/api/v1/restore/validate", async (req) => {
    const b = ValidateBody.safeParse(req.body);
    if (!b.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid");
    try {
      const r = await restoreBackup({ dbPath: config.dbPath, backupsDir: config.backupsDir, migrationsDir: config.migrationsDir, appVersion: config.appVersion, backupId: b.data.backupId, dryRun: true });
      return { valid: true, backupId: r.backup.file, backupSchemaVersion: r.backupSchemaVersion, appSchemaVersion: r.appSchemaVersion, willMigrateOnStart: r.willMigrateOnStart, wouldRollBack: r.rolledBack, how: "Stop the app, then run: npm run restore -- --backup <id> --confirm <id>" };
    } catch (e) {
      if (e instanceof RestoreError) {
        if (e.code === "RESTORE_BAD_ID") throw new ApiError(400, e.code, e.message);
        if (e.code === "RESTORE_UNKNOWN_BACKUP") throw new ApiError(404, e.code, e.message);
        return { valid: false, code: e.code, message: e.message, details: e.details };
      }
      throw e;
    }
  });
}
