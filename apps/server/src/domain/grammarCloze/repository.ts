import type { ClozeAnswerResult, ClozeOverview, ClozeSessionPlan, ClozeSessionView, ClozeSlotState, ClozeSlotView, ClozeStageView, ClozeSummary } from "@english-lab/contracts";
import { clozeTaskCount } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { loadSettings } from "../sessions/policy.js";
import { awardModeXp, XP_CLOZE_ANSWER } from "../sessions/modeXp.js";
import { displayName } from "../skills/cards.js";
import { auditOf, checkedOkSql, hiddenSql } from "./audit.js";
import { familyName, familyOf, orderOptions, planThemedSession, SELECT_VERSION_V2, type ThemedCandidate } from "./select.js";

/** the exercises this mode plays; another source would be a separate setting, never mixed in */
export const ACTIVE_SOURCE = "zanichelli";
export interface Deps {
  now: () => Date;
  newId: () => string;
}

export const ruleKeyOf = (skillId: string | null, topic: string): string => skillId ?? `topic:${topic}`;
export function ruleName(ruleKey: string): string {
  return ruleKey.startsWith("topic:") ? "General Grammar" : displayName(ruleKey);
}
const lc = (s: string): string => s.toLowerCase();

// ---------------------------------------------------------------------------------------------------------------- stage progress

interface PoolRow {
  itemId: string;
  ruleKey: string;
  status: string;
  ans: number | null;
  excl: number | null;
  hidden: number;
}

/**
 * Progress of a stage, derived (never stored; D144/D145). Pool of stage 1 = validated exercises; pool of stage s>1 = exercises answered wrongly in
 * stage s-1. `total` leaves out exercises the learner excluded before answering them in this stage, so processed <= total always.
 */
export function stageView(db: Db, stage: number): ClozeStageView {
  const rows = db
    .prepare(
      `SELECT i.id AS itemId, COALESCE(r.skill_id, 'topic:' || r.source_topic) AS ruleKey, i.status AS status,
              (SELECT a.is_correct FROM grammar_cloze_attempts a WHERE a.item_id = i.id AND a.stage = @s) AS ans,
              (SELECT 1 FROM grammar_cloze_exclusions e WHERE e.item_id = i.id) AS excl, ${hiddenSql("i")} AS hidden
         FROM grammar_cloze_items i JOIN grammar_cloze_revisions r ON r.id = i.current_revision_id
        WHERE i.source_id = @src AND (@s = 1 OR EXISTS (SELECT 1 FROM grammar_cloze_attempts p WHERE p.item_id = i.id AND p.stage = @s - 1 AND p.is_correct = 0))`,
    )
    .all({ s: stage, src: ACTIVE_SOURCE }) as PoolRow[];
  // a sentence hidden by the background check (or by hand) leaves the pool of every stage, answered or not (its answer stays in the history)
  const playable = (r: PoolRow): boolean => r.status === "validated" && r.hidden !== 1;
  const inPool = rows.filter((r) => playable(r) || (r.ans !== null && r.status !== "validated"));
  const counted = inPool.filter((r) => !(r.excl && r.ans === null));
  const processed = counted.filter((r) => r.ans !== null).length;
  const present = new Set(counted.map((r) => r.ruleKey));
  const touched = new Set(counted.filter((r) => r.ans !== null).map((r) => r.ruleKey));
  const open = new Set(counted.filter((r) => r.ans === null).map((r) => r.ruleKey));
  const completed = [...touched].filter((k) => !open.has(k)).length;
  const hiddenByCheck = rows.filter((r) => r.status === "validated" && r.hidden === 1 && !(r.excl && r.ans === null)).length;
  const carriedToNext = counted.filter((r) => r.ans === 0 && !r.excl && playable(r)).length;
  const excluded = inPool.filter((r) => r.excl).length;
  const total = counted.length;
  const percent = total === 0 ? "0.00" : ((processed / total) * 100).toFixed(2);
  const status: ClozeStageView["status"] = stage > 1 && total === 0 ? "locked" : total > 0 && processed >= total ? "done" : processed > 0 ? "in_progress" : "not_started";
  return {
    stage,
    title: stage === 1 ? "Stage 1 · Every sentence once" : `Stage ${stage} · Mistakes from stage ${stage - 1}`,
    status: stage === 1 ? status : "locked",
    total,
    processed,
    percent,
    rulesPresent: present.size,
    rulesTouched: touched.size,
    rulesCompleted: completed,
    hiddenByCheck,
    excluded,
    carriedToNext,
    // TASK_032 plays stage 1 only; later stages show their pool but stay closed
    ready: stage === 1 && total > processed,
  };
}

