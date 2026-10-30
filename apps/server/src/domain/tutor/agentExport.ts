import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";

/**
 * Read-only, bounded exports of ONE session or ONE exercise revision for an external reviewer (spec/06, spec/11), plus the short "Copy Agent Task" text.
 * Only validated UUIDs reach SQL; there are no free-form filters. The result is limited in size and never contains audio (none is stored), other
 * sessions, vocabulary or settings. This is a working rule for an agent, not an operating-system boundary (spec/06).
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EXPORT_LIMITS = { slots: 100, text: 2000, attemptsPerSlot: 5, findingsPerAttempt: 20 } as const;

export type AgentTaskKind = "session" | "exercise" | "batch" | "findings" | "coverage" | "progress" | "lessons";

const cut = (s: string | null | undefined, n: number = EXPORT_LIMITS.text): string => ((s ?? "").length > n ? `${(s ?? "").slice(0, n)}…[cut]` : (s ?? ""));
/** values written into Markdown: no raw HTML, no line structure of their own */
export const mdText = (s: unknown): string => cut(String(s ?? "")).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!).replace(/\s*\n\s*/g, " ⏎ ");

function mustBeId(id: string, what: string): void {
  if (!UUID_RE.test(id)) throw new ApiError(400, "BAD_ID", `${what} must be a UUID`);
}

export function exportSession(db: Db, sessionId: string): { json: object; markdown: string } {
  mustBeId(sessionId, "session id");
  return db
    .transaction(() => {
      const s = db.prepare("SELECT id, purpose, status, created_at AS createdAt, ended_at AS endedAt, timezone FROM sessions WHERE id = ?").get(sessionId) as { id: string; purpose: string; status: string; createdAt: string; endedAt: string | null; timezone: string } | undefined;
      if (!s) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
      const total = (db.prepare("SELECT COUNT(*) AS n FROM session_slots WHERE session_id = ?").get(sessionId) as { n: number }).n;
      const slots = (
        db
          .prepare(
            `SELECT ss.id AS slotId, ss.ordinal, ss.exercise_revision_id AS revisionId, er.content_hash AS contentHash, er.type, er.dimension, er.difficulty, er.content_json AS content, ss.question_id AS questionId
               FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ? ORDER BY ss.ordinal LIMIT ?`,
          )
          .all(sessionId, EXPORT_LIMITS.slots) as Array<{ slotId: string; ordinal: number; revisionId: string; contentHash: string; type: string; dimension: string; difficulty: string; content: string; questionId: string | null }>
      ).map((r) => {
        const c = JSON.parse(r.content) as { prompt_en: string; target_skill: string };
        const events = (db.prepare("SELECT event_type AS t FROM session_events WHERE slot_id = ? ORDER BY server_at, rowid").all(r.slotId) as Array<{ t: string }>).map((e) => e.t);
        const attempts = (db.prepare("SELECT id, attempt_no AS n, raw_answer_json AS raw, input_mode AS inputMode, hints_before AS hints, answer_seen_before AS answerSeen, idk, submitted_at AS at FROM attempts WHERE slot_id = ? ORDER BY attempt_no LIMIT ?").all(r.slotId, EXPORT_LIMITS.attemptsPerSlot) as Array<{ id: string; n: number; raw: string; inputMode: string; hints: number; answerSeen: number; idk: number; at: string }>).map((a) => {
          const latest = db.prepare("SELECT sequence, source, verdict, confirmation, rationale FROM latest_assessments WHERE attempt_id = ?").get(a.id) as { sequence: number; source: string; verdict: string; confirmation: string; rationale: string } | undefined;
          const findings = db.prepare("SELECT fragment_start AS start, fragment_end AS end, correction, explanation_ru AS explanation, finding_type AS findingType, verdict, confidence FROM error_events WHERE assessment_id IN (SELECT id FROM assessment_revisions WHERE attempt_id = ?) LIMIT ?").all(a.id, EXPORT_LIMITS.findingsPerAttempt);
          return { attemptId: a.id, attemptNo: a.n, inputMode: a.inputMode, hintsBefore: a.hints, answerSeenBefore: Boolean(a.answerSeen), idk: Boolean(a.idk), submittedAt: a.at, answer: cut(a.raw), assessment: latest ? { ...latest, rationale: cut(latest.rationale, 500), note: latest.confirmation === "confirmed" ? "confirmed" : "NOT confirmed (model or pending); do not treat as a verified mistake" } : null, findings };
        });
        return { ordinal: r.ordinal, slotId: r.slotId, revisionId: r.revisionId, contentHash: r.contentHash, type: r.type, dimension: r.dimension, difficulty: r.difficulty, targetSkill: c.target_skill, prompt: cut(c.prompt_en, 500), events, attempts };
      });
      const json = { schema_version: "session-export-v1", note: "Read-only, bounded. Raw attempts are history and must not be modified. Report disputes through the application workflow.", session: s, slotCount: total, truncated: total > slots.length, slots };
      const md = [
        `# Session ${s.id}`,
        "",
        `purpose ${mdText(s.purpose)} · status ${mdText(s.status)} · ${mdText(s.createdAt)}${total > slots.length ? ` · first ${slots.length} of ${total} slots` : ""}`,
        "",
        "Read-only export. Do not modify raw attempts; propose corrections as review notes.",
        "",
        ...slots.flatMap((x) => [
          `## Slot ${x.ordinal + 1} — ${mdText(x.type)} (${mdText(x.targetSkill)})`,
          `revision ${x.revisionId} · hash ${x.contentHash.slice(0, 12)} · events: ${x.events.join(", ") || "none"}`,
          `task: ${mdText(x.prompt)}`,
          ...x.attempts.map((a) => `- attempt ${a.attemptNo} (${a.inputMode}${a.hintsBefore ? `, ${a.hintsBefore} hint(s)` : ""}${a.answerSeenBefore ? ", answer seen" : ""}${a.idk ? ", I don't know" : ""}): ${mdText(a.answer)} → ${a.assessment ? `${mdText(a.assessment.verdict)} / ${mdText(a.assessment.confirmation)} (${mdText(a.assessment.source)})` : "no assessment"}`),
          "",
        ]),
      ].join("\n");
      return { json, markdown: md };
    })
    .deferred();
}

