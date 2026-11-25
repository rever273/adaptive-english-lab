import type { Db } from "../../db/open.js";
import { learningDate } from "../journey/calendar.js";
import { normalizeWord } from "./forms.js";
import { wordEvents } from "./practice.js";

/**
 * word-strength-v1 (TASK_037 §6, D155-D156): one 0-10 figure per saved word from the raw events of the three vocabulary modes. Computed on every
 * request and never stored, so a new version can change the weights without touching history. It is not Mastery, XP or `learned`, and nothing reads
 * it to choose exercises.
 */
export const WORD_STRENGTH_VERSION = "word-strength-v1";
export const STRENGTH_CONFIG = {
  /** pseudo-misses: a few successes never give 10 at once */
  prior: 2,
  /** the first success of a day after evidence on an earlier day */
  otherDayFactor: 1.5,
  /** most success weight one source can add to one word on one day */
  dailyCap: 1.5,
  halfLifeDays: 90,
} as const;

export type StrengthSource = "practice" | "oneWord" | "contextLoop" | "checks";
export interface Evidence {
  at: string;
  source: StrengthSource;
  /** weight before the corrections */
  w: number;
  /** 1 = success, 0 = miss, a fraction for a lesson score */
  s: number;
}

export interface Strength {
  value: number;
  version: typeof WORD_STRENGTH_VERSION;
  parts: Record<StrengthSource, { success: number; miss: number }>;
}

const DAY = 86_400_000;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function wordStrength(evidence: readonly Evidence[], now: Date): Strength {
  const parts: Strength["parts"] = { practice: { success: 0, miss: 0 }, oneWord: { success: 0, miss: 0 }, contextLoop: { success: 0, miss: 0 }, checks: { success: 0, miss: 0 } };
  const list = [...evidence].sort((a, b) => a.at.localeCompare(b.at));
  const days = new Set<string>();
  const boosted = new Set<string>();
  const used = new Map<string, number>();
  let S = 0;
  let F = 0;
  for (const e of list) {
    const day = learningDate(Date.parse(e.at));
    let ws = e.w * e.s;
    const wf = e.w * (1 - e.s);
    if (ws > 0 && !boosted.has(day) && [...days].some((d) => d < day)) {
      ws *= STRENGTH_CONFIG.otherDayFactor;
      boosted.add(day);
    }
    const key = `${day}|${e.source}`;
    const room = Math.max(0, STRENGTH_CONFIG.dailyCap - (used.get(key) ?? 0));
    ws = Math.min(ws, room);
    used.set(key, (used.get(key) ?? 0) + ws);
    const decay = 0.5 ** (Math.max(0, now.getTime() - Date.parse(e.at)) / DAY / STRENGTH_CONFIG.halfLifeDays);
    S += ws * decay;
    F += wf * decay;
    parts[e.source].success += ws * decay;
    parts[e.source].miss += wf * decay;
    days.add(day);
  }
  for (const p of Object.values(parts)) {
    p.success = round(p.success);
    p.miss = round(p.miss);
  }
  return { value: S + F === 0 ? 0 : round((10 * S) / (S + F + STRENGTH_CONFIG.prior), 1), version: WORD_STRENGTH_VERSION, parts };
}

/** the raw evidence of every word (entry id -> evidence), from the stored attempts of the three modes */
export function strengthEvidence(db: Db): Map<string, Evidence[]> {
  const out = new Map<string, Evidence[]>();
  const add = (id: string, e: Evidence) => (out.get(id) ?? out.set(id, []).get(id)!).push(e);
  const byLemma = new Map((db.prepare("SELECT id, lemma FROM vocabulary_entries").all() as Array<{ id: string; lemma: string }>).map((r) => [normalizeWord(r.lemma), r.id]));
  // Vocabulary Practice: confirmed first attempts (the same events its scheduler reads)
  for (const [lemma, events] of wordEvents(db)) {
    const id = byLemma.get(lemma);
    if (!id) continue;
    for (const e of events) {
      if (e.outcome === "assisted") add(id, { at: e.at, source: "practice", w: 0.5, s: 0 });
      else add(id, { at: e.at, source: "practice", w: e.independent === false ? 0.3 : 1, s: e.outcome === "success" ? 1 : 0 });
    }
  }
  // Single Word Practice: one finished pass, scored 0-100
  for (const r of db.prepare("SELECT l.entry_id AS id, r.completed_at AS at, r.score FROM word_lesson_runs r JOIN word_lessons l ON l.id = r.lesson_id WHERE r.status = 'completed'").all() as Array<{ id: string; at: string; score: number }>) {
    add(r.id, { at: r.at, source: "oneWord", w: 1, s: Math.max(0, Math.min(1, r.score / 100)) });
  }
  // Context Loop: first encounters, checks in another sentence, typed/spoken checks; returns of the same sentence are practice only
  for (const r of db.prepare("SELECT entry_id AS id, created_at AS at, kind, encounter, new_context AS nc, same_in_session AS same, outcome, first_letter_hint AS hint FROM context_loop_attempts").all() as Array<{ id: string; at: string; kind: string; encounter: number; nc: number; same: number; outcome: string; hint: number }>) {
    if (r.kind === "check") {
      if (r.outcome === "correct") add(r.id, { at: r.at, source: "checks", w: r.hint ? 0.3 : 1, s: 1 });
      else if (r.outcome === "incorrect") add(r.id, { at: r.at, source: "checks", w: r.hint ? 0.3 : 1, s: 0 });
      continue;
    }
    const ok = r.outcome === "recalled" ? 1 : 0;
    if (r.encounter === 1) add(r.id, { at: r.at, source: "contextLoop", w: r.nc ? 0.6 : ok ? 0.2 : 0.4, s: ok });
    else if (!r.same) add(r.id, { at: r.at, source: "contextLoop", w: 0.3, s: ok });
  }
  return out;
}

export function strengthOf(db: Db, entryIds: readonly string[], now: Date = new Date()): Map<string, Strength> {
  const ev = strengthEvidence(db);
  return new Map(entryIds.map((id) => [id, wordStrength(ev.get(id) ?? [], now)]));
}
