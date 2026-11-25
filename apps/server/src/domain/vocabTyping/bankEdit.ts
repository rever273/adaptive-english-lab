import type { Db } from "../../db/open.js";

/**
 * Archiving (D184). A word the learner archives with Backspace, or the cleanup excludes, stays in `typing_word_bank` with `archived = 1`: it is not deleted
 * and nothing points at it, but no practice in the project (Vocabulary Typing, Meteor Rain, Finger Drills, Key Builder) reads archived rows. The word panel
 * may still translate it (a reference, not practice). Restoring clears the flag.
 */
export function archiveWord(db: Db, lemma: string, by: "model" | "learner", reason: string, stamp: string): boolean {
  return db.prepare("UPDATE typing_word_bank SET archived = 1, archived_by = ?, archived_at = ?, archive_reason = ? WHERE lemma = ?").run(by, stamp, reason, lemma).changes > 0;
}

export function unarchiveWord(db: Db, lemma: string): boolean {
  return db.prepare("UPDATE typing_word_bank SET archived = 0, archived_by = NULL, archived_at = NULL, archive_reason = NULL WHERE lemma = ?").run(lemma).changes > 0;
}