export function overview(db: Db): ClozeOverview {
  const has = db.prepare("SELECT 1 FROM grammar_cloze_items WHERE source_id = ? LIMIT 1").get(ACTIVE_SOURCE);
  const active = db.prepare("SELECT id, level_no AS levelNo, planned_count AS planned FROM grammar_cloze_sessions WHERE status = 'active'").get() as { id: string; levelNo: number; planned: number } | undefined;
  const answered = active ? (db.prepare("SELECT COUNT(*) AS n FROM grammar_cloze_attempts WHERE session_id = ?").get(active.id) as { n: number }).n : 0;
  const next = ((db.prepare("SELECT MAX(level_no) AS m FROM grammar_cloze_sessions").get() as { m: number | null }).m ?? 0) + 1;
  return {
    available: Boolean(has),
    stages: has ? [stageView(db, 1), stageView(db, 2)] : [],
    activeSession: active ? { ...active, answered } : null,
    nextLevelNo: next,
    taskCount: clozeTaskCount(loadSettings(db).values),
  };
}

// ---------------------------------------------------------------------------------------------------------------- sessions

/** Starts the next session or returns the open one (a reload or another tab takes it over). Stage 1 only in TASK_032. */
export function startSession(db: Db, deps: Deps, tabId: string): { sessionId: string; resumed: boolean } {
  return db
    .transaction((): { sessionId: string; resumed: boolean } => {
      const open = db.prepare("SELECT id FROM grammar_cloze_sessions WHERE status = 'active'").get() as { id: string } | undefined;
      if (open) {
        db.prepare("UPDATE grammar_cloze_sessions SET tab_id = ? WHERE id = ?").run(tabId, open.id);
        return { sessionId: open.id, resumed: true };
      }
      const stage = 1;
      const settings = loadSettings(db);
      const rows = db
        .prepare(
          `SELECT i.id AS itemId, COALESCE(r.skill_id, 'topic:' || r.source_topic) AS ruleKey, r.source_topic AS topic, ${checkedOkSql("i")} AS checked
             FROM grammar_cloze_items i JOIN grammar_cloze_revisions r ON r.id = i.current_revision_id
            WHERE i.source_id = ? AND i.status = 'validated'
              AND NOT EXISTS (SELECT 1 FROM grammar_cloze_attempts a WHERE a.item_id = i.id AND a.stage = ?)
              AND NOT EXISTS (SELECT 1 FROM grammar_cloze_exclusions e WHERE e.item_id = i.id)
              AND NOT EXISTS (SELECT 1 FROM grammar_cloze_session_items s WHERE s.item_id = i.id AND s.stage = ?)
              AND NOT ${hiddenSql("i")}`,
        )
        .all(ACTIVE_SOURCE, stage, stage)
        .map((r) => {
          const x = r as { itemId: string; ruleKey: string; topic: string; checked: number };
          return { itemId: x.itemId, ruleKey: x.ruleKey, family: familyOf(x.topic), checked: x.checked === 1 } satisfies ThemedCandidate;
        });
      if (rows.length === 0) throw new ApiError(409, "STAGE_DONE", "Stage 1 has no sentences left to answer");
      const history = new Map<string, number>();
      for (const h of db.prepare("SELECT rule_key AS k, COUNT(*) AS n FROM grammar_cloze_session_items WHERE stage = ? GROUP BY rule_key").all(stage) as Array<{ k: string; n: number }>) history.set(h.k, h.n);
      const recentFocus = (db.prepare("SELECT json_extract(plan_json, '$.focus') AS f FROM grammar_cloze_sessions WHERE plan_json IS NOT NULL ORDER BY level_no DESC LIMIT 12").all() as Array<{ f: string }>).map((r) => r.f);
      const mistakes = new Map<string, number>();
      for (const m of db
        .prepare(
          `SELECT a.rule_key AS k, COUNT(*) AS n FROM grammar_cloze_attempts a
            WHERE a.is_correct = 0 AND a.session_id IN (SELECT id FROM grammar_cloze_sessions WHERE status = 'completed' ORDER BY level_no DESC LIMIT 5)
            GROUP BY a.rule_key`,
        )
        .all() as Array<{ k: string; n: number }>)
        mistakes.set(m.k, m.n);
      const seed = Math.floor(Math.random() * 2 ** 31);
      const themed = planThemedSession({ available: rows, history, recentFocus, mistakes, size: clozeTaskCount(settings.values), seed });
      const plan = themed.items;
      const texts = plan.map((p) => db.prepare("SELECT i.current_revision_id AS rev, r.solution, r.distractors_json AS d FROM grammar_cloze_items i JOIN grammar_cloze_revisions r ON r.id = i.current_revision_id WHERE i.id = ?").get(p.itemId) as { rev: string; solution: string; d: string });
      const options = orderOptions(texts.map((t) => ({ solution: t.solution, distractors: JSON.parse(t.d) as string[] })), seed);
      const level = ((db.prepare("SELECT MAX(level_no) AS m FROM grammar_cloze_sessions").get() as { m: number | null }).m ?? 0) + 1;
      const id = deps.newId();
      db.prepare("INSERT INTO grammar_cloze_sessions(id, level_no, stage, planned_count, status, algorithm_version, seed, settings_revision, tab_id, started_at, plan_json) VALUES (?,?,?,?,'active',?,?,?,?,?,?)").run(id, level, stage, plan.length, SELECT_VERSION_V2, seed, settings.revision, tabId, deps.now().toISOString(), JSON.stringify(themed.plan));
      const ins = db.prepare("INSERT INTO grammar_cloze_session_items(session_id, position, item_id, revision_id, stage, rule_key, options_json) VALUES (?,?,?,?,?,?,?)");
      plan.forEach((p, i) => ins.run(id, i + 1, p.itemId, texts[i]!.rev, stage, p.ruleKey, JSON.stringify(options[i])));
      return { sessionId: id, resumed: false };
    })
    .immediate();
}

