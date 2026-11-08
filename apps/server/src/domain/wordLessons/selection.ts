import { WORD_LESSON_DEFAULT_COUNT, WORD_LESSON_MAX_COUNT } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { VISIBLE, currentTranslations } from "../vocabulary/repository.js";
import { isValidWord, normalizeWord } from "../vocabulary/forms.js";
import { wordEvents } from "../vocabulary/practice.js";
import { wordState, type WordEvent } from "../vocabulary/schedule.js";

/** A word a lesson can be made for: saved, not removed, a valid word and a translation to base the lesson on. */
export interface EligibleWord {
  entryId: string;
  lemma: string;
  learned: boolean;
  createdAt: string;
  translationRu: string;
  surfaceForms: string[];
  pos: string;
}

export function eligibleWords(db: Db): { eligible: EligibleWord[]; waitingTranslation: number } {
  const rows = db
    .prepare(`SELECT id, lemma, pos, learned, surface_forms_json AS forms, created_at AS createdAt FROM vocabulary_entries WHERE ${VISIBLE} ORDER BY lemma`)
    .all() as Array<{ id: string; lemma: string; pos: string; learned: number; forms: string; createdAt: string }>;
  const valid = rows.filter((r) => isValidWord(r.lemma));
  const translations = currentTranslations(db, valid.map((r) => r.id));
  const eligible: EligibleWord[] = [];
  let waiting = 0;
  for (const r of valid) {
    const t = translations.get(r.id);
    if (!t) {
      waiting++;
      continue;
    }
    eligible.push({ entryId: r.id, lemma: r.lemma, learned: r.learned === 1, createdAt: r.createdAt, translationRu: t, surfaceForms: JSON.parse(r.forms) as string[], pos: r.pos });
  }
  return { eligible, waitingTranslation: waiting };
}

/**
 * Whom the learner knows worst comes first (deterministic, from the same first-attempt events the vocabulary scheduler reads; nothing is written):
 * words not marked learned, then the last attempt missed (or a recent miss), then helped, then never practised, then the rest by the shortest success streak.
 */
export function rankCandidates(words: readonly EligibleWord[], events: ReadonlyMap<string, WordEvent[]>, now: Date): EligibleWord[] {
  const keyed = words.map((w) => {
    const evs = events.get(normalizeWord(w.lemma)) ?? [];
    const st = wordState(normalizeWord(w.lemma), evs, w.learned, now);
    const tier = evs.length === 0 ? 2 : st.lastOutcome === "miss" || st.recentMisses > 0 ? 0 : st.lastOutcome === "assisted" ? 1 : 3;
    return { w, tier, priority: st.priority, streak: st.streak };
  });
  keyed.sort(
    (a, b) =>
      Number(a.w.learned) - Number(b.w.learned) ||
      a.tier - b.tier ||
      (a.tier === 3 ? a.streak - b.streak : 0) ||
      b.priority - a.priority ||
      a.w.createdAt.localeCompare(b.w.createdAt) ||
      a.w.lemma.localeCompare(b.w.lemma),
  );
  return keyed.map((k) => k.w);
}

export interface LessonStateCounts {
  /** entry ids that have a ready lesson */
  ready: Set<string>;
  generating: Set<string>;
  failed: Set<string>;
}

/** a lesson that is "generating" but has no job left (it ended, or the app was stopped) is shown and handled as failed */
const OPEN_JOB = "EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'generation' AND json_extract(j.payload_json, '$.wordLessonId') = l.id AND j.state IN ('queued','waiting_for_gpu','running','paused'))";

export function lessonStates(db: Db): LessonStateCounts {
  const out: LessonStateCounts = { ready: new Set(), generating: new Set(), failed: new Set() };
  for (const r of db.prepare(`SELECT l.entry_id AS id, l.status, ${OPEN_JOB} AS open FROM word_lessons l`).all() as Array<{ id: string; status: "ready" | "generating" | "failed"; open: number }>) {
    if (r.status === "generating" && r.open === 0) out.failed.add(r.id);
    else out[r.status].add(r.id);
  }
  return out;
}

export interface Coverage {
  ready: number;
  eligible: number;
  waitingTranslation: number;
  generating: number;
  failed: number;
  /** eligible words without a ready, generating or failed lesson, best first */
  candidates: EligibleWord[];
  /** failed lessons of eligible words (they can be retried) */
  retryable: string[];
}

export function wordLessonCoverage(db: Db, now: Date = new Date()): Coverage {
  const { eligible, waitingTranslation } = eligibleWords(db);
  const states = lessonStates(db);
  const ids = new Set(eligible.map((w) => w.entryId));
  const count = (s: Set<string>) => [...s].filter((id) => ids.has(id)).length;
  const open = eligible.filter((w) => !states.ready.has(w.entryId) && !states.generating.has(w.entryId) && !states.failed.has(w.entryId));
  return {
    ready: count(states.ready),
    eligible: eligible.length,
    waitingTranslation,
    generating: count(states.generating),
    failed: count(states.failed),
    candidates: rankCandidates(open, wordEvents(db), now),
    retryable: [...states.failed].filter((id) => ids.has(id)),
  };
}

export const defaultCount = (candidates: number): number => Math.min(WORD_LESSON_DEFAULT_COUNT, candidates);
export const clampCount = (n: number): number => Math.max(1, Math.min(WORD_LESSON_MAX_COUNT, Math.round(n)));
