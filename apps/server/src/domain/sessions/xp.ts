import type { Db } from "../../db/open.js";

export const XP_RULE_VERSION = "activity-xp-v1";
export const XP_PER_COMPLETION = 10;
export const XP_PER_LEVEL = 100;
export type ActivityTrack = "grammar" | "vocabulary";

/** Called in the same transaction as the continue event. */
export function awardCompletionXp(db: Db, input: { id: string; slotId: string; eventId: string; track: ActivityTrack; at: string }): void {
  db.prepare("INSERT INTO activity_xp_events(id, slot_id, event_id, track, amount, rule_version, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(input.id, input.slotId, input.eventId, input.track, XP_PER_COMPLETION, XP_RULE_VERSION, input.at);
}

export function activityProgress(db: Db, track: ActivityTrack) {
  const total = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM activity_xp_events WHERE track = ?").get(track) as { total: number }).total;
  return { track, total, level: Math.floor(total / XP_PER_LEVEL) + 1, withinLevel: total % XP_PER_LEVEL, threshold: XP_PER_LEVEL, ruleVersion: XP_RULE_VERSION };
}
