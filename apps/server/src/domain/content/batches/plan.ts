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
  level?: "A2" | "B1" | "B2" | "C1" | "C2";
  /** D68: stable key of the lesson whose deficit this item serves (grammar batches planned from lesson deficits) */
  lesson?: string;
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
    // one inference unit asks for one format AND one target rule
    if (last && last[0]!.type === p.type && last[0]!.target_skill === p.target_skill && last.length < unitSizeFor(p.type)) last.push(p);
    else units.push([p]);
  }
  return units;
}

// ---------------------------------------------------------------------------------------------------------------- D68: plan from lesson deficits

const FRAGMENT_SKILLS = /^(prepositions|articles|countability|linking|verb_patterns)\./;
const compatibleWith = (type: ExerciseType, skills: readonly string[]): string[] => skills.filter((s) => (type === "choose_missing_fragment" ? FRAGMENT_SKILLS.test(s) : type === "context_reading" ? /^linking\./.test(s) : true));

/** the lesson facts the planner needs (a subset of LessonNeed, so tests can build it without a database) */
export interface LessonDemand {
  key: string;
  /** missing exercises per format */
  formatDeficit: Readonly<Partial<Record<ExerciseType, number>>>;
  /** the lesson's target-skill pool, thinnest first (skills with the biggest deficit, then fewest usable exercises) */
  skills: readonly string[];
  /** recommended size of this lesson's share (deficit + 20%) */
  capacity: number;
}

/** largest-remainder split of `total` by non-negative weights (ties: earlier entry first) */
function splitByWeight<K extends string>(total: number, weights: ReadonlyArray<readonly [K, number]>): Map<K, number> {
  const sum = weights.reduce((a, [, w]) => a + w, 0);
  const out = new Map<K, number>(weights.map(([k]) => [k, 0]));
  if (total <= 0 || sum <= 0) return out;
  const exact = weights.map(([k, w], i) => ({ k, i, e: (total * w) / sum }));
  for (const x of exact) out.set(x.k, Math.floor(x.e));
  let left = total - [...out.values()].reduce((a, v) => a + v, 0);
  for (const x of [...exact].sort((a, b) => b.e - Math.floor(b.e) - (a.e - Math.floor(a.e)) || a.i - b.i)) {
    if (left-- <= 0) break;
    out.set(x.k, out.get(x.k)! + 1);
  }
  return out;
}

/**
 * Deterministic plan of `count` items from lesson deficits. `lessons` are in the order they will be played (the next lesson first):
 * each takes up to its capacity (deficit + 20%), split over its missing formats by deficit weight; the rest goes to the following lessons,
 * and anything beyond all capacities is spread over the thinnest skills of those pools (formats evenly). Every item records its lesson.
 */
export function planFromDeficits(args: { count: number; lessons: readonly LessonDemand[]; types?: readonly ExerciseType[]; tag: string }): ItemPlan[] {
  const allowed = new Set<ExerciseType>(args.types ?? EXERCISE_TYPES);
  const blocks: Array<{ lesson: string; type: ExerciseType; skill: string; size: number }> = [];
  const perLesson = new Map<string, Map<ExerciseType, number>>();
  let remaining = args.count;
  const give = (lesson: LessonDemand, type: ExerciseType, k: number) => {
    const m = perLesson.get(lesson.key) ?? perLesson.set(lesson.key, new Map()).get(lesson.key)!;
    m.set(type, (m.get(type) ?? 0) + k);
  };
  for (const lesson of args.lessons) {
    if (remaining <= 0) break;
    const weights = (Object.entries(lesson.formatDeficit) as Array<[ExerciseType, number]>).filter(([t, d]) => d > 0 && allowed.has(t) && compatibleWith(t, lesson.skills).length > 0);
    const take = Math.min(remaining, lesson.capacity);
    if (take <= 0 || weights.length === 0) continue;
    for (const [t, k] of splitByWeight(take, weights)) if (k > 0) give(lesson, t, k);
    remaining -= take;
  }
  if (remaining > 0) {
    // beyond every deficit: the thinnest skills of the visited pools, formats evenly, lessons in turn
    const types = EXERCISE_TYPES.filter((t) => allowed.has(t));
    const usableTypes = (l: LessonDemand) => types.filter((t) => compatibleWith(t, l.skills).length > 0);
    const visited = args.lessons.filter((l) => perLesson.has(l.key));
    const pools = (visited.length > 0 ? visited : args.lessons.slice(0, 1)).filter((l) => usableTypes(l).length > 0);
    if (pools.length === 0) throw new ApiError(422, "INCOMPATIBLE_SKILLS", "No lesson skills are available for the requested formats");
    for (let i = 0; i < remaining; i++) {
      const lesson = pools[i % pools.length]!;
      const ts = usableTypes(lesson);
      give(lesson, ts[Math.floor(i / pools.length) % ts.length]!, 1);
    }
  }
  // blocks of one inference unit share a skill; skills cycle thinnest first within each (lesson, format)
  for (const lesson of args.lessons) {
    const m = perLesson.get(lesson.key);
    if (!m) continue;
    for (const type of EXERCISE_TYPES) {
      const k = m.get(type) ?? 0;
      const skills = compatibleWith(type, lesson.skills);
      if (k === 0 || skills.length === 0) continue;
      for (let done = 0, b = 0; done < k; b++) {
        const size = Math.min(unitSizeFor(type), k - done);
        blocks.push({ lesson: lesson.key, type, skill: skills[b % skills.length]!, size });
        done += size;
      }
    }
  }
  const out: ItemPlan[] = [];
  const seen = new Map<ExerciseType, number>();
  let ordinal = 0;
  for (const type of EXERCISE_TYPES) {
    for (const b of blocks.filter((x) => x.type === type)) {
      for (let j = 0; j < b.size; j++) {
        const k = seen.get(type) ?? 0;
        seen.set(type, k + 1);
        const topic = TOPICS[ordinal % TOPICS.length]!;
        out.push({ ordinal, type, dimension: DIMENSION_BY_TYPE[type], target_skill: b.skill, topic, context_id: `${topic}-${args.tag}-${ordinal}`, lesson: b.lesson, ...(type === "detect_error" && k % 4 === 3 ? { noMistake: true } : {}) });
        ordinal++;
      }
    }
  }
  return out;
}
