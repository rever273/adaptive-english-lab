import { GRAMMAR_REPEAT_CONFIG } from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import type { BankCandidate } from "./bank.js";

const DAY_MS = 86_400_000;

type Outcome = "correct" | "assisted" | "skipped" | "miss";
const SEVERITY: Record<Outcome, number> = { correct: 0, skipped: 1, assisted: 2, miss: 3 };

export interface ShownGrammar {
  at: string;
  slotId: string;
  outcome: Outcome;
}

/**
 * D68: revision -> when it was last shown in an ENDED grammar practice session (completed / ended early) and how the first attempt went.
 * Raw facts only (attempts, assessments, events, exposures): no model. A hint or shown answer before the try = assisted; confirmed or
 * tentative "incorrect" and "I don't know" = miss; an answer that is still unchecked or only model-decided counts as correct (the long interval) because it is
 * no evidence of a miss; a slot that was seen but not answered = skipped. For a reading passage the worst question of the last showing wins.
 */
export function shownGrammarRevisions(db: Db): Map<string, ShownGrammar> {
  const slots = db
    .prepare(
      `SELECT ss.id AS slotId, ss.session_id AS sessionId, ss.exercise_revision_id AS revisionId, MAX(x.at) AS at
         FROM session_slots ss JOIN sessions s ON s.id = ss.session_id
         JOIN (SELECT slot_id, server_at AS at FROM session_events WHERE event_type IN ('reveal','skip') AND slot_id IS NOT NULL
               UNION ALL SELECT slot_id, submitted_at FROM attempts
               UNION ALL SELECT slot_id, exposed_at FROM exposures) x ON x.slot_id = ss.id
        WHERE s.purpose = 'practice' AND s.status IN ('completed','ended_early') AND s.blueprint_revision_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM vocabulary_sessions v WHERE v.session_id = s.id)
        GROUP BY ss.id ORDER BY at, ss.id`,
    )
    .all() as Array<{ slotId: string; sessionId: string; revisionId: string; at: string }>;
  const first = db.prepare("SELECT id, hints_before AS hints, answer_seen_before AS seen, idk FROM attempts WHERE slot_id = ? AND attempt_no = 1");
  // only deterministic or human, confirmed verdicts schedule a repeat: a model-decided (tentative) answer stays "unchecked"
  const latest = db.prepare("SELECT verdict FROM assessment_revisions WHERE attempt_id = ? AND source IN ('deterministic','human') AND confirmation = 'confirmed' ORDER BY sequence DESC LIMIT 1");
  const outcomeOf = (slotId: string): Outcome => {
    const a = first.get(slotId) as { id: string; hints: number; seen: number; idk: number } | undefined;
    if (!a) return "skipped";
    if (a.hints > 0 || a.seen === 1) return "assisted";
    if (a.idk === 1) return "miss";
    const v = (latest.get(a.id) as { verdict: string } | undefined)?.verdict;
    return v === "incorrect" || v === "idk" ? "miss" : "correct";
  };
  const out = new Map<string, ShownGrammar & { sessionId: string }>();
  for (const r of slots) {
    const outcome = outcomeOf(r.slotId);
    const prev = out.get(r.revisionId);
    // slots are in time order: a later session replaces the history; inside one session (reading questions) the worst outcome stays
    if (prev && prev.sessionId === r.sessionId && SEVERITY[prev.outcome] > SEVERITY[outcome]) out.set(r.revisionId, { ...prev, at: r.at });
    else out.set(r.revisionId, { at: r.at, slotId: r.slotId, outcome, sessionId: r.sessionId });
  }
  return out;
}

export interface RepeatState {
  /** candidates for the solver: fresh ones unchanged, due repeats flagged with their still-unexposed fingerprints */
  candidates: BankCandidate[];
  /** exercises shown before that are not due yet (neither fresh nor repeat now) */
  waiting: number;
  /** due repeats among the candidates */
  repeats: number;
}

/**
 * Applies the D68 repeat rules to the bank candidates of a lesson: a revision shown in an earlier ended grammar session is dropped while
 * it is not due (missed / assisted / skipped: the next session; correct: normally after 3 days, or 1 day when filling a shortage) and otherwise offered as a repeat whose
 * `unitFingerprints` are only the units never exposed. A revision held by another slot (an unexposed unit reserved) stays out.
 * `horizon: "eventually"` (stock planning) treats every shown revision as reusable, whatever the interval.
 */
export function withRepeats(db: Db, all: readonly BankCandidate[], now: Date, horizon: "now" | "shortage" | "eventually" = "now"): RepeatState {
  const shown = shownGrammarRevisions(db);
  const exposed = new Set((db.prepare("SELECT unit_id AS id FROM exposures").all() as Array<{ id: string }>).map((r) => r.id));
  const reserved = new Set((db.prepare("SELECT unit_id AS id FROM prompt_reservations").all() as Array<{ id: string }>).map((r) => r.id));
  const units = new Map<string, Array<{ id: string; fingerprint: string }>>();
  for (const u of db
    .prepare(
      `SELECT rpu.revision_id AS revisionId, u.id AS id, u.fingerprint AS fingerprint
         FROM revision_prompt_units rpu JOIN prompt_units u ON u.id = rpu.unit_id
        WHERE rpu.revision_id IN (SELECT revision_id FROM selectable_revisions)`,
    )
    .all() as Array<{ revisionId: string; id: string; fingerprint: string }>) {
    (units.get(u.revisionId) ?? units.set(u.revisionId, []).get(u.revisionId)!).push({ id: u.id, fingerprint: u.fingerprint });
  }
  const candidates: BankCandidate[] = [];
  let waiting = 0;
  let repeats = 0;
  for (const c of all) {
    const seen = shown.get(c.revisionId);
    if (!seen) {
      candidates.push(c);
      continue;
    }
    const due = horizon === "eventually" || seen.outcome !== "correct" || now.getTime() - Date.parse(seen.at) >= (horizon === "shortage" ? GRAMMAR_REPEAT_CONFIG.shortageAfterDays : GRAMMAR_REPEAT_CONFIG.correctAfterDays) * DAY_MS;
    const mine = units.get(c.revisionId) ?? [];
    const unexposed = mine.filter((u) => !exposed.has(u.id));
    if (!due || mine.length === 0 || unexposed.some((u) => reserved.has(u.id))) {
      waiting++;
      continue;
    }
    repeats++;
    candidates.push({ ...c, unitFingerprints: unexposed.map((u) => u.fingerprint).sort(), repeat: { reason: seen.outcome === "correct" ? "review" : seen.outcome === "assisted" ? "assisted" : "missed", ofSlotId: seen.slotId } });
  }
  return { candidates, waiting, repeats };
}

/** a repeat slot (D68) carries `repeat: true` in cohort_json: practice only, never independent evidence */
export function isRepeatSlot(db: Db, slotId: string): boolean {
  const r = db.prepare("SELECT cohort_json AS c FROM session_slots WHERE id = ?").get(slotId) as { c: string | null } | undefined;
  if (!r?.c) return false;
  try {
    return (JSON.parse(r.c) as { repeat?: unknown }).repeat === true;
  } catch {
    return false;
  }
}
