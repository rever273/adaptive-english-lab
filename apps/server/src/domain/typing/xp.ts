import { TYPING_XP_VERSION } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { LEVEL_RULE_VERSION, levelFromTotal } from "../sessions/xp.js";

/** Words: 4/3 XP per destroyed word (40 XP for a 30-word level). Never negative. */
export function typingXpForWords(destroyed: number): number {
  return Math.max(1, Math.round((destroyed * 4) / 3));
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
  const total = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM typing_xp_events").get() as { total: number }).total;
  return { track: "typing", total, ...levelFromTotal(total), ruleVersion: TYPING_XP_VERSION, levelRule: LEVEL_RULE_VERSION };
}
