import { createHash } from "node:crypto";
import type { Prompt, RevealResponse, SlotState } from "@english-lab/contracts";
import { clampMultiplier, familyCap, type DiscoveryConfig } from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { runDiscovery } from "../analytics/discoveryAdapter.js";
import { localDateIn } from "../attempts/canonical.js";
import { NO_MISTAKE_ID } from "../content/grader.js";
import { loadBlockedFingerprints, loadCandidates } from "./bank.js";
import { recordDisplayedEncounters } from "../vocabulary/repository.js";
import { exposeUnits } from "./exposure.js";
import { assertLease } from "./lease.js";
import { loadBlueprint, loadPlan, type SessionDeps } from "./policy.js";
import { loadPriorities } from "./priorities.js";

interface SlotRow {
  slotId: string;
  sessionId: string;
  ordinal: number;
  revisionId: string;
  questionId: string | null;
  readingGroupId: string | null;
  inputPreference: "text" | "voice";
  format: string;
  dimension: string;
  content: string;
}

function loadSlot(db: Db, slotId: string): SlotRow {
  const r = db
    .prepare(
      `SELECT ss.id AS slotId, ss.session_id AS sessionId, ss.ordinal AS ordinal, ss.exercise_revision_id AS revisionId, ss.question_id AS questionId,
              ss.reading_group_id AS readingGroupId, ss.input_preference AS inputPreference, er.type AS format, er.dimension AS dimension, er.content_json AS content
         FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?`,
    )
    .get(slotId) as SlotRow | undefined;
  if (!r) throw new ApiError(404, "SLOT_NOT_FOUND", "Unknown slot");
  return r;
}

/** Prompt and options only: accepted ids, rubric, explanation and hints never leave the server at reveal. */
export function buildPrompt(format: string, contentJson: string, questionId: string | null, slotId = ""): Prompt {
  const c = JSON.parse(contentJson) as { prompt_en: string; payload: Record<string, any> };
  const p = c.payload;
  const order = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => {
    const hash = (id: string) => createHash("sha256").update(`${slotId}:${id}`).digest("hex");
    return hash(a.id).localeCompare(hash(b.id));
  });
  switch (format) {
    case "choose_form":
    case "choose_missing_fragment":
      return { kind: "choice", prompt_en: c.prompt_en, options: order(p.options.map((o: { id: string; text: string }) => ({ id: o.id, text: o.text }))), multiple: Boolean(p.multiple) };
    case "detect_error":
      return { kind: "segments", prompt_en: c.prompt_en, sentence: p.sentence, segments: displaySegments(p.segments, Boolean(p.no_mistake), p.accepted_segment_ids ?? [], slotId), noMistakeId: NO_MISTAKE_ID };
    case "guided_short_answer":
    case "russian_to_english_short":
      return { kind: "short", prompt_en: c.prompt_en, cue_ru: p.cue_ru, max_words: p.max_words, allow_voice: Boolean(p.allow_voice) };
    case "context_reading": {
      const q = (p.questions as Array<{ id: string; prompt: string; options: Array<{ id: string; text: string }> }>).find((x) => x.id === questionId);
      if (!q) throw new ApiError(500, "READING_QUESTION_MISSING", "Reading slot has no matching question");
      return { kind: "reading", prompt_en: c.prompt_en, paragraphs: p.paragraphs, question: { id: q.id, prompt: q.prompt, options: order(q.options.map((o) => ({ id: o.id, text: o.text }))) } };
    }
    default:
      throw new ApiError(500, "UNKNOWN_FORMAT", `Unknown exercise format ${format}`);
  }
}

/** Preserve answer IDs and sentence order while avoiding the one-piece no-mistake and fixed middle-error cues in the slice bank. */
function displaySegments(segments: Array<{ id: string; text: string }>, noMistake: boolean, accepted: string[], slotId: string): Array<{ id: string; text: string }> {
  const split = (s: { id: string; text: string }, parts: number) => {
    const words = s.text.match(/\S+\s*/g) ?? [];
    if (words.length < parts) return null;
    const leading = s.text.match(/^\s*/)?.[0] ?? "";
    return Array.from({ length: parts }, (_, i) => ({ id: `${s.id}:display:${i}`, text: (i === 0 ? leading : "") + words.slice(Math.floor(i * words.length / parts), Math.floor((i + 1) * words.length / parts)).join("") }));
  };
  if (noMistake && segments.length === 1) return split(segments[0]!, 4) ?? segments;
  if (!noMistake && segments.length === 3) {
    const preference = createHash("sha256").update(slotId).digest()[0]! % 2;
    for (const index of preference ? [2, 0] : [0, 2]) {
      if (accepted.includes(segments[index]!.id)) continue;
      const parts = split(segments[index]!, 2);
      if (parts) return [...segments.slice(0, index), ...parts, ...segments.slice(index + 1)];
    }
  }
  return segments;
}

