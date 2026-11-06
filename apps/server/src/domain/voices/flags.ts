import type { Db } from "../../db/open.js";

/** "Sounds bad" (D128): true when the latest mark on the exercise is a flag. The marks are append-only events; unflagging is a newer event. */
export function isSoundFlagged(db: Db, exerciseId: string): boolean {
  const r = db.prepare("SELECT action FROM tts_voice_flags WHERE exercise_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(exerciseId) as { action: string } | undefined;
  return r?.action === "flag";
}
