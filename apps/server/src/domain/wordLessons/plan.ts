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
  version: "word-lesson-plan-v1" | "word-lesson-plan-v2";
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
const REWRITES = /^(passive\.|reported_speech\.|questions\.embedded_|tenses\.perfect_vs_past$|relatives\.defining$|linking\.(contrast|concession|cause)$|comparisons\.|possessives\.possessive_s$)/;
const transformable = (s: PlanSkill): boolean => s.id === null ? SAFE_STAGE3.includes(s.label) : !NOT_A_TRANSFORMATION.has(s.id.split(".")[0]!) && REWRITES.test(s.id);
/**
 * Rewrites that keep the meaning and change at least two words. Stage 3 draws its tasks from these (and from the learner's own weak skills that
 * fit a rewrite), so a lesson gets three different kinds of task instead of the same few every time. `rule` and `good` go to the model as the brief.
 */
export const REWRITE_KINDS: ReadonlyArray<{ label: string; rule: string; good: string[] }> = [
  { label: "Passive voice", rule: "Turn an active sentence into the passive: the object becomes the subject, the verb becomes be + past participle, the doer may follow by.", good: ["The council approved the plan. => The plan was approved by the council."] },
  { label: "Present perfect vs past simple", rule: "Change between the tenses by changing the time frame: present perfect for an unfinished period or a result now, past simple with a finished time.", good: ["She has lived here since 2015. => She started living here in 2015."] },
  { label: "Reported speech", rule: "Turn direct speech into reported speech: shift the tense back and change pronouns and time words.", good: ["\"I am tired,\" he said. => He said that he was tired."] },
  { label: "Question word + statement order (indirect question)", rule: "Turn a direct question into an indirect one: statement word order, no do/does/did, no question mark after a polite opening.", good: ["Where is the station? => Could you tell me where the station is?"] },
  { label: "Contrast: but => although", rule: "Express the same contrast with although/even though + clause (or despite + noun/-ing) instead of but.", good: ["The route was long, but we arrived early. => Although the route was long, we arrived early."] },
  { label: "Cause: because => so", rule: "Swap the order of cause and result: because + cause becomes cause, so + result.", good: ["We left early because the road was closed. => The road was closed, so we left early."] },
  { label: "Purpose: to => so that", rule: "Say the purpose with so that + clause (with can/could/would) instead of to + verb.", good: ["She took notes to remember the details. => She took notes so that she could remember the details."] },
  { label: "Condition: if ... not => unless", rule: "Replace if ... not with unless + positive verb; the meaning stays the same.", good: ["If you don't book early, you will miss out. => Unless you book early, you will miss out."] },
  { label: "Comparison: comparative => not as ... as", rule: "Say the same comparison from the other side: A is bigger than B => B is not as big as A.", good: ["The new office is bigger than the old one. => The old office is not as big as the new one."] },
  { label: "Time clause: after + clause => after + -ing", rule: "Shorten a time clause with after/before + -ing when both parts have the same subject.", good: ["After she finished the report, she went home. => After finishing the report, she went home."] },
  { label: "Possessive: of => 's", rule: "Replace the 'of' phrase for a person or group with a possessive 's.", good: ["The report of the manager was late. => The manager's report was late."] },
  { label: "Negative: not any => no", rule: "Replace not ... any with no (or none) after a positive verb; keep the same meaning.", good: ["We didn't have any time. => We had no time."] },
];
export const SAFE_STAGE3: string[] = REWRITE_KINDS.map((k) => k.label);

export interface SkillPool {
  weak: PlanSkill[];
  familiar: PlanSkill[];
  recentLabels?: ReadonlySet<string>;
}

/** Confirmed grammar evidence only (the lesson-priorities export). Called once for a whole request, never inside a write transaction. */
export function loadSkillPool(db: Db, asOf: string): SkillPool {
  const rows = (exportLessonPriorities(db, asOf, 5).json as { skills: Array<{ id: string; label: string; confirmedAttempts: number; priority: number | null; series: Array<{ dimension: string; priority: number }> }> }).skills;
  const started = rows.filter((r) => r.confirmedAttempts >= 1);
  const priority = (r: typeof started[number]) => r.series.find(s => s.dimension === "production")?.priority ?? r.priority ?? 0;
  const weak = started.filter((r) => r.priority !== null).sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id));
  const recent = db.prepare(`SELECT l.content_json AS content FROM word_lesson_runs r
    JOIN word_lessons l ON l.id = r.lesson_id WHERE r.status = 'completed'
    ORDER BY r.completed_at DESC, r.rowid DESC LIMIT 5`).all() as Array<{ content: string }>;
  const recentLabels = new Set(recent.flatMap(({ content }) => {
    const c = JSON.parse(content) as { stage3: { items: Array<{ construction_en: string }> }; stage4: { construction_en: string } };
    return [...c.stage3.items.map(i => i.construction_en.toLowerCase()), c.stage4.construction_en.toLowerCase()];
  }));
  const weakIds = new Set(weak.slice(0, 12).map((r) => r.id));
  return {
    recentLabels,
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
  const transformations = 2;
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
      const start = Math.floor(rand() * SAFE_STAGE3.length);
      const safe = SAFE_STAGE3.map((_, i) => SAFE_STAGE3[(start + i) % SAFE_STAGE3.length]!).find((g) => !used.has(g) && !labels.has(g));
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
  const unseen = (s: PlanSkill) => !pool.recentLabels?.has(s.label.toLowerCase());
  const fourth = (weakLeft > 0 ? take(pool.weak, index * 2, unseen) ?? take(pool.weak, index * 2, any) : null) ?? take(pool.familiar, index * 3, any) ?? take(pool.weak, index, any);
  if (fourth && pool.weak.some((w) => keyOf(w) === keyOf(fourth))) weakLeft--;
  for (let k = 0; k < transformations; k++) {
    // after the weak skills, half of the tasks come from the wider list of rewrites (see REWRITE_KINDS) so the three tasks differ from lesson to lesson
    const own = rand() < 0.5;
    const pick = (weakLeft > 0 ? take(pool.weak, index * 2 + k, s => unseen(s) && transformable(s)) ?? take(pool.weak, index * 2 + k, transformable) : null) ?? (own ? take(pool.familiar, index * 3 + k, transformable) : null);
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
    version: "word-lesson-plan-v2",
    seed,
    topics: [pickVocabularyTopic(index, seed % 7), pickVocabularyTopic(index + 1, (seed >> 3) % 7 + 3), pickVocabularyTopic(index + 2, (seed >> 6) % 7 + 6), pickVocabularyTopic(index + 3, (seed >> 9) % 7 + 9), pickVocabularyTopic(index + 4, (seed >> 12) % 7 + 12)],
    difficulty: { min: range[0]!, max: range[range.length - 1]! },
    transformations,
    skills: shuffled,
    weakCount,
  };
}