interface SlotRow {
  position: number;
  itemId: string;
  rev: string;
  hint: number | null;
  hidden: number;
  options: string;
  ruleKey: string;
  gapped: string;
  solution: string;
  topic: string;
  skillId: string | null;
  chosen: string | null;
  isCorrect: number | null;
  excl: number | null;
  status: string;
}

function slotRows(db: Db, sessionId: string): SlotRow[] {
  return db
    .prepare(
      `SELECT s.position, s.item_id AS itemId, s.revision_id AS rev, a.hint_level AS hint, (SELECT ${hiddenSql("i")} FROM grammar_cloze_items i WHERE i.id = s.item_id) AS hidden, s.options_json AS options, s.rule_key AS ruleKey, r.gapped_text AS gapped, r.solution, r.source_topic AS topic, r.skill_id AS skillId,
              a.chosen_text AS chosen, a.is_correct AS isCorrect, (SELECT 1 FROM grammar_cloze_exclusions e WHERE e.item_id = s.item_id) AS excl, (SELECT i.status FROM grammar_cloze_items i WHERE i.id = s.item_id) AS status
         FROM grammar_cloze_session_items s JOIN grammar_cloze_revisions r ON r.id = s.revision_id
         LEFT JOIN grammar_cloze_attempts a ON a.session_id = s.session_id AND a.position = s.position
        WHERE s.session_id = ? ORDER BY s.position`,
    )
    .all(sessionId) as SlotRow[];
}

