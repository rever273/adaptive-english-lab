import { difficultyLevels } from "@english-lab/contracts";
import { DEFAULT_QUOTAS, FORMAT_ORDER, GRAMMAR_REPEAT_CONFIG, applyReading, scaleQuotas, type Format } from "@english-lab/learning";
import type { Db } from "../../../db/open.js";
import { loadBlockedFingerprints, loadCandidates } from "../../sessions/bank.js";
import { PLAYABLE_BLUEPRINT_STATUSES, loadBlueprint, loadSettings, type BlueprintPolicy } from "../../sessions/policy.js";
import { withRepeats } from "../../sessions/repeats.js";

/** D68: replenishment looks this many sessions ahead, counting fresh plus reusable exercises, and orders 20% on top of the deficit */
export const PLANNING_SESSIONS = 2;
export const PLANNING_MARGIN = 0.2;
/** every skill of the lesson pool should keep at least this many usable exercises per planned session, so no skill dries up */
export const SKILL_MIN_PER_SESSION = 2;
/** a reading passage carries about this many questions when its slots are taken from the recognition quotas */
const READING_QUESTIONS = 3;

export interface FormatNeed {
  format: Format;
  need: number;
  have: number;
  deficit: number;
}
export interface SkillNeed {
  skill: string;
  have: number;
  target: number;
  deficit: number;
}
export interface LessonNeed {
  blueprintRevisionId: string;
  key: string;
  /** "L01" when the key ends in lNN, otherwise the lesson title */
  label: string;
  title: string;
  /** CEFR labels of the learner's range; null = every level */
  levels: string[] | null;
  range: string;
  sessions: number;
  taskCount: number;
  skillPool: string[];
  policy: BlueprintPolicy;
  formats: FormatNeed[];
  skills: SkillNeed[];
  /** usable exercises of the pool in the range: new sentences plus reusable (shown) ones */
  available: number;
  fresh: number;
  reusable: number;
  /** items still missing: the larger of the per-format and the per-skill deficit (they overlap, so they are not added) */
  deficit: number;
  /** deficit + 20% margin, rounded up (0 when nothing is missing) */
  recommended: number;
}

export const lessonLabel = (key: string, title: string): string => {
  const m = /l(\d+)$/i.exec(key);
  return m ? `L${m[1]!.padStart(2, "0")}` : title;
};
export const rangeLabel = (levels: readonly string[] | null): string => (!levels || levels.length === 0 ? "all levels" : levels.length === 1 ? levels[0]! : `${levels[0]}-${levels[levels.length - 1]}`);
export const withMargin = (deficit: number): number => (deficit <= 0 ? 0 : Math.ceil(deficit * (1 + PLANNING_MARGIN)));

/** Lessons in course order (the dashboard order) that can be played; completed practice sessions are counted per lesson. */
function playableLessons(db: Db): Array<{ id: string; key: string; completed: number }> {
  const rows = db
    .prepare(
      `SELECT br.id AS id, b.stable_key AS key, br.status AS status,
              (SELECT COUNT(*) FROM sessions s JOIN blueprint_revisions x ON x.id = s.blueprint_revision_id
                WHERE x.blueprint_id = br.blueprint_id AND s.purpose = 'practice' AND s.status = 'completed') AS completed
         FROM blueprint_revisions br JOIN blueprints b ON b.id = br.blueprint_id
        WHERE br.revision = (SELECT MAX(x.revision) FROM blueprint_revisions x WHERE x.blueprint_id = br.blueprint_id)
        ORDER BY b.stable_key`,
    )
    .all() as Array<{ id: string; key: string; status: string; completed: number }>;
  return rows.filter((r) => PLAYABLE_BLUEPRINT_STATUSES.has(r.status));
}