export function exportExercise(db: Db, revisionId: string): { json: object; markdown: string } {
  mustBeId(revisionId, "exercise revision id");
  return db
    .transaction(() => {
      const r = db.prepare("SELECT id, exercise_id AS exerciseId, revision, type, dimension, difficulty, bank_role AS bankRole, content_hash AS contentHash, content_json AS content FROM exercise_revisions WHERE id = ?").get(revisionId) as { id: string; exerciseId: string; revision: number; type: string; dimension: string; difficulty: string; bankRole: string; contentHash: string; content: string } | undefined;
      if (!r) throw new ApiError(404, "REVISION_NOT_FOUND", "Unknown exercise revision");
      const state = (db.prepare("SELECT status FROM latest_content_state WHERE revision_id = ?").get(revisionId) as { status: string } | undefined)?.status ?? "unknown";
      const reviews = db.prepare("SELECT reviewer, review_version AS reviewVersion, verdict, content_hash AS contentHash FROM content_reviews WHERE revision_id = ? ORDER BY rowid LIMIT 50").all(revisionId);
      const siblings = db.prepare("SELECT id, revision, content_hash AS contentHash FROM exercise_revisions WHERE exercise_id = ? ORDER BY revision LIMIT 50").all(r.exerciseId);
      const use = db
        .prepare(
          `SELECT COUNT(DISTINCT ss.id) AS slots, COUNT(a.id) AS attempts,
                  SUM(CASE WHEN a.first_attempt = 1 AND la.verdict = 'correct' AND la.confirmation = 'confirmed' THEN 1 ELSE 0 END) AS firstCorrect,
                  SUM(CASE WHEN a.first_attempt = 1 THEN 1 ELSE 0 END) AS first
             FROM session_slots ss LEFT JOIN attempts a ON a.slot_id = ss.id LEFT JOIN latest_assessments la ON la.attempt_id = a.id WHERE ss.exercise_revision_id = ?`,
        )
        .get(revisionId);
      const content = JSON.parse(r.content) as Record<string, unknown>;
      const json = { schema_version: "exercise-export-v1", note: "Statuses are the application's; generated is not approved. Aggregate use only, no learner answers.", revision: { id: r.id, exerciseId: r.exerciseId, revision: r.revision, type: r.type, dimension: r.dimension, difficulty: r.difficulty, bankRole: r.bankRole, contentHash: r.contentHash, status: state }, content, reviews, siblings, use };
      const md = [`# Exercise revision ${r.id}`, "", `type ${mdText(r.type)} · ${mdText(r.dimension)} · ${mdText(r.difficulty)} · bank ${mdText(r.bankRole)} · status **${mdText(state)}** · revision ${r.revision} · hash ${r.contentHash.slice(0, 12)}`, "", "Content (JSON, as stored):", "", "```json", JSON.stringify(content, null, 2).replace(/```/g, "'''"), "```", "", `Reviews: ${(reviews as unknown[]).length}. Other revisions of this exercise: ${(siblings as unknown[]).length}.`, ""].join("\n");
      return { json, markdown: md };
    })
    .deferred();
}

/** The short text the learner copies for the VS Code agent: IDs, a relative spec path and an allowlisted command - never data. */
export function agentTask(db: Db, kind: AgentTaskKind, id?: string): string {
  if (kind === "progress" || kind === "lessons") return workflowTask(db, kind);
  if (kind === "coverage") return "Check the content coverage. Run: npm run lab:export -- coverage. Use content/review-guidelines.md. Report gaps; do not modify raw attempts.";
  if (kind === "findings") return "Review the tentative AI findings. Run: npm run lab:export -- findings --status tentative --limit 100. Use content/review-guidelines.md. Return a finding-review-v1 manifest; preserve raw attempts.";
  mustBeId(id ?? "", `${kind} id`);
  if (kind === "session") {
    if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
    return `Review session ${id}. Run: npm run lab:export -- session ${id}. Use content/review-guidelines.md. Return review notes or a finding-review-v1 manifest; preserve raw attempts.`;
  }
  if (kind === "exercise") {
    const r = db.prepare("SELECT revision FROM exercise_revisions WHERE id = ?").get(id) as { revision: number } | undefined;
    if (!r) throw new ApiError(404, "REVISION_NOT_FOUND", "Unknown exercise revision");
    return `Review exercise revision ${id} (revision ${r.revision}). Run: npm run lab:export -- exercise ${id}. Use content/review-guidelines.md. Return a content-review-v1 manifest; preserve raw attempts.`;
  }
  if (!db.prepare("SELECT 1 FROM batches WHERE id = ?").get(id)) throw new ApiError(404, "BATCH_NOT_FOUND", "Unknown batch");
  return `Review batch ${id} using lab:export. Run: npm run lab:export -- batch ${id}. Use content/review-guidelines.md. Return a content-review-v1 manifest; do not modify raw attempts.`;
}

const PACK_STEPS = [
  "Pack procedure (content/packs/<name>/index.mjs exports pack = { name, author, items, blueprints }; write items with buildBlock from content/first10/lib.mjs, format as in content/first10/L01.mjs and L03.mjs (reading)):",
  "  a. npm run pack -- check <name>  - repeat until it reports 0 invalid (it also rejects any sentence already in the bank).",
  "  b. Independent review: a DIFFERENT reviewer than the author (a subagent or another model) reads EVERY item in the review sheet that check printed and fills the review template: approved / flagged / rejected with a reason. Check: the key is right; no distractor is also correct; No mistake sentences are really correct and natural en-AU; every accepted answer is right and natural answers are not missing; Russian hints do not give the answer away.",
  "  c. npm stop, then npm run pack -- publish <name> --review <filled template>, then npm start. Only approved items are released; nothing is approved automatically.",
].join("\n");

const COMMON = [
  "Read content/review-guidelines.md and follow any local project instructions. Work on your own and run every command yourself; do not ask me to run anything. Never edit the SQLite database or raw attempts directly; use only the commands below. Do not commit or push.",
  "If you change code, run npm run typecheck and the tests of the area you changed before you finish.",
].join("\n");

/** Copy-and-paste tasks for the learner's coding agent: complete instructions with IDs and allowlisted commands only, never learner data (D62). */
function workflowTask(db: Db, kind: "progress" | "lessons"): string {
  const sessions = (db.prepare("SELECT id FROM sessions WHERE status IN ('completed','ended_early') ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: string }>).map((r) => r.id);
  const lessons = (db.prepare("SELECT COUNT(*) AS n FROM blueprints").get() as { n: number }).n;
  const list = sessions.length ? sessions.join(" ") : "(none yet)";
  if (kind === "progress") {
    return [
      "English Lab: review my recent practice and check that the app judged it correctly.",
      COMMON,
      `Recent sessions, newest first: ${list}`,
      "1. For each session run: npm run lab:export -- session <id> (read-only; it prints where the files are). Also run: npm run lab:export -- findings --status tentative --limit 100 and npm run lab:export -- coverage.",
      "2. For every exercise shown: is the key right, is any distractor also correct, are the hint and the Russian explanation right, and was each of my answers graded correctly? Judge my pending written answers yourself.",
      "3. If an exercise is wrong, fix it with a content pack named fix-<yyyymmdd>: the same exercise id with revision + 1 (the old revision is retired automatically on publish). If the grading code is wrong, fix the code and its tests.",
      PACK_STEPS,
      "4. Reply in Russian, briefly: what I do well, my weakest skills (with the number of attempts behind each), mistakes that repeat, grading or content errors found and what you fixed, and what I should practise next.",
    ].join("\n");
  }
  return [
    "English Lab: create the next lessons for me.",
    COMMON,
    `Published lessons now: ${lessons}. Recent sessions, newest first: ${list}`,
    "1. Find what I need: npm run lab:export -- coverage, npm run lab:export -- findings --status tentative --limit 100, and npm run lab:export -- session <id> for the recent sessions. Prefer my weak and recurring skills; keep about 35% new skills.",
    "2. Write a pack content/packs/lessons-<yyyymmdd>/ with 3-5 lessons. Per lesson: 5 skills from the taxonomy (content/taxonomy/taxonomy-v1.json), at least 24 exercises (6 choose_form, 6 choose_missing_fragment, 6 detect_error of which at least 2 are No mistake, 3 guided_short_answer, 3 russian_to_english_short; optionally 2 reading passages with readingBlocks 1), only skills from the lesson pool. Adult, abstract everyday/work/public topics, about 15% AI/IT, Australian English, A2-B2 grammar in B2 context, Russian hints and explanations. New sentences only. Blueprint key pack-<name>-lNN, policy blueprint-policy-v1 like content/first10/index.mjs, title continuing the numbering.",
    PACK_STEPS,
    "3. Reply in Russian, briefly: which skills the new lessons target and why, how many exercises were approved / flagged / rejected, and how many ready sessions each new lesson has.",
  ].join("\n");
}
