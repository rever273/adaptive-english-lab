import type { Db } from "../../db/open.js";

export const XP_RULE_VERSION = "activity-xp-v1";
export const XP_PER_COMPLETION = 10;
/** soft-linear-v1: level 1 costs 100 XP and every next level 25 XP more (Lv 2 = 125 … Lv 10 = 325); the level is derived from the ledger total, nothing is stored */
export const LEVEL_RULE_VERSION = "soft-linear-v1";
export const XP_FIRST_LEVEL = 100;
export const XP_LEVEL_STEP = 25;
export const xpForLevel = (level: number): number => XP_FIRST_LEVEL + XP_LEVEL_STEP * (level - 1);

export function levelFromTotal(total: number): { level: number; withinLevel: number; threshold: number } {
  let level = 1, rest = total;
  while (rest >= xpForLevel(level)) rest -= xpForLevel(level++);
  return { level, withinLevel: rest, threshold: xpForLevel(level) };
}
export type ActivityTrack = "grammar" | "vocabulary";

/** Called in the same transaction as the continue event. */
export function awardCompletionXp(db: Db, input: { id: string; slotId: string; eventId: string; track: ActivityTrack; at: string }): void {
  db.prepare("INSERT INTO activity_xp_events(id, slot_id, event_id, track, amount, rule_version, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(input.id, input.slotId, input.eventId, input.track, XP_PER_COMPLETION, XP_RULE_VERSION, input.at);
}

export function activityProgress(db: Db, track: ActivityTrack) {
  const total = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM activity_xp_events WHERE track = ?").get(track) as { total: number }).total;
  return { track, total, ...levelFromTotal(total), ruleVersion: XP_RULE_VERSION, levelRule: LEVEL_RULE_VERSION };
}