const stateOf = (r: SlotRow): ClozeSlotState => (r.isCorrect !== null ? (r.isCorrect ? "correct" : "incorrect") : r.excl ? "excluded" : "pending");

export function sessionView(db: Db, sessionId: string): ClozeSessionView {
  const row = db.prepare("SELECT id, level_no AS levelNo, stage, status, planned_count AS planned, plan_json AS planJson FROM grammar_cloze_sessions WHERE id = ?").get(sessionId) as { id: string; levelNo: number; stage: number; status: "active" | "completed"; planned: number; planJson: string | null } | undefined;
  if (!row) throw new ApiError(404, "CLOZE_SESSION_NOT_FOUND", "Unknown Grammar Cloze session");
  const { planJson, ...s } = row;
  const p = planJson ? (JSON.parse(planJson) as { focus: string; review: string[] }) : null;
  const plan: ClozeSessionPlan | null = p ? { focus: p.focus, focusName: familyName(p.focus), review: [...new Set(p.review.map(ruleName))] } : null;
  const slots: ClozeSlotView[] = slotRows(db, sessionId).map((r) => {
    const state = stateOf(r);
    const slot: ClozeSlotView = { position: r.position, itemId: r.itemId, gappedText: r.gapped, options: JSON.parse(r.options) as string[], ruleName: ruleName(r.ruleKey), exact: !r.ruleKey.startsWith("topic:"), sourceTopic: r.topic, state, excluded: Boolean(r.excl) };
    if (state !== "pending") { slot.correct = r.solution; if (r.chosen !== null) slot.chosen = r.chosen; if (r.hint !== null) slot.hintLevel = r.hint; }
    // the background check: signal words and names help before the answer; its reason would give the answer away, so it waits
    const audit = auditOf(db, r.rev);
    if (audit) {
      slot.cues = audit.cues;
      slot.names = audit.names;
      if (state !== "pending") slot.reasonRu = audit.reason_ru;
    }
    return slot;
  });
  const next = slots.find((x) => x.state === "pending");
  return { ...s, plan, answered: slots.filter((x) => x.state === "correct" || x.state === "incorrect").length, excluded: slots.filter((x) => x.state === "excluded").length, slots, nextPosition: next?.position ?? null };
}

/** the first time a sentence is on screen; a reload never changes it (a showing is not an answer) */
export function markShown(db: Db, deps: Deps, sessionId: string, position: number): void {
  db.prepare("UPDATE grammar_cloze_session_items SET first_shown_at = ? WHERE session_id = ? AND position = ? AND first_shown_at IS NULL").run(deps.now().toISOString(), sessionId, position);
}

// ---------------------------------------------------------------------------------------------------------------- answers

export interface AnswerBody {
  id: string;
  position: number;
  chosen: string;
  responseMs?: number | undefined;
  /** help shown before the answer: 0 none, 1 signal words, 2 the rule name */
  hintLevel?: number | undefined;
}

