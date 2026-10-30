/** Base selection priority P (spec/04 "Adaptive selection"). Pure; the inputs come from mastery-v1 components and raw evidence counts. */

export interface PriorityInputs {
  /** mastery-v1 score S in [0,10] or null when unknown */
  score: number | null;
  /** score is "reliable" when the skill x dimension has base evidence (status developing | stable | stale), D35 */
  reliable: boolean;
  nEff: number | null;
  /** confirmed failures among the last 20 eligible opportunities */
  failuresLast20: number;
  /** days since the last independent opportunity; null = never practised */
  daysSinceLastIndependent: number | null;
}

export const PRIORITY_WEIGHTS = { weakness: 0.4, failurePressure: 0.25, due: 0.2, uncertainty: 0.15 } as const;

export interface PriorityComponents {
  weakness: number;
  uncertainty: number;
  failurePressure: number;
  due: number;
  p: number;
}

export function computePriority(i: PriorityInputs): PriorityComponents {
  const s = i.score === null ? 0.5 : i.score / 10;
  const weakness = i.reliable && i.score !== null ? 1 - i.score / 10 : 0.5;
  const uncertainty = 1 - Math.min((i.nEff ?? 0) / 12, 1);
  const failurePressure = Math.min(1, i.failuresLast20 / 5);
  const due = i.daysSinceLastIndependent === null ? 1 : Math.min(1, i.daysSinceLastIndependent / (2 + 18 * Math.max(s, 0.1)));
  const p = PRIORITY_WEIGHTS.weakness * weakness + PRIORITY_WEIGHTS.failurePressure * failurePressure + PRIORITY_WEIGHTS.due * due + PRIORITY_WEIGHTS.uncertainty * uncertainty;
  return { weakness, uncertainty, failurePressure, due, p };
}

/** Agent plan multiplier is clamped to [0.5, 2] and defaults to 1 (spec/04). */
export const clampMultiplier = (m: number | undefined): number => (m === undefined || Number.isNaN(m) ? 1 : Math.min(2, Math.max(0.5, m)));

/**
 * Starting-diagnostic prior (D62). Used ONLY for selection, and only while a skill x dimension has no practice evidence of its own:
 * each confirmed diagnostic failure (incl. "I don't know") raises the never-practised priority by 0.15 (at most +0.3); a skill
 * answered correctly every time in the diagnostic drops by 0.1. Mastery and reports never read it.
 */
export const DIAGNOSTIC_PRIOR = { perFailure: 0.15, maxRaise: 0.3, allCorrectDrop: 0.1 } as const;

export function diagnosticPrior(unknownP: number, outcome: { attempts: number; failures: number } | undefined): number {
  if (!outcome || outcome.attempts === 0) return unknownP;
  if (outcome.failures === 0) return Math.max(0, unknownP - DIAGNOSTIC_PRIOR.allCorrectDrop);
  return Math.min(1, unknownP + Math.min(DIAGNOSTIC_PRIOR.maxRaise, DIAGNOSTIC_PRIOR.perFailure * outcome.failures));
}
