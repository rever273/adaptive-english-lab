import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("upgrades an existing taxonomy with backup, exact manifest, compatible skills and intact historical revisions", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  mkdirSync(dir, { recursive: true });
  const source = path.join(projectRoot, "migrations");
  for (const f of readdirSync(source).filter((f) => /^0(0[1-9]|[12][0-9]|3[0-5])_.*\.sql$/.test(f))) copyFileSync(path.join(source, f), path.join(dir, f));
  const db = openDatabase(path.join(scratch.root, "db", "taxonomy.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const oldRevisions = db.prepare("SELECT * FROM skill_revisions ORDER BY id").all();
    copyFileSync(path.join(source, "036_taxonomy_compatibility.sql"), path.join(dir, "036_taxonomy_compatibility.sql"));
    const backupsDir = path.join(scratch.root, "backups");
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir, kind: "premigration", schemaVersion: 35, appVersion: "test" }) });
    expect(result.applied).toEqual([36]);
    expect(verifyBackup(backupsDir, result.premigrationBackup!)).toMatchObject({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
    expect(db.prepare("SELECT * FROM skill_revisions WHERE taxonomy_id=(SELECT id FROM taxonomy_versions WHERE version='taxonomy-v1') ORDER BY id").all()).toEqual(oldRevisions);
    const manifest = readFileSync(path.join(projectRoot, "content/taxonomy/taxonomy-v2.json"));
    const tax = db.prepare("SELECT id, manifest_hash FROM taxonomy_versions WHERE version='taxonomy-v2'").get() as { id: string; manifest_hash: string };
    expect(tax.manifest_hash).toBe(createHash("sha256").update(manifest).digest("hex"));
    const skills = (JSON.parse(manifest.toString("utf8")) as { skills: Array<{ id: string }> }).skills.map((s) => s.id).sort();
    expect((db.prepare("SELECT skill_id FROM skill_revisions WHERE taxonomy_id=? ORDER BY skill_id").all(tax.id) as Array<{ skill_id: string }>).map((r) => r.skill_id)).toEqual(skills);
    expect((db.prepare("SELECT COUNT(*) AS n FROM taxonomy_skill_compatibility WHERE target_taxonomy_id=?").get(tax.id) as { n: number }).n).toBe(162);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((await runMigrations(db, { migrationsDir: dir, appVersion: "test" })).applied).toEqual([]);
  } finally { db.close(); scratch.cleanup(); }
});