export function submitAnswer(db: Db, deps: Deps, sessionId: string, b: AnswerBody): ClozeAnswerResult {
  return db
    .transaction((): ClozeAnswerResult => {
      const session = db.prepare("SELECT status FROM grammar_cloze_sessions WHERE id = ?").get(sessionId) as { status: string } | undefined;
      if (!session) throw new ApiError(404, "CLOZE_SESSION_NOT_FOUND", "Unknown Grammar Cloze session");
      const prior = db.prepare("SELECT session_id AS sessionId, position, chosen_text AS chosen, correct_text AS correct, is_correct AS ok FROM grammar_cloze_attempts WHERE id = ?").get(b.id) as { sessionId: string; position: number; chosen: string; correct: string; ok: number } | undefined;
      if (prior) {
        if (prior.sessionId !== sessionId || prior.position !== b.position || prior.chosen !== b.chosen) throw new ApiError(409, "ATTEMPT_ID_CONFLICT", "Answer id already used");
        return { correct: prior.ok === 1, correctText: prior.correct, chosenText: prior.chosen };
      }
      const slot = db.prepare("SELECT s.item_id AS itemId, s.revision_id AS rev, s.stage, s.rule_key AS ruleKey, s.options_json AS options, r.solution, r.skill_id AS skillId, r.source_topic AS topic FROM grammar_cloze_session_items s JOIN grammar_cloze_revisions r ON r.id = s.revision_id WHERE s.session_id = ? AND s.position = ?").get(sessionId, b.position) as { itemId: string; rev: string; stage: number; ruleKey: string; options: string; solution: string; skillId: string | null; topic: string } | undefined;
      if (!slot) throw new ApiError(404, "CLOZE_POSITION_NOT_FOUND", "Unknown position");
      const done = db.prepare("SELECT chosen_text AS chosen, correct_text AS correct, is_correct AS ok FROM grammar_cloze_attempts WHERE session_id = ? AND position = ?").get(sessionId, b.position) as { chosen: string; correct: string; ok: number } | undefined;
      if (done) throw new ApiError(409, "ALREADY_ANSWERED", "This sentence was already answered", { correct: done.ok === 1, correctText: done.correct, chosenText: done.chosen });
      if (session.status !== "active") throw new ApiError(409, "CLOZE_SESSION_CLOSED", "This session is finished");
      if (db.prepare("SELECT 1 FROM grammar_cloze_exclusions WHERE item_id = ?").get(slot.itemId)) throw new ApiError(409, "ITEM_EXCLUDED", "This sentence was excluded");
      if (!(JSON.parse(slot.options) as string[]).includes(b.chosen)) throw new ApiError(400, "BAD_OPTION", "That is not one of the options");
      const correct = lc(b.chosen) === lc(slot.solution);
      const ms = b.responseMs === undefined ? null : Math.max(0, Math.min(3600000, Math.round(b.responseMs)));
      const hint = Math.max(0, Math.min(2, Math.round(b.hintLevel ?? 0)));
      db.prepare("INSERT INTO grammar_cloze_attempts(id, session_id, position, item_id, revision_id, stage, chosen_text, correct_text, is_correct, skill_id, rule_key, source_topic, response_ms, answered_at, hint_level) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(b.id, sessionId, b.position, slot.itemId, slot.rev, slot.stage, b.chosen, slot.solution, correct ? 1 : 0, slot.skillId, slot.ruleKey, slot.topic, ms, deps.now().toISOString(), hint);
      // a hinted correct answer stays correct (it does not move to the next stage) but earns half the XP
      if (correct) awardModeXp(db, { id: deps.newId(), source: "grammarCloze", sourceId: b.id, amount: hint > 0 ? XP_CLOZE_ANSWER / 2 : XP_CLOZE_ANSWER, at: deps.now().toISOString() });
      return { correct, correctText: slot.solution, chosenText: b.chosen };
    })
    .immediate();
}

/** Removes a sentence from every future session and stage. Not an answer: it counts as neither right nor wrong. */
export function excludeItem(db: Db, deps: Deps, itemId: string, o: { sessionId?: string | undefined; reason?: string | undefined }): { excluded: true } {
  return db
    .transaction((): { excluded: true } => {
      if (db.prepare("SELECT 1 FROM grammar_cloze_exclusions WHERE item_id = ?").get(itemId)) return { excluded: true };
      const item = db.prepare("SELECT current_revision_id AS rev FROM grammar_cloze_items WHERE id = ?").get(itemId) as { rev: string } | undefined;
      if (!item) throw new ApiError(404, "CLOZE_ITEM_NOT_FOUND", "Unknown sentence");
      let sessionId: string | null = null;
      let stage = 1;
      let rev = item.rev;
      if (o.sessionId) {
        const slot = db.prepare("SELECT stage, revision_id AS rev FROM grammar_cloze_session_items WHERE session_id = ? AND item_id = ?").get(o.sessionId, itemId) as { stage: number; rev: string } | undefined;
        if (!slot) throw new ApiError(404, "CLOZE_POSITION_NOT_FOUND", "That sentence is not in this session");
        sessionId = o.sessionId;
        stage = slot.stage;
        rev = slot.rev;
      }
      const answered = db.prepare("SELECT 1 FROM grammar_cloze_attempts WHERE item_id = ? AND stage = ?").get(itemId, stage) ? 1 : 0;
      const reason = o.reason?.trim() ? o.reason.trim().slice(0, 500) : null;
      db.prepare("INSERT INTO grammar_cloze_exclusions(item_id, revision_id, session_id, stage, answered_before, reason, created_at) VALUES (?,?,?,?,?,?,?)").run(itemId, rev, sessionId, stage, answered, reason, deps.now().toISOString());
      return { excluded: true };
    })
    .immediate();
}

// ---------------------------------------------------------------------------------------------------------------- finish

export function activeMsOf(db: Db, sessionId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(end_ms - start_ms), 0) AS ms FROM grammar_cloze_activity_intervals WHERE session_id = ?").get(sessionId) as { ms: number }).ms;
}

