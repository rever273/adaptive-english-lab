import type { Db } from "../../db/open.js";

export const MODE_XP_RULE_VERSION = "mode-xp-v1";
/** 10 XP for every Grammar Cloze sentence answered RIGHT (a mistake or an exclusion earns nothing) */
export const XP_CLOZE_ANSWER = 10;
/** up to 50 XP for a finished One Word lesson, in proportion to its score (a lesson of mistakes earns nothing) */
export const XP_WORD_LESSON = 50;
/** 10 XP for every answer written in a Conversation */
export const XP_CONVERSATION_ANSWER = 10;

export type ModeXpSource = "grammarCloze" | "wordLesson" | "conversation";
const TRACK: Record<ModeXpSource, "grammar" | "vocabulary" | "conversation"> = { grammarCloze: "grammar", wordLesson: "vocabulary", conversation: "conversation" };

/** Appends one XP row in the caller's transaction. A second call for the same source is ignored, so a retry never pays twice. */
export function awardModeXp(db: Db, input: { id: string; source: ModeXpSource; sourceId: string; amount: number; at: string }): void {
  db.prepare("INSERT INTO mode_xp_events(id, track, source, source_id, amount, rule_version, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source, source_id) DO NOTHING")
    .run(input.id, TRACK[input.source], input.source, input.sourceId, input.amount, MODE_XP_RULE_VERSION, input.at);
}

export function modeXpTotal(db: Db, track: "grammar" | "vocabulary" | "conversation"): number {
  return (db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM mode_xp_events WHERE track = ?").get(track) as { total: number }).total;
}
