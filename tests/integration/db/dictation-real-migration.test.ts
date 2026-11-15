import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => { db?.close(); db = null; scratch?.cleanup(); scratch = null; });

it("preserves previous dictation history and foreign keys through the real-speech migration and backup", async () => {
  scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  mkdirSync(dir, { recursive: true });
  const real = path.join(projectRoot, "migrations");
  for (const file of readdirSync(real).filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("053_"))) copyFileSync(path.join(real, file), path.join(dir, file));
  db = openDatabase(path.join(scratch.root, "test.sqlite"));
  await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
  const t = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO typing_dictation_lessons(id,level_number,status,exercise_count,settings_revision,settings_json,plan_json,created_at) VALUES (?,?,?,?,?,?,?,?)").run("lesson", 1, "ready", 5, 1, "{}", "{}", t);
  db.prepare("INSERT INTO typing_dictation_exercises(id,lesson_id,ordinal,text_en,translation_ru,topic,word_count,fingerprint,source,voice_id,voice_name,length_scale,tts_model_sha256,audio_file,audio_ms,asr_model,asr_text,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("exercise", "lesson", 0, "The old sentence stays exactly the same.", "Перевод", "test", 7, "fingerprint", "tts", 1, "bindi", 1, "hash", "old.wav", 3000, "model", "text", "validated", t);
  db.prepare("INSERT INTO typing_dictation_attempts(id,exercise_id,attempt_no,answer_text,correct,word_errors,hint_level,translation_seen,check_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("attempt", "exercise", 1, "wrong", 0, 1, 0, 0, "v1", t);
  db.prepare("INSERT INTO tts_voice_flags(id,voice_key,purpose,exercise_id,action,created_at) VALUES (?,?,?,?,?,?)").run("flag", "piper:en_AU-librivox-medium:1", "dictation", "exercise", "flag", t);
  const before = db.prepare("SELECT * FROM typing_dictation_exercises").all();
  const attempts = db.prepare("SELECT * FROM typing_dictation_attempts").all();
  copyFileSync(path.join(real, "053_dictation_real_speech.sql"), path.join(dir, "053_dictation_real_speech.sql"));
  const backupDir = path.join(scratch.root, "backups");
  const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db!, { backupsDir: backupDir, kind: "premigration", schemaVersion: 52, appVersion: "test" }) });
  expect(result.toVersion).toBe(53);
  expect(db.prepare("SELECT * FROM typing_dictation_exercises").all()).toEqual(before);
  expect(db.prepare("SELECT * FROM typing_dictation_attempts").all()).toEqual(attempts);
  expect(db.prepare("SELECT exercise_id, action FROM tts_voice_flags WHERE id = 'flag'").get()).toEqual({ exercise_id: "exercise", action: "flag" });
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(() => db!.prepare("DELETE FROM typing_dictation_exercises WHERE id = ?").run("exercise")).toThrow(/immutable/);
  expect(verifyBackup(backupDir, result.premigrationBackup!)).toMatchObject({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
  const restored = openDatabase(path.join(backupDir, result.premigrationBackup!.file));
  try { expect(restored.prepare("SELECT * FROM typing_dictation_exercises").all()).toEqual(before); expect(restored.pragma("foreign_key_check")).toEqual([]); } finally { restored.close(); }
});