export function summary(db: Db, sessionId: string): ClozeSummary {
  const s = db.prepare("SELECT level_no AS levelNo, stage FROM grammar_cloze_sessions WHERE id = ?").get(sessionId) as { levelNo: number; stage: number } | undefined;
  if (!s) throw new ApiError(404, "CLOZE_SESSION_NOT_FOUND", "Unknown Grammar Cloze session");
  const rows = slotRows(db, sessionId);
  const states = rows.map(stateOf);
  const correct = states.filter((x) => x === "correct").length;
  const incorrect = states.filter((x) => x === "incorrect").length;
  const by = new Map<string, { correct: number; incorrect: number }>();
  rows.forEach((r, i) => {
    if (states[i] !== "correct" && states[i] !== "incorrect") return;
    const e = by.get(r.ruleKey) ?? { correct: 0, incorrect: 0 };
    e[states[i] === "correct" ? "correct" : "incorrect"]++;
    by.set(r.ruleKey, e);
  });
  const byRule = [...by.entries()].map(([ruleKey, v]) => ({ ruleKey, name: ruleName(ruleKey), ...v })).sort((a, b) => b.incorrect - a.incorrect || b.correct + b.incorrect - (a.correct + a.incorrect));
  const carried = rows.filter((r, i) => states[i] === "incorrect" && !r.excl && r.status === "validated" && r.hidden !== 1).length;
  return { levelNo: s.levelNo, stage: s.stage, answered: correct + incorrect, correct, incorrect, excluded: rows.filter((r) => r.excl).length, accuracy: correct + incorrect === 0 ? null : correct / (correct + incorrect), activeMs: activeMsOf(db, sessionId), byRule, carriedToNext: carried, stageProgress: stageView(db, s.stage) };
}

/** Closes a session once every sentence is answered or excluded. Repeating the call changes nothing. */
export function completeSession(db: Db, deps: Deps, sessionId: string): ClozeSummary {
  db.transaction(() => {
    const s = db.prepare("SELECT status FROM grammar_cloze_sessions WHERE id = ?").get(sessionId) as { status: string } | undefined;
    if (!s) throw new ApiError(404, "CLOZE_SESSION_NOT_FOUND", "Unknown Grammar Cloze session");
    if (s.status === "completed") return;
    if (slotRows(db, sessionId).some((r) => stateOf(r) === "pending")) throw new ApiError(409, "CLOZE_SESSION_INCOMPLETE", "Answer or exclude every sentence first");
    db.prepare("UPDATE grammar_cloze_sessions SET status = 'completed', completed_at = ? WHERE id = ?").run(deps.now().toISOString(), sessionId);
  }).immediate();
  return summary(db, sessionId);
}
