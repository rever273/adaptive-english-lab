import { difficultyLevels, voiceTaskCount, type ExerciseType } from "@english-lab/contracts";
import { FORMAT_ORDER, hardViolations, scaleQuotas, selectSession, type Candidate, type Format } from "@english-lab/learning";
import type { Db } from "../../../db/open.js";
import { loadBlockedFingerprints, loadCandidates } from "../../sessions/bank.js";
import { courseLessons } from "../../sessions/course.js";
import { loadBlueprint, loadSettings } from "../../sessions/policy.js";
import { withRepeats } from "../../sessions/repeats.js";
import { MAX_LESSON_PLAYS } from "@english-lab/contracts";

export interface CourseMissing { lesson: string; type: ExerciseType; skill: string; noMistake: boolean }
export interface CoursePlan { lessons: number; sessions: number; deficit: number; recommended: number; missing: CourseMissing[]; first: string | null; last: string | null }

/** Simulate remaining sessions in course order on an isolated eligibility snapshot. Future repeats are deliberately not assumed. */
export function calculateCoursePlan(db: Db, now: Date): CoursePlan {
  const settings = loadSettings(db).values;
  const lessons = courseLessons(db).filter(l => l.completed < MAX_LESSON_PLAYS);
  const blocked = loadBlockedFingerprints(db);
  const bank = loadCandidates(db, "practice", [], difficultyLevels(settings));
  const allSkills = [...new Set(loadCandidates(db, "practice").map(c => c.skillId))];
  let available: Candidate[] = withRepeats(db, bank, now, "shortage").candidates;
  const missing: CourseMissing[] = [];
  let sessions = 0;
  for (const lesson of lessons) {
    const policy = loadBlueprint(db, lesson.id).policy;
    const skills = policy.skillPool.length ? policy.skillPool : allSkills;
    if (!skills.length) throw new Error(`No target skills available for ${lesson.key}`);
    for (let play = lesson.completed; play < MAX_LESSON_PLAYS; play++) {
      sessions++;
      const n = settings.taskCount;
      const quotas = scaleQuotas(policy.quotas, n);
      const pool = available.filter(c => (!policy.skillPool.length || policy.skillPool.includes(c.skillId)) && !c.unitFingerprints.some(f => blocked.has(f)));
      const fake = new Map<string, CourseMissing>();
      const extras: Candidate[] = [];
      const types: Format[] = [...FORMAT_ORDER];
      if (policy.readingBlocks && !pool.some(c => c.format === "context_reading")) types.push("context_reading");
      for (const type of types) {
        const compatible = skills.filter(s => type !== "choose_missing_fragment" || /^(prepositions|articles|countability|linking|verb_patterns)\./.test(s));
        for (const skill of compatible) for (let i = 0; i < (type === "context_reading" ? 1 : n); i++) {
          const id = `hypothetical:${sessions}:${type}:${skill}:${i}`;
          fake.set(id, { lesson: lesson.key, type: type as ExerciseType, skill, noMistake: type === "detect_error" && i % 2 === 0 });
          extras.push({ revisionId: id, exerciseId: id, format: type, dimension: type === "detect_error" ? "correction" : type === "guided_short_answer" || type === "russian_to_english_short" ? "production" : "recognition", skillId: skill, family: skill.split(".")[0]!, contextId: id, templateCluster: id, bankRole: "practice", noMistake: type === "detect_error" && i % 2 === 0, childCount: type === "context_reading" ? 3 : 1, unitFingerprints: [id] });
        }
      }
      const all = [...pool, ...extras];
      const result = selectSession({ n, weakRatio: settings.weakRatio, voiceTarget: voiceTaskCount(settings), seed: `course-plan-${sessions}`, quotas, readingBlocks: policy.readingBlocks, candidates: all, blocked, priority: () => 0.5, planMultiplier: () => 1, discovery: { bonusBySkill: {}, limit: 0 }, maxNodes: 100000, candidatePenalty: c => fake.has(c.revisionId) ? 10000 : 0 });
      if (!result.feasible) throw new Error(`Could not calculate ${lesson.key} session ${play + 1}: ${result.deficits.map(d => d.message).join("; ")}`);
      const byId = new Map(all.map(c => [c.revisionId, c]));
      const violations = hardViolations(result.slots, n, byId, blocked, quotas);
      if (violations.length) throw new Error(`Invalid course simulation: ${violations.join("; ")}`);
      const selected = new Set(result.slots.map(s => s.revisionId));
      for (const id of selected) {
        const item = fake.get(id);
        if (item) missing.push(item);
        else for (const fingerprint of byId.get(id)!.unitFingerprints) blocked.add(fingerprint);
      }
      available = available.filter(c => !selected.has(c.revisionId));
    }
  }
  return { lessons: lessons.length, sessions, deficit: missing.length, recommended: Math.ceil(missing.length * 1.2), missing, first: lessons[0]?.key ?? null, last: lessons.at(-1)?.key ?? null };
}