function needOf(db: Db, lesson: { id: string; key: string }, now: Date, settingsValues: ReturnType<typeof loadSettings>["values"], blocked: ReadonlySet<string>): LessonNeed {
  const bp = loadBlueprint(db, lesson.id);
  const levels = difficultyLevels(settingsValues);
  const n = settingsValues.taskCount;
  const S = PLANNING_SESSIONS;
  const all = loadCandidates(db, "practice", bp.policy.skillPool, levels);
  const reusableSet = withRepeats(db, all, now).candidates;
  // fresh = no sentence shown or reserved; reusable = shown before (labelled repeat). Overlapping sentences are counted once.
  const claimed = new Set<string>();
  const usable = reusableSet.filter((c) => {
    if (c.unitFingerprints.length === 0 && !c.repeat) return false;
    if (c.unitFingerprints.some((f) => blocked.has(f) || claimed.has(f))) return false;
    c.unitFingerprints.forEach((f) => claimed.add(f));
    return true;
  });
  const base = scaleQuotas(bp.policy.quotas ?? DEFAULT_QUOTAS, n);
  const quotas = bp.policy.readingBlocks === 1 ? applyReading(base, READING_QUESTIONS) : base;
  // Reusable supply obeys the solver's limits: per session at most floor(0.6 n) repeats, of which floor(0.3 n) missed/assisted ones; a
  // correct answer is reusable only once it is due (14 days), which `withRepeats` already applied. Fresh exercises are always preferred.
  let totalBudget = Math.floor(GRAMMAR_REPEAT_CONFIG.totalShare * n) * S;
  let soonBudget = Math.floor(GRAMMAR_REPEAT_CONFIG.soonShare * n) * S;
  const usedRepeats = new Set<string>();
  const formats: FormatNeed[] = [...FORMAT_ORDER, "context_reading" as const]
    .map((format) => {
      const need = format === "context_reading" ? (bp.policy.readingBlocks === 1 ? S : 0) : quotas[format] * S;
      const ofFormat = usable.filter((c) => c.format === format);
      const fresh = new Set(ofFormat.filter((c) => !c.repeat).map((c) => c.exerciseId)).size;
      let short = Math.max(0, need - fresh);
      const unit = format === "context_reading" ? READING_QUESTIONS : 1; // a repeated passage spends all its questions
      const take = (reason: "review" | "soon") => {
        for (const c of ofFormat.filter((x) => x.repeat && (reason === "review" ? x.repeat.reason === "review" : x.repeat.reason !== "review") && !usedRepeats.has(x.exerciseId))) {
          if (short <= 0 || totalBudget < unit || (reason === "soon" && soonBudget < unit)) break;
          usedRepeats.add(c.exerciseId);
          short--;
          totalBudget -= unit;
          if (reason === "soon") soonBudget -= unit;
        }
      };
      take("review");
      take("soon");
      const have = fresh + [...usedRepeats].filter((id) => ofFormat.some((c) => c.exerciseId === id)).length;
      return { format, need, have, deficit: Math.max(0, need - have) };
    })
    .filter((f) => f.need > 0);
  // a lesson without a skill pool (every skill allowed) has no per-skill target: only its formats can be short
  const skills: SkillNeed[] = bp.policy.skillPool.map((skill) => {
    const have = new Set(usable.filter((c) => c.skillId === skill).map((c) => c.exerciseId)).size;
    const target = SKILL_MIN_PER_SESSION * S;
    return { skill, have, target, deficit: Math.max(0, target - have) };
  });
  const formatDeficit = formats.reduce((a, f) => a + f.deficit, 0);
  const skillDeficit = skills.reduce((a, s) => a + s.deficit, 0);
  const deficit = Math.max(formatDeficit, skillDeficit);
  return {
    blueprintRevisionId: lesson.id,
    key: lesson.key,
    label: lessonLabel(lesson.key, bp.policy.title),
    title: bp.policy.title,
    levels,
    range: rangeLabel(levels),
    sessions: S,
    taskCount: n,
    skillPool: bp.policy.skillPool,
    policy: bp.policy,
    formats,
    skills,
    available: new Set(usable.filter((c) => !c.repeat).map((c) => c.exerciseId)).size + usedRepeats.size,
    fresh: new Set(usable.filter((c) => !c.repeat).map((c) => c.exerciseId)).size,
    reusable: usedRepeats.size,
    deficit,
    recommended: withMargin(deficit),
  };
}

export interface LessonPlanView {
  /** every playable lesson in course order with its needs */
  lessons: LessonNeed[];
  /** index of the lesson the app offers next: the first lesson without a completed practice session (all done: the least practised, then course order) */
  nextIndex: number;
}

/** null when the profile has no playable lesson (then callers fall back to the whole bank) */
export function lessonPlanView(db: Db, now: Date = new Date()): LessonPlanView | null {
  const lessons = playableLessons(db);
  if (lessons.length === 0) return null;
  const settings = loadSettings(db).values;
  const blocked = loadBlockedFingerprints(db);
  let nextIndex = lessons.findIndex((l) => l.completed === 0);
  if (nextIndex < 0) nextIndex = lessons.reduce((best, l, i) => (l.completed < lessons[best]!.completed ? i : best), 0);
  return { lessons: lessons.map((l) => needOf(db, l, now, settings, blocked)), nextIndex };
}

/** "Lesson L01 at B1-C1 needs: detect_error 4, guided_short_answer 1 (new or reusable exercises for the next 2 sessions)." */
export function needMessage(n: LessonNeed): string {
  const parts = [...n.formats.filter((f) => f.deficit > 0).map((f) => `${f.format} ${f.deficit}`), ...n.skills.filter((s) => s.deficit > 0 && n.formats.every((f) => f.deficit === 0)).map((s) => `${s.skill} ${s.deficit}`)];
  return `Lesson ${n.label} at ${n.range} needs: ${parts.join(", ")} (new or reusable exercises for the next ${n.sessions} sessions; ${n.available} usable now).`;
}
