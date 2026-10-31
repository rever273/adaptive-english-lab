import { DIMENSION_BY_TYPE, EXERCISE_TYPES, TRIAL_PER_TYPE, TRIAL_SIZE, type CreateBatchRequest, type ExerciseType } from "@english-lab/contracts";
import { ApiError } from "../../../errors.js";

/** One requested draft: what the generator is asked for. The server, not the model, decides all of these fields. */
export interface ItemPlan {
  ordinal: number;
  type: ExerciseType;
  dimension: "recognition" | "correction" | "production";
  target_skill: string;
  topic: string;
  context_id: string;
  /** detect_error only: this item must be a fully correct sentence (the "No mistake" quota) */
  noMistake?: boolean;
  /** TASK_021: CEFR level requested from the settings range when the batch was created; absent = the historical B2 */
  level?: "A2" | "B1" | "B2" | "C1";
  vocabulary?: { lemma: string; translationRu: string | null; family: "recognition" | "guided_recall" | "collocation" };
}

export const TOPICS = ["workplace", "travel", "health", "services", "education", "community", "technology", "household"] as const;
/**
 * Inference unit size per format (spec/05 allows 1-4). The real Trial (2026-10-29, evidence/task-010) showed that 4 drafts per call do not
 * fit the 2048-token output cap (every call was cut off mid-JSON): 2 per call, and 1 for the long reading passages (D47).
 */
export const unitSizeFor = (type: ExerciseType): number => (type === "context_reading" ? 1 : 2);

export interface PlanInput {
  request: CreateBatchRequest;
  /** active skill ids of the current taxonomy */
  taxonomySkills: readonly string[];
  /** current count of non-rejected revisions per target skill: adaptive mode fills the thinnest skills first */
  coverage: ReadonlyMap<string, number>;
  /** short unique tag for context ids */
  tag: string;
}

/**
 * Deterministic plan. Ordinals are assigned AFTER grouping by format, so every inference unit (<=4 consecutive ordinals) asks for one
 * format and one JSON-schema variant. Trial: 24 items, exactly 4 per format, spread over the thinnest skills.
 */
export function planBatch(input: PlanInput): ItemPlan[] {
  const { request, taxonomySkills, coverage, tag } = input;
  const known = new Set(taxonomySkills);
  let pool: string[];
  if (request.skills && request.skills.length > 0) {
    const unknown = request.skills.filter((s) => !known.has(s));
    if (unknown.length > 0) throw new ApiError(422, "UNKNOWN_SKILL", "Some requested skills are not in the current taxonomy", { unknown });
    pool = [...new Set(request.skills)];
  } else if (request.mode === "manual") {
    throw new ApiError(422, "SKILLS_REQUIRED", "Manual mode needs an explicit list of skills");
  } else {
    pool = [...taxonomySkills];
  }
  pool.sort();
  if (request.mode === "adaptive") pool.sort((a, b) => (coverage.get(a) ?? 0) - (coverage.get(b) ?? 0) || (a < b ? -1 : 1));

  const types: ExerciseType[] = request.trial ? [...EXERCISE_TYPES] : (request.types ?? [...EXERCISE_TYPES]);
  const count = request.trial ? TRIAL_SIZE : request.count;
  if (request.trial && request.count !== TRIAL_SIZE) throw new ApiError(422, "TRIAL_SIZE", `A trial batch is exactly ${TRIAL_SIZE} drafts (${TRIAL_PER_TYPE} per format)`);

  // formats first (even spread, remainder to the first formats), then skills round-robin within each format
  const perType = new Map<ExerciseType, number>(types.map((t) => [t, Math.floor(count / types.length)]));
  for (let i = 0; i < count % types.length; i++) perType.set(types[i]!, perType.get(types[i]!)! + 1);

  const out: ItemPlan[] = [];
  let skillCursor = 0;
  let ordinal = 0;
  for (const type of types) {
    if (perType.get(type) === 0) continue;
    const compatible = pool.filter((s) => type === "choose_missing_fragment" ? /^(prepositions|articles|countability|linking|verb_patterns)\./.test(s) : type === "context_reading" ? /^linking\./.test(s) : true);
    if (compatible.length === 0) throw new ApiError(422, "INCOMPATIBLE_SKILLS", `No selected skills are compatible with ${type}. Select another format or skill.`);
    for (let k = 0; k < perType.get(type)!; k++) {
      // A model call has one target rule. Reading units contain one item; other units contain at most two.
      const skill = compatible[(skillCursor + Math.floor(k / unitSizeFor(type))) % compatible.length]!;
      const topic = TOPICS[ordinal % TOPICS.length]!;
      out.push({ ordinal, type, dimension: DIMENSION_BY_TYPE[type], target_skill: skill, topic, context_id: `${topic}-${tag}-${ordinal}`, ...(type === "detect_error" && k % 4 === 3 ? { noMistake: true } : {}) });
      ordinal++;
    }
    skillCursor += Math.ceil(perType.get(type)! / unitSizeFor(type));
  }
  return out;
}

/** Consecutive same-format items, at most UNIT_SIZE per inference unit. */
export function groupUnits(plans: readonly ItemPlan[]): ItemPlan[][] {
  const units: ItemPlan[][] = [];
  for (const p of plans) {
    const last = units.at(-1);
    if (last && last[0]!.type === p.type && last.length < unitSizeFor(p.type)) last.push(p);
    else units.push([p]);
  }
  return units;
}