export function slotState(db: Db, slotId: string): SlotState {
  const ev = new Set((db.prepare("SELECT event_type AS t FROM session_events WHERE slot_id = ?").all(slotId) as Array<{ t: string }>).map((e) => e.t));
  if (ev.has("continue")) return "continued";
  if (ev.has("skip")) return "skipped";
  if (db.prepare("SELECT 1 FROM attempts WHERE slot_id = ?").get(slotId)) return "answered";
  return ev.has("reveal") ? "revealed" : "unrevealed";
}

/**
 * First reveal of a slot: commit the exposure of every shown sentence, then record the reveal event, then return the prompt - all in
 * one transaction, so the learner can never see a sentence the ledger does not know. A reading passage is revealed atomically with
 * all its children and its passage is exposed once. Reveal of an already revealed slot (resume) exposes nothing new.
 */
export function revealSlot(db: Db, deps: SessionDeps, sessionId: string, slotId: string, tabId: string): RevealResponse {
  return db
    .transaction((): RevealResponse => {
      const s = db.prepare("SELECT status, timezone FROM sessions WHERE id = ?").get(sessionId) as { status: string; timezone: string } | undefined;
      if (!s) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
      if (s.status !== "active") throw new ApiError(409, "SESSION_NOT_ACTIVE", "Session is not active");
      assertLease(db, deps, sessionId, tabId);
      let slot = loadSlot(db, slotId);
      if (slot.sessionId !== sessionId) throw new ApiError(404, "SLOT_NOT_FOUND", "Slot does not belong to this session");

      const already = db.prepare("SELECT 1 FROM session_events WHERE slot_id = ? AND event_type = 'reveal'").get(slotId) !== undefined;
      if (!already) {
        recheckDiscovery(db, deps, sessionId, slot);
        slot = loadSlot(db, slotId); // the slot may have been replaced
        const group = slot.readingGroupId
          ? (db.prepare("SELECT id FROM session_slots WHERE session_id = ? AND reading_group_id = ? ORDER BY ordinal").all(sessionId, slot.readingGroupId) as Array<{ id: string }>).map((r) => r.id)
          : [slotId];
        exposeUnits(db, deps, slotId, slot.revisionId, "shown"); // before any reveal event or response exists
        const at = deps.now();
        const ins = db.prepare("INSERT OR IGNORE INTO session_events(id, session_id, slot_id, client_event_id, event_type, payload_json, server_at, local_date, timezone) VALUES (?,?,?,?,?,?,?,?,?)");
        for (const id of group) ins.run(deps.newId(), sessionId, id, `reveal:${id}`, "reveal", JSON.stringify({ schema_version: 1 }), at.toISOString(), localDateIn(s.timezone, at), s.timezone);
        for (const id of group) recordDisplayedEncounters(db, deps, id); // what the learner is shown now, counted once per slot
      }

      const hints = (JSON.parse(slot.content) as { hints_ru?: string[] }).hints_ru ?? [];
      return {
        slotId: slot.slotId,
        ordinal: slot.ordinal,
        format: slot.format,
        dimension: slot.dimension,
        inputPreference: slot.inputPreference,
        questionId: slot.questionId,
        readingGroupId: slot.readingGroupId,
        prompt: buildPrompt(slot.format, slot.content, slot.questionId, slot.slotId),
        hintsAvailable: hints.length,
        alreadyRevealed: already,
        state: slotState(db, slotId),
      };
    })
    .immediate();
}

/**
 * discovery-v1 recheck (spec/04): an undelivered discovery probe whose hypothesis was rejected/disputed meanwhile is replaced
 * atomically by another approved exercise of the same format (audited as a `replacement` event), or the slot reports a shortage.
 * Anything already shown is history and is never rewritten.
 */
