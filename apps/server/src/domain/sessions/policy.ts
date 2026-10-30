import { SettingsV1Schema, type SettingsV1 } from "@english-lab/contracts";
import { DEFAULT_QUOTAS, type NonReadingFormat } from "@english-lab/learning";
import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";

export interface SessionDeps {
  now: () => Date;
  newId: () => string;
}

const QuotaSchema = z
  .object({
    choose_form: z.number().int().min(0),
    choose_missing_fragment: z.number().int().min(0),
    detect_error: z.number().int().min(0),
    guided_short_answer: z.number().int().min(0),
    russian_to_english_short: z.number().int().min(0),
  })
  .strict();

/** blueprint_revisions.policy_json for a practice lesson (LESSON_BLUEPRINTS "Общая политика"). */
export const BlueprintPolicySchema = z
  .object({
    schema_version: z.literal("blueprint-policy-v1"),
    title: z.string().min(1).max(120),
    /** relative proportions of the formats; scaled to Settings taskCount */
    quotas: QuotaSchema.default(DEFAULT_QUOTAS),
    /** 1 = one reading passage replaces choose_form/fragment slots (L03/L06/L10) */
    readingBlocks: z.union([z.literal(0), z.literal(1)]).default(0),
    /** target-skill pool of the lesson; empty = every approved exercise of the bank role */
    skillPool: z.array(z.string()).default([]),
  })
  .strict();
export type BlueprintPolicy = z.infer<typeof BlueprintPolicySchema>;

export interface BlueprintRow {
  id: string;
  blueprintId: string;
  key: string;
  status: string;
  policy: BlueprintPolicy;
}

export function loadBlueprint(db: Db, blueprintRevisionId: string): BlueprintRow {
  const r = db
    .prepare("SELECT br.id, br.blueprint_id AS blueprintId, b.stable_key AS key, br.status, br.policy_json AS policy FROM blueprint_revisions br JOIN blueprints b ON b.id = br.blueprint_id WHERE br.id = ?")
    .get(blueprintRevisionId) as { id: string; blueprintId: string; key: string; status: string; policy: string } | undefined;
  if (!r) throw new ApiError(404, "BLUEPRINT_NOT_FOUND", "Unknown blueprint revision");
  const parsed = BlueprintPolicySchema.safeParse(JSON.parse(r.policy));
  if (!parsed.success) throw new ApiError(422, "BLUEPRINT_POLICY_INVALID", "Blueprint policy does not match blueprint-policy-v1", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return { ...r, policy: parsed.data };
}

export const PLAYABLE_BLUEPRINT_STATUSES = new Set(["approved", "published"]);

export function loadSettings(db: Db, settingsRevisionId?: string): { id: string; revision: number; values: SettingsV1 } {
  const row = (settingsRevisionId
    ? db.prepare("SELECT id, revision, values_json AS v FROM settings_revisions WHERE id = ?").get(settingsRevisionId)
    : db.prepare("SELECT id, revision, values_json AS v FROM settings_revisions ORDER BY revision DESC LIMIT 1").get()) as { id: string; revision: number; v: string } | undefined;
  if (!row) throw new ApiError(404, "SETTINGS_NOT_FOUND", "Unknown settings revision");
  const parsed = SettingsV1Schema.safeParse(JSON.parse(row.v));
  if (!parsed.success) throw new ApiError(422, "SETTINGS_INVALID", "Stored settings do not match settings-v1");
  return { id: row.id, revision: row.revision, values: parsed.data };
}

export interface PlanRow {
  id: string;
  revision: number;
  multipliers: Record<string, number>;
}

/** Latest learning plan; the agent plan multiplier map lives in priorities_json.multipliers (plan-v1), values clamped later. */
export function loadPlan(db: Db, deps: SessionDeps): PlanRow {
  let row = db.prepare("SELECT id, revision, priorities_json AS p FROM learning_plans ORDER BY revision DESC LIMIT 1").get() as { id: string; revision: number; p: string } | undefined;
  if (!row) {
    // no agent plan yet: a neutral baseline (all multipliers 1) so every session still pins a plan revision (spec/03)
    const taxonomy = db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string };
    const id = deps.newId();
    db.prepare("INSERT INTO learning_plans(id, revision, priorities_json, rationale, reviewer, created_at, taxonomy_id) VALUES (?,?,?,?,?,?,?)").run(
      id,
      1,
      JSON.stringify({ schema_version: "plan-v1", multipliers: {} }),
      "Neutral baseline: no agent plan has been written yet.",
      "system:baseline",
      deps.now().toISOString(),
      taxonomy.id,
    );
    row = { id, revision: 1, p: JSON.stringify({ schema_version: "plan-v1", multipliers: {} }) };
  }
  const parsed = JSON.parse(row.p) as { multipliers?: Record<string, number> };
  return { id: row.id, revision: row.revision, multipliers: parsed.multipliers ?? {} };
}

export type { NonReadingFormat };
