import { difficultyLevels, CEFR_RANGE, type SettingsV1 } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { pickVocabularyTopic } from "../content/batches/vocabularyTopics.js";
import { exportLessonPriorities } from "../reports/lessonPriorities.js";
import { GRAMMAR } from "../typing/dictation/planning.js";

export interface PlanSkill {
  id: string | null;
  label: string;
}
/** what the model is asked to build one lesson from; stored with the lesson (plan_json) so the lesson can be explained later */
export interface LessonPlan {
  version: "word-lesson-plan-v1";
  seed: number;
  topics: string[];
  difficulty: { min: string; max: string };
  /** how many transformations stage 3 has (2 or 3) */
  transformations: 2 | 3;
  /** one skill per task: stage 3 tasks in order, then stage 4 */
  skills: PlanSkill[];
  weakCount: number;
}

/** families whose rule cannot be shown by rewriting one sentence (an article, an agreement, a preposition, a verb pattern, a modal or a conditional changes the meaning when a sentence is rewritten to show it, so those are practised when the learner builds a sentence (stage 4)) */
const NOT_A_TRANSFORMATION = new Set(["articles", "countability", "prepositions", "agreement", "pronouns", "collocations", "register", "subjunctive", "verb_forms", "verb_patterns", "modals", "conditionals"]);
/** Stage 3 rewrites one sentence into another with the SAME meaning: only these constructions do that reliably (the others are practised in stage 4, where the learner builds a sentence) */
const REWRITES = /^(passive\.|reported_speech\.|questions\.embedded_|tenses\.perfect_vs_past$)/;
const transformable = (s: PlanSkill): boolean => s.id === null ? SAFE_STAGE3.includes(s.label) : !NOT_A_TRANSFORMATION.has(s.id.split(".")[0]!) && REWRITES.test(s.id);
export const SAFE_STAGE3 = ["Passive voice", "Present perfect vs past simple", "Reported speech", "Question word + statement order (indirect question)"];

export interface SkillPool {
  weak: PlanSkill[];
  familiar: PlanSkill[];
}

/** Confirmed grammar evidence only (the lesson-priorities export). Called once for a whole request, never inside a write transaction. */
export function loadSkillPool(db: Db, asOf: string): SkillPool {
  const rows = (exportLessonPriorities(db, asOf, 5).json as { skills: Array<{ id: string; label: string; confirmedAttempts: number; priority: number | null }> }).skills;
  const started = rows.filter((r) => r.confirmedAttempts >= 1);
  const weak = started.filter((r) => r.priority !== null).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  const weakIds = new Set(weak.slice(0, 12).map((r) => r.id));
  return {
    weak: weak.slice(0, 12).map((r) => ({ id: r.id, label: r.label })),
    familiar: started.filter((r) => !weakIds.has(r.id)).sort((a, b) => b.confirmedAttempts - a.confirmedAttempts || a.id.localeCompare(b.id)).map((r) => ({ id: r.id, label: r.label })),
  };
}

/** a small deterministic generator, so a plan is reproducible from its seed */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Skills for the lesson's constructions: about 60% from the started but weak ones, the rest from other familiar skills; a weak skill is not
 * forced into every sentence, and a learner with no history gets plain, common constructions (no skill id). `index` shifts the choice so the
 * lessons of one batch do not all start with the same weak skill.
 */
export function buildPlan(settings: Pick<SettingsV1, "difficultyMin" | "difficultyMax">, pool: SkillPool, index: number, seed: number): LessonPlan {
  const rand = rng(seed);
  const transformations: 2 | 3 = rand() < 0.5 ? 2 : 3;
  const slots = transformations + 1;
  const weakCount = pool.weak.length === 0 ? 0 : Math.min(pool.weak.length, Math.round(slots * 0.6));
  const used = new Set<string>();
  const labels = new Set<string>(); // the same name never appears twice, whatever its id
  const keyOf = (s: PlanSkill) => s.id ?? s.label;
  /** the next unused skill of a list (from a start position) that passes the test, or null */
  const take = (list: readonly PlanSkill[], from: number, ok: (s: PlanSkill) => boolean): PlanSkill | null => {
    for (let k = 0; k < list.length; k++) {
      const s = list[(from + k) % list.length]!;
      if (!used.has(keyOf(s)) && !labels.has(s.label) && ok(s)) {
        used.add(keyOf(s));
        labels.add(s.label);
        return s;
      }
    }
    return null;
  };
  const any = () => true;
  const fallback = (stage3 = false): PlanSkill => {
    if (stage3) {
      const safe = SAFE_STAGE3.find((g) => !used.has(g) && !labels.has(g));
      if (safe) {
        used.add(safe);
        labels.add(safe);
        return { id: null, label: safe };
      }
    }
    const label = GRAMMAR.find((g, i) => i >= (index * 5 + Math.floor(rand() * GRAMMAR.length)) % GRAMMAR.length && !used.has(g)) ?? GRAMMAR.find((g) => !used.has(g)) ?? GRAMMAR[0];
    used.add(label);
    return { id: null, label };
  };
  // Stage 4 (build a sentence from an idea) takes a weak skill of any kind; the transformations of stage 3 take skills that can really be applied to a given sentence.
  const skills: PlanSkill[] = [];
  let weakLeft = weakCount;
  const fourth = (weakLeft > 0 ? take(pool.weak, index * 2, any) : null) ?? take(pool.familiar, index * 3, any) ?? take(pool.weak, index, any);
  if (fourth && pool.weak.some((w) => keyOf(w) === keyOf(fourth))) weakLeft--;
  for (let k = 0; k < transformations; k++) {
    const pick = (weakLeft > 0 ? take(pool.weak, index * 2 + k, transformable) : null) ?? take(pool.familiar, index * 3 + k, transformable) ?? take(pool.weak, index + k, transformable);
    if (pick && pool.weak.some((w) => keyOf(w) === keyOf(pick))) weakLeft--;
    skills.push(pick ?? fallback(true));
  }
  skills.push(fourth ?? fallback());
  // the weak skills should not always be the first ones: rotate stage 3 by the seed (stage 4 stays last)
  const shift = Math.floor(rand() * transformations);
  const shuffled = [...skills.slice(0, transformations).map((_, i) => skills[(i + shift) % transformations]!), skills[transformations]!];
  const levels = difficultyLevels(settings);
  const range = levels ?? [...CEFR_RANGE];
  return {
    version: "word-lesson-plan-v1",
    seed,
    topics: [pickVocabularyTopic(index, seed % 7), pickVocabularyTopic(index + 1, (seed >> 3) % 7 + 3), pickVocabularyTopic(index + 2, (seed >> 6) % 7 + 6), pickVocabularyTopic(index + 3, (seed >> 9) % 7 + 9), pickVocabularyTopic(index + 4, (seed >> 12) % 7 + 12)],
    difficulty: { min: range[0]!, max: range[range.length - 1]! },
    transformations,
    skills: shuffled,
    weakCount,
  };
}