function recheckDiscovery(db: Db, deps: SessionDeps, sessionId: string, slot: SlotRow): void {
  const decision = db.prepare("SELECT choices_json AS c FROM scheduling_decisions WHERE session_id = ?").get(sessionId) as { c: string } | undefined;
  if (!decision) return;
  const parsed = JSON.parse(decision.c) as { slots: Array<{ slotId: string; role: string; skillId: string; format: string; revisionId: string }>; discovery: { config: DiscoveryConfig }; blueprint: { revisionId: string } };
  const choice = parsed.slots.find((x) => x.slotId === slot.slotId);
  if (!choice || choice.role !== "discovery") return;
  if (db.prepare("SELECT 1 FROM session_events WHERE slot_id = ? AND event_type = 'replacement'").get(slot.slotId)) return;

  const now = deps.now().toISOString();
  const taxonomyId = (db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id;
  const live = runDiscovery(db, { asOf: now, taxonomyId, config: parsed.discovery.config });
  const stillSuspected = (live.skills.find((x) => x.skillId === choice.skillId)?.bonus ?? 0) > 0;
  if (stillSuspected) return;

  const blueprint = loadBlueprint(db, parsed.blueprint.revisionId);
  const candidates = loadCandidates(db, "practice", blueprint.policy.skillPool).filter((c) => c.format === choice.format && c.revisionId !== slot.revisionId);
  const blocked = loadBlockedFingerprints(db);
  const used = db
    .prepare(
      `SELECT er.exercise_id AS exerciseId, er.template_cluster AS cluster, sr.family AS family
         FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
         JOIN exercise_skills es ON es.revision_id = er.id AND es.role = 'target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id
        WHERE ss.session_id = ? AND ss.id <> ?`,
    )
    .all(sessionId, slot.slotId) as Array<{ exerciseId: string; cluster: string; family: string }>;
  const n = (db.prepare("SELECT COUNT(*) AS n FROM session_slots WHERE session_id = ?").get(sessionId) as { n: number }).n;
  const familyCount = new Map<string, number>();
  for (const u of used) familyCount.set(u.family, (familyCount.get(u.family) ?? 0) + 1);
  const priorities = loadPriorities(db, candidates, now, taxonomyId);
  const plan = loadPlan(db, deps);
  const options = candidates
    .filter((c) => !c.unitFingerprints.some((f) => blocked.has(f)))
    .filter((c) => !used.some((u) => u.exerciseId === c.exerciseId || u.cluster === c.templateCluster))
    .filter((c) => (familyCount.get(c.family) ?? 0) + 1 <= familyCap(n))
    .map((c) => ({ c, p: priorities.lookup(c.skillId, c.dimension, c.cohort ?? "") * clampMultiplier(plan.multipliers[c.skillId]) }))
    .sort((a, b) => b.p - a.p || (a.c.revisionId < b.c.revisionId ? -1 : 1));
  const next = options[0]?.c;
  if (!next) {
    throw new ApiError(409, "CONTENT_SHORTAGE", "The suspected-skill probe is no longer eligible and no approved replacement is available", { slotId: slot.slotId, format: choice.format });
  }

  // release the unshown reservations of the old revision, reserve the replacement's units, then repoint the undelivered slot
  db.prepare("DELETE FROM prompt_reservations WHERE slot_id = ?").run(slot.slotId);
  const reserve = db.prepare("INSERT INTO prompt_reservations(unit_id, slot_id, created_at) VALUES (?,?,?)");
  for (const u of db.prepare("SELECT DISTINCT unit_id AS unitId FROM revision_prompt_units WHERE revision_id = ?").all(next.revisionId) as Array<{ unitId: string }>) reserve.run(u.unitId, slot.slotId, now);
  db.prepare("UPDATE session_slots SET exercise_revision_id = ?, cohort_json = ? WHERE id = ?").run(next.revisionId, JSON.stringify({ criterionVersion: next.rubricVersion, difficulty: next.difficulty, role: "explore" }), slot.slotId);
  const tz = (db.prepare("SELECT timezone FROM sessions WHERE id = ?").get(sessionId) as { timezone: string }).timezone;
  db.prepare("INSERT INTO session_events(id, session_id, slot_id, client_event_id, event_type, payload_json, server_at, local_date, timezone) VALUES (?,?,?,?,?,?,?,?,?)").run(
    deps.newId(),
    sessionId,
    slot.slotId,
    `replacement:${slot.slotId}`,
    "replacement",
    JSON.stringify({ schema_version: 1, reason: "discovery_hypothesis_withdrawn", suspectedSkill: choice.skillId, from: slot.revisionId, to: next.revisionId, discoveryWatermark: live.watermark, reviewWatermark: live.reviewWatermark }),
    now,
    localDateIn(tz, deps.now()),
    tz,
  );
}
