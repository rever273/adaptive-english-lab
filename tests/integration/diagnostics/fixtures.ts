import { randomUUID } from "node:crypto";
import { REVIEW_CHECKLIST_KEYS } from "@english-lab/contracts";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { NullOutbox } from "../../../apps/server/src/domain/attempts/ports.js";
import { approveRevision, publishRelease, registerRevision, submitForReview, submitReview } from "../../../apps/server/src/domain/content/repository.js";
import { buildSliceBank } from "../../../content/slice/slice-bank.mjs";
import { buildDiagnosticBank, buildHeldoutBank } from "../../../content/slice/diagnostic-bank.mjs";
import { revealSlot } from "../../../apps/server/src/domain/sessions/reveal.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { addEvent, makeEnv, makeSession, makeSlot, one, rows, type Env } from "../attempts/fixtures.js";

export type Content = Record<string, any>;
export const practiceBank = (): Content[] => buildSliceBank() as Content[];
export const diagnosticBank = (): Content[] => buildDiagnosticBank() as Content[];
export const heldoutBank = (): Content[] => buildHeldoutBank() as Content[];

const REVIEWER = "agent:test-reviewer@1";
const deps = (env: Env) => ({ now: env.deps.now, newId: randomUUID });

/** Registers, reviews (individually), approves and releases the given exercises through the real pipeline. Returns revision ids by content id. */
export function seed(env: Env, contents: Content[]): Map<string, string> {
  const d = deps(env);
  const out = new Map<string, string>();
  const release: string[] = [];
  for (const content of contents) {
    const r = registerRevision(env.db, d, { content, actor: { type: "agent", id: "test-author" } });
    out.set(content.id, r.revisionId);
    submitForReview(env.db, d, r.revisionId, { type: "agent", id: "test-reviewer" });
    const checklist = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, k === "distractors_valid" || k === "no_mistake_case_correct" ? "n/a" : true])) as Record<string, boolean | "n/a">;
    if (content.type === "choose_form" || content.type === "choose_missing_fragment") checklist.distractors_valid = true;
    if (content.type === "detect_error") checklist.no_mistake_case_correct = true;
    submitReview(env.db, d, { revisionId: r.revisionId, reviewer: REVIEWER, reviewVersion: "t1", contentHash: r.contentHash, checklist: checklist as never, verdict: "approved" });
    approveRevision(env.db, d, { revisionId: r.revisionId, actor: { type: "agent", id: "test-reviewer" } });
    release.push(r.revisionId);
  }
  if (release.length > 0) publishRelease(env.db, d, { revisionIds: release, reviewer: REVIEWER });
  return out;
}

export async function diagEnv(parts: { practice?: boolean; diagnostic?: boolean; heldout?: boolean } = { diagnostic: true }): Promise<{ env: Env; ids: Map<string, string> }> {
  const env = await makeEnv({ assessor: ClosedFormAssessor });
  const contents = [...(parts.practice ? practiceBank() : []), ...(parts.diagnostic ? diagnosticBank() : []), ...(parts.heldout ? heldoutBank() : [])];
  return { env, ids: seed(env, contents) };
}

export const sessionDeps = (env: Env) => ({ now: env.deps.now, newId: randomUUID });

export interface SlotRow {
  slot_id: string;
  ordinal: number;
  revision_id: string;
  input_preference: string;
  cohort_json: string;
  type: string;
  dimension: string;
  bank_role: string;
  skill: string;
  content_json: string;
}
export const slotsOf = (env: Env, sessionId: string): SlotRow[] =>
  rows<SlotRow>(
    env.db,
    `SELECT ss.id AS slot_id, ss.ordinal AS ordinal, ss.exercise_revision_id AS revision_id, ss.input_preference AS input_preference, ss.cohort_json AS cohort_json,
            er.type AS type, er.dimension AS dimension, er.bank_role AS bank_role, sr.skill_id AS skill, er.content_json AS content_json
       FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
       JOIN exercise_skills es ON es.revision_id = er.id AND es.role = 'target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id
      WHERE ss.session_id = ? ORDER BY ss.ordinal`,
    sessionId,
  );

/** The correct answer for a stored exercise (the harness knows it; the app does not show it before the answer). */
export function correctAnswer(contentJson: string): string | string[] {
  const c = JSON.parse(contentJson) as { type: string; payload: Record<string, any> };
  const p = c.payload;
  if (c.type === "choose_form" || c.type === "choose_missing_fragment") return p.accepted_option_ids as string[];
  if (c.type === "detect_error") return p.no_mistake ? ["__no_mistake__"] : (p.accepted_segment_ids as string[]);
  return (p.accepted_answers as string[])[0]!;
}

/** the REAL reveal path: lease, exposure of the shown sentences, then the reveal event */
export function reveal(env: Env, sessionId: string, slot: SlotRow): void {
  takeLease(env.db, sessionDeps(env) as never, sessionId, "tab-t");
  revealSlot(env.db, sessionDeps(env) as never, sessionId, slot.slot_id, "tab-t");
}

/** Reveals a slot and answers it correctly through the real attempt path; returns the attempt id. */
export function answerSlot(env: Env, sessionId: string, slot: SlotRow, answer?: string | string[], real = true): string {
  if (real) reveal(env, sessionId, slot);
  else addEvent(env, sessionId, slot.slot_id, "reveal");
  const r = recordAttempt(env.db, { assessor: ClosedFormAssessor, outbox: NullOutbox, now: env.deps.now, newId: randomUUID }, { slotId: slot.slot_id, submissionId: randomUUID(), answer: answer ?? correctAnswer(slot.content_json), inputMode: "text" });
  return r.body.attemptId;
}

/** a practice-purpose session with one slot per given revision, all revealed and answered correctly at the CURRENT fake time */
export function practiseRevisions(env: Env, revisionIds: string[]): string {
  const sessionId = makeSession(env);
  revisionIds.forEach((rid, i) => {
    const slotId = makeSlot(env, sessionId, rid, i);
    const content = one<{ c: string }>(env.db, "SELECT content_json AS c FROM exercise_revisions WHERE id = ?", rid).c;
    answerSlot(env, sessionId, { slot_id: slotId, content_json: content } as SlotRow, undefined, false);
  });
  env.db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(sessionId);
  return sessionId;
}
