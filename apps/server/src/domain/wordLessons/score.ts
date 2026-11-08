import { WORD_LESSON_SCORE_VERSION, WORD_LESSON_STAGES, type WordLessonEventKind, type WordLessonVerdictKind } from "@english-lab/contracts";

/**
 * word-lesson-score-v1 (D133): how independent the learner was, from the raw attempts, verdicts and hint events of one run. A plain table, no model.
 * Completion is not performance: a finished run with every hint opened and every answer corrected still scores low. The passive stage 1 carries no points.
 */
export const STAGE_WEIGHT: Record<number, number> = { 2: 20, 3: 30, 4: 25, 5: 25 };

export interface ItemEvidence {
  key: string;
  stage: 2 | 3 | 4 | 5;
  /** in time order; `verdict` is the CURRENT verdict of the attempt (code, then model, then a dispute) */
  attempts: Array<{ at: string; verdict: WordLessonVerdictKind }>;
  events: Array<{ at: string; kind: WordLessonEventKind }>;
}

export interface ItemCredit {
  key: string;
  stage: number;
  credit: number;
  reasons: string[];
}

export function itemCredit(e: ItemEvidence): ItemCredit {
  const reasons: string[] = [];
  const firstCorrect = e.attempts.findIndex((a) => a.verdict === "correct");
  const last = e.attempts[e.attempts.length - 1];
  const until = firstCorrect >= 0 ? e.attempts[firstCorrect]!.at : null;
  // hints count when they came before the answer that was accepted; with no accepted answer every hint counts
  const kinds = new Set(e.events.filter((x) => until === null || x.at <= until).map((x) => x.kind));
  let c: number;
  if (firstCorrect === 0) {
    c = 1;
    reasons.push("right first time");
  } else if (firstCorrect > 0) {
    c = 0.6;
    reasons.push("right after a correction");
  } else if (last && (last.verdict === "disputed" || last.verdict === "unresolved")) {
    c = 0.5;
    reasons.push(last.verdict === "disputed" ? "answer disputed by the learner" : "answer could not be checked");
  } else {
    c = 0.1;
    reasons.push("continued after feedback");
  }
  const cap = (limit: number, why: string) => {
    if (c > limit) {
      c = limit;
      reasons.push(why);
    }
  };
  if (e.stage === 2 && kinds.has("hint_word")) cap(0.2, "word shown by the hint");
  if ((e.stage === 3 || e.stage === 4) && kinds.has("hint_full")) cap(0.2, "full answer shown by the hint");
  else if ((e.stage === 3 || e.stage === 4) && kinds.has("hint_partial")) cap(0.6, "part of the answer shown");
  if (e.stage === 5 && kinds.has("hint_start")) cap(0.5, "start of a sentence shown");
  if (e.stage === 3 && kinds.has("translation")) {
    c = Math.max(0, c - 0.1);
    reasons.push("translation opened");
  }
  return { key: e.key, stage: e.stage, credit: Math.round(c * 100) / 100, reasons };
}

export interface ScoreResult {
  version: typeof WORD_LESSON_SCORE_VERSION;
  score: number;
  items: ItemCredit[];
  stages: Array<{ stage: number; title: string; credit: number | null; points: number; max: number; note: string }>;
}

export function scoreRun(items: readonly ItemEvidence[]): ScoreResult {
  const credits = items.map(itemCredit);
  const stages = WORD_LESSON_STAGES.map(({ n, title }) => {
    if (n === 1) return { stage: 1, title, credit: null, points: 0, max: 0, note: "Reading only: no points" };
    const mine = credits.filter((c) => c.stage === n);
    const max = STAGE_WEIGHT[n]!;
    const avg = mine.length > 0 ? mine.reduce((a, c) => a + c.credit, 0) / mine.length : 0;
    return { stage: n, title, credit: Math.round(avg * 100) / 100, points: Math.round(avg * max * 10) / 10, max, note: [...new Set(mine.flatMap((c) => c.reasons))].join("; ") };
  });
  const score = Math.max(0, Math.min(100, Math.round(stages.reduce((a, s) => a + s.points, 0))));
  return { version: WORD_LESSON_SCORE_VERSION, score, items: credits, stages };
}
