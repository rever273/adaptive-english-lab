import { ApiError } from "../../errors.js";
import type { Db } from "../../db/open.js";

export interface SlotContext {
  slotId: string;
  sessionId: string;
  questionId: string | null;
  inputPreference: "text" | "voice";
  sessionStatus: "active" | "suspended" | "completed" | "ended_early";
  purpose: "practice" | "diagnostic" | "heldout";
  timezone: string;
  exerciseRevisionId: string;
  exerciseType: string;
  contentJson: string;
  rubricVersion: string;
  dimension: "recognition" | "correction" | "production";
  taxonomyId: string;
}

export function loadSlotContext(db: Db, slotId: string): SlotContext {
  const r = db
    .prepare(
      `SELECT ss.id AS slotId, ss.session_id AS sessionId, ss.question_id AS questionId, ss.input_preference AS inputPreference,
              s.status AS sessionStatus, s.purpose, s.timezone,
              er.id AS exerciseRevisionId, er.type AS exerciseType, er.content_json AS contentJson,
              er.rubric_version AS rubricVersion, er.dimension, er.taxonomy_id AS taxonomyId
         FROM session_slots ss
         JOIN sessions s ON s.id = ss.session_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE ss.id = ?`,
    )
    .get(slotId) as SlotContext | undefined;
  if (!r) throw new ApiError(404, "SLOT_NOT_FOUND", "Unknown slot");
  return r;
}

/** Target skill key of the slot: reading child questions carry their own target_skill (spec/05 invariant 4). */
export function resolveTargetSkillKey(ctx: Pick<SlotContext, "contentJson" | "questionId">): string {
  const content = JSON.parse(ctx.contentJson) as {
    target_skill?: unknown;
    payload?: { questions?: Array<{ id?: unknown; target_skill?: unknown }> };
  };
  const key =
    ctx.questionId !== null
      ? content.payload?.questions?.find((q) => q.id === ctx.questionId)?.target_skill
      : content.target_skill;
  if (typeof key !== "string" || key.length === 0) {
    throw new ApiError(422, "TARGET_SKILL_UNRESOLVED", "Exercise revision does not name a target skill for this slot");
  }
  return key;
}

export function skillRevisionId(db: Db, skillKey: string, taxonomyId: string): string {
  const row = db.prepare("SELECT id FROM skill_revisions WHERE skill_id = ? AND taxonomy_id = ?").get(skillKey, taxonomyId) as { id: string } | undefined;
  if (!row) throw new ApiError(422, "UNKNOWN_SKILL", `Skill ${skillKey} is not part of the exercise's taxonomy`);
  return row.id;
}
