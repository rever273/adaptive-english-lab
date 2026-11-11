import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("backs up old sessions and rolls back a failed Books word migration", async () => {
  const scratch=makeScratchRoot(), dir=path.join(scratch.root,"migrations"), source=path.join(projectRoot,"migrations"), backupsDir=path.join(scratch.root,"backups");
  mkdirSync(dir,{recursive:true});
  for (const n of readdirSync(source).filter(n=>/^\d{3}_.*\.sql$/.test(n) && n<"047_")) copyFileSync(path.join(source,n),path.join(dir,n));
  const db=openDatabase(path.join(scratch.root,"db","test.sqlite"));
  try {
    await runMigrations(db,{migrationsDir:dir,appVersion:"test"});
    db.prepare("INSERT INTO typing_sessions(id,mode,status,level_number,settings_revision,settings_json,plan_json,started_at,ended_at) VALUES ('old','words','completed',1,1,'{}','{}','before','after')").run();
    const before=db.prepare("SELECT * FROM typing_sessions WHERE id='old'").get();
    const sql=readFileSync(path.join(source,"047_books_word_tracking.sql"),"utf8"), dest=path.join(dir,"047_books_word_tracking.sql");
    const backup=()=>createBackup(db,{backupsDir,kind:"premigration",schemaVersion:currentSchemaVersion(db),appVersion:"test"});
    writeFileSync(dest,sql+"\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db,{migrationsDir:dir,appVersion:"test",backup})).rejects.toMatchObject({code:"MIGRATION_FAILED"});
    expect(currentSchemaVersion(db)).toBe(46); expect(db.prepare("SELECT name FROM sqlite_master WHERE name='typing_book_word_tracking'").get()).toBeUndefined();
    writeFileSync(dest,sql);
    const result=await runMigrations(db,{migrationsDir:dir,appVersion:"test",backup});
    expect(result.applied).toEqual([47]);expect(verifyBackup(backupsDir,result.premigrationBackup!)).toMatchObject({checksumOk:true,integrity:"ok",foreignKeyViolations:0});
    expect(db.prepare("SELECT * FROM typing_sessions WHERE id='old'").get()).toEqual(before);expect(db.pragma("foreign_key_check")).toEqual([]);
    const old=openDatabase(path.join(backupsDir,result.premigrationBackup!.file),{readonly:true});
    try {expect(currentSchemaVersion(old)).toBe(46);expect(old.prepare("SELECT * FROM typing_sessions WHERE id='old'").get()).toEqual(before);} finally {old.close();}
  } finally {db.close();scratch.cleanup();}
});
