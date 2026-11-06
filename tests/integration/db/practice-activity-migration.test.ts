import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("backs up the prior schema, preserves data and rolls back a failed migration", async () => {
  const scratch = makeScratchRoot(), dir = path.join(scratch.root, "migrations"), source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter(n => /^\d{3}_.*\.sql$/.test(n) && n < "038_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  const backup = () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 37, appVersion: "test" });
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const before = db.prepare("SELECT * FROM settings_revisions").all();
    const sql = readFileSync(path.join(source, "038_practice_activity.sql"), "utf8");
    writeFileSync(path.join(dir, "038_practice_activity.sql"), sql + "\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup })).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(currentSchemaVersion(db)).toBe(37);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='practice_activity_intervals'").get()).toBeUndefined();
    writeFileSync(path.join(dir, "038_practice_activity.sql"), sql);
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup });
    expect(result.applied).toEqual([38]);
    expect(result.premigrationBackup).not.toBeNull();
    expect(db.prepare("SELECT * FROM settings_revisions").all()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    const previous = openDatabase(path.join(scratch.root, "backups", result.premigrationBackup!.file), { readonly: true });
    try { expect(currentSchemaVersion(previous)).toBe(37); expect(previous.prepare("SELECT * FROM settings_revisions").all()).toEqual(before); } finally { previous.close(); }
  } finally { db.close(); scratch.cleanup(); }
});


it("adds typing observations with a verified v38 backup", async () => {
 const scratch=makeScratchRoot(),dir=path.join(scratch.root,"migrations"),source=path.join(projectRoot,"migrations");mkdirSync(dir,{recursive:true});
 for(const n of readdirSync(source).filter(n=>/^\d{3}_.*\.sql$/.test(n)&&n<"039_"))copyFileSync(path.join(source,n),path.join(dir,n));
 const db=openDatabase(path.join(scratch.root,"db","test.sqlite"));
 try { await runMigrations(db,{migrationsDir:dir,appVersion:"test"});const before=db.prepare("SELECT * FROM settings_revisions").all();copyFileSync(path.join(source,"039_journey_typing_activity.sql"),path.join(dir,"039_journey_typing_activity.sql"));
 const r=await runMigrations(db,{migrationsDir:dir,appVersion:"test",backup:()=>createBackup(db,{backupsDir:path.join(scratch.root,"backups"),kind:"premigration",schemaVersion:38,appVersion:"test"})});
 expect(r.applied).toEqual([39]);expect(r.premigrationBackup).not.toBeNull();expect(db.prepare("SELECT * FROM settings_revisions").all()).toEqual(before);expect(db.pragma("foreign_key_check")).toEqual([]);
 const old=openDatabase(path.join(scratch.root,"backups",r.premigrationBackup!.file),{readonly:true});try{expect(currentSchemaVersion(old)).toBe(38);}finally{old.close();}
 }finally{db.close();scratch.cleanup();}
});
