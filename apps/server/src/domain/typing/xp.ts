import { TYPING_XP_VERSION } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { LEVEL_RULE_VERSION, levelFromTotal } from "../sessions/xp.js";

/** Words: 4/3 XP per destroyed word (40 XP for a 30-word level). Never negative. */
export function typingXpForWords(destroyed: number): number {
  return Math.max(1, Math.round((destroyed * 4) / 3));
}

export interface WordErrorBands {
  clean: number;
  one: number;
  many: number;
}

/** Destroyed words by wrong keys pressed on them: none / exactly one / two or more. */
export function wordErrorBands(errorsPerDestroyedWord: number[]): WordErrorBands {
  const bands = { clean: 0, one: 0, many: 0 };
  for (const e of errorsPerDestroyedWord) {
    if (e === 0) bands.clean++;
    else if (e === 1) bands.one++;
    else bands.many++;
  }
  return bands;
}

/** typing-xp-v2: a clean word is worth 4 thirds of an XP, one wrong key 3, two or more 2 (an all-clean 30-word level still gives 40 XP). */
export function typingXpForWordBands(b: WordErrorBands): number {
  return Math.max(1, Math.round((4 * b.clean + 3 * b.one + 2 * b.many) / 3));
}

/** Books: one XP per 12 required characters (~50 XP for 5 minutes at 25 WPM). Never negative. */
export function typingXpForBooks(requiredChars: number): number {
  return Math.max(1, Math.round(requiredChars / 12));
}

/** Append one XP row. The `typing_xp_guard` trigger rejects anything without a `completed` session, and UNIQUE(session_id) blocks double XP. */
export function awardTypingXp(db: Db, input: { id: string; sessionId: string; amount: number; at: string }): void {
  db.prepare("INSERT INTO typing_xp_events(id, session_id, amount, rule_version, created_at) VALUES (?,?,?,?,?)").run(
    input.id,
    input.sessionId,
    input.amount,
    TYPING_XP_VERSION,
    input.at,
  );
}

export function typingProgress(db: Db): { track: "typing"; total: number; level: number; withinLevel: number; threshold: number; ruleVersion: string; levelRule: string } {
  // Words and Books (one row per session) plus Audio Dictation (one row per sentence, its own table and rule version)
  const total = (db.prepare("SELECT (SELECT COALESCE(SUM(amount), 0) FROM typing_xp_events) + (SELECT COALESCE(SUM(amount), 0) FROM typing_dictation_xp_events) AS total").get() as { total: number }).total;
  return { track: "typing", total, ...levelFromTotal(total), ruleVersion: TYPING_XP_VERSION, levelRule: LEVEL_RULE_VERSION };
}
