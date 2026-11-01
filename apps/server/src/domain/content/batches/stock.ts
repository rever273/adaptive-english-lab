import type { Db } from "../../../db/open.js";
import { loadBlockedFingerprints, loadCandidates } from "../../sessions/bank.js";
import { loadBlueprint, loadSettings } from "../../sessions/policy.js";
import { vocabularyReplenishment } from "./vocabularyPlan.js";
import { vocabularyPracticeStatus } from "../../vocabulary/practice.js";
import { difficultyLevels } from "@english-lab/contracts";
import { scaleQuotas, DEFAULT_QUOTAS } from "@english-lab/learning";
import { lessonPlanView } from "./lessonNeeds.js";
import { calculateCoursePlan } from "./coursePlanning.js";

/**
 * Read-only stock warning before exhaustion. Availability never counts drafts, used sentences or reservations.
 * D68: grammar is judged by the DEFICITS of the lesson the app offers next (per format and skill, under the learner's level range, fresh
 * plus reusable exercises, for the next 2 sessions); `recommended` is the batch size the Content Studio pre-fills.
 */
export function replenishmentStock(db: Db, now: Date = new Date()) {
  const plan = lessonPlanView(db, now);
  const vocabularyDemand = vocabularyReplenishment(db);
  const vocabPlan = { words: vocabularyDemand.words.length, deficit: vocabularyDemand.deficit, recommended: vocabularyDemand.recommended, targetPerWord: vocabularyDemand.targetPerWord };
  if (plan) {
    const next = plan.lessons[plan.nextIndex]!;
    const course = calculateCoursePlan(db, now);
    const vocab = vocabularyPracticeStatus(db);
    const nextMissing = course.missing.filter(item => item.lesson === next.key);
    const low = nextMissing.length > 0;
    const formatDeficits = [...new Set(nextMissing.map(item => item.type))].map(type => ({ kind: "format" as const, name: type, need: nextMissing.filter(item => item.type === type).length, have: 0, deficit: nextMissing.filter(item => item.type === type).length }));
    const grammar = {
      available: next.available,
      threshold: next.taskCount * next.sessions,
      low,
      scope: "next lesson",
      lesson: { key: next.key, label: next.label, title: next.title, range: next.range, sessions: next.sessions, fresh: next.fresh, reusable: next.reusable },
      deficits: formatDeficits,
      recommended: Math.ceil(nextMissing.length * 1.2),
      course: { lessons: course.lessons, sessions: course.sessions, first: course.first, last: course.last, deficit: course.deficit, recommended: course.recommended, sessionsPerLesson: 2 },
      message: low ? `Lesson ${next.label} at ${next.range} needs an estimated ${nextMissing.length} approved exercises for its remaining ${next.sessions} session${next.sessions === 1 ? "" : "s"}.` : `Lesson ${next.label} at ${next.range} has enough exercises for the next ${next.sessions} session${next.sessions === 1 ? "" : "s"} (${next.available} usable).`,
      bySkill: next.skills.map((k) => ({ skill: k.skill, available: k.have })),
    };
    return { grammar, vocabulary: { available: vocab.freshAvailable, threshold: vocab.taskCount * 2, low: vocab.words > 0 && vocab.freshAvailable < vocab.taskCount * 2, plan: vocabPlan } };
  }
  const settings = loadSettings(db).values;
  const last = db.prepare("SELECT blueprint_revision_id AS id FROM sessions WHERE purpose = 'practice' AND blueprint_revision_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined;
  const policy = last ? loadBlueprint(db, last.id).policy : null;
  const pool = policy?.skillPool ?? [];
  const blocked = loadBlockedFingerprints(db);
  const candidates = loadCandidates(db, "practice", pool, difficultyLevels(settings));
  const usable = candidates.filter(c => c.unitFingerprints.length > 0 && c.unitFingerprints.every(f => !blocked.has(f)));
  const claimed = new Set<string>();
  let available = 0;
  for (const c of usable) {
    if (c.unitFingerprints.some(f => claimed.has(f))) continue;
    available++;
    c.unitFingerprints.forEach(f => claimed.add(f));
  }
  const threshold = settings.taskCount * 2;
  const quotas = scaleQuotas(policy?.quotas ?? DEFAULT_QUOTAS, settings.taskCount);
  const formatLow = Object.entries(quotas).some(([format, n]) => n > 0 && usable.filter(c => c.format === format).length < n * 2) || (policy?.readingBlocks === 1 && usable.filter(c => c.format === "context_reading").length < 2);
  const vocab = vocabularyPracticeStatus(db);
  const vocabFresh = vocab.freshAvailable;
  const grammar = { available, threshold, low: available < threshold || formatLow, scope: last ? "current lesson skills" : "all grammar skills", bySkill: [...new Set(usable.map(c => c.skillId))].map(skill => ({ skill, available: usable.filter(c => c.skillId === skill).length })) };
  const vocabulary = { available: vocabFresh, threshold: vocab.taskCount * 2, low: vocab.words > 0 && vocabFresh < vocab.taskCount * 2, plan: vocabPlan };
  return { grammar, vocabulary };
}
