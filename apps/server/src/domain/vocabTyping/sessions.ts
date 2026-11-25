import { createHash } from "node:crypto";
import type { VtSessionMetrics, VtStage, VtSummary, VtTyping } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { learningDate } from "../journey/calendar.js";
import { overlapsRecordedActivity } from "../journey/intervals.js";
import { awardModeXp, XP_VOCAB_TYPING_SCREEN } from "../sessions/modeXp.js";
import { archiveWord } from "./bankEdit.js";
import type { Deps } from "./data.js";
import { buildScreeningPlan, SCREENING_VERSION, type ScreeningPlan } from "./screening.js";

export const METRICS_VERSION = "vt-typing-v1";

export interface SessionRow {
  id: string;
  stage: VtStage;
  status: "active" | "completed" | "abandoned";
  plan: unknown;
  tabId: string;
  startedAt: string;
  endedAt: string | null;
  settings: Record<string, number | boolean>;
  metrics: VtSessionMetrics | null;
}

export function loadSession(db: Db, id: string): SessionRow {
  const r = db
    .prepare("SELECT id, stage, status, plan_json AS p, tab_id AS tabId, started_at AS startedAt, ended_at AS endedAt, settings_json AS s, active_ms AS activeMs, chars_typed AS chars, errors, wpm, accuracy, metrics_version AS mv FROM vocab_typing_sessions WHERE id = ?")
    .get(id) as { id: string; stage: VtStage; status: SessionRow["status"]; p: string; tabId: string; startedAt: string; endedAt: string | null; s: string; activeMs: number | null; chars: number | null; errors: number | null; wpm: number | null; accuracy: number | null; mv: string | null } | undefined;
  if (!r) throw new ApiError(404, "VOCAB_SESSION_NOT_FOUND", "Unknown Vocabulary Typing session");
  const metrics = r.mv ? { activeMs: r.activeMs ?? 0, charsTyped: r.chars ?? 0, errors: r.errors ?? 0, wpm: r.wpm ?? 0, accuracy: r.accuracy, metricsVersion: r.mv } : null;
  return { id: r.id, stage: r.stage, status: r.status, plan: JSON.parse(r.p), tabId: r.tabId, startedAt: r.startedAt, endedAt: r.endedAt, settings: JSON.parse(r.s), metrics };
}

export const activeSessionId = (db: Db, stage: VtStage): string | null => (db.prepare("SELECT id FROM vocab_typing_sessions WHERE stage = ? AND status = 'active' LIMIT 1").get(stage) as { id: string } | undefined)?.id ?? null;

const seedOf = (id: string): number => parseInt(createHash("sha256").update(id).digest("hex").slice(0, 7), 16);

export function requireActive(db: Db, sessionId: string, tabId: string): SessionRow {
  const s = loadSession(db, sessionId);
  if (s.status !== "active") throw new ApiError(409, "VOCAB_SESSION_NOT_ACTIVE", "This session is finished");
  if (s.tabId !== tabId) throw new ApiError(409, "LEASE_REQUIRED", "This session is open in another tab");
  return s;
}

/** typing facts of a decision, as stored with the event */
export const typingJson = (t: VtTyping): string => JSON.stringify({ activeMs: t.activeMs, chars: t.chars, errors: t.errors });

export function summaryOf(db: Db, sessionId: string): VtSummary {
  const count = (kind: string): number => (db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_events WHERE session_id = ? AND kind = ?").get(sessionId, kind) as { n: number }).n;
  const review = (sql: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM vocab_typing_reviews WHERE session_id = ? AND ${sql}`).get(sessionId) as { n: number }).n;
  const known = count("screen_known");
  const unknown = count("screen_unknown");
  const learned = count("learn_learned");
  // words met but not (yet) marked learned in this session, plus words whose check failed
  const stillLearning = (db.prepare("SELECT COUNT(DISTINCT lemma) AS n FROM (SELECT lemma FROM vocab_typing_events WHERE session_id = ? AND kind = 'learn_exposure' UNION SELECT lemma FROM vocab_typing_reviews WHERE session_id = ? AND rating = 'again') WHERE lemma NOT IN (SELECT lemma FROM vocab_typing_events WHERE session_id = ? AND kind = 'learn_learned')").get(sessionId, sessionId, sessionId) as { n: number }).n;
  const checks = review("1 = 1");
  return {
    screened: known + unknown,
    known,
    unknown,
    notUseful: count("screen_not_useful") + count("screen_archived"),
    cards: learned + stillLearning + checks,
    learned,
    stillLearning,
    checksPassed: review("rating = 'good'"),
    checksFailed: review("rating = 'again'"),
    checksSkipped: review("rating IS NULL"),
  };
}

/** the open session of the stage continues (this tab takes it over); a fully answered one is closed first */
export function startScreening(db: Db, deps: Deps, tabId: string): { sessionId: string; resumed: boolean } {
  return db
    .transaction(() => {
      const open = activeSessionId(db, "screening");
      if (open) {
        const answered = (db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_events WHERE session_id = ? AND stage = 'screening'").get(open) as { n: number }).n;
        if (answered < (loadSession(db, open).plan as ScreeningPlan).words.length) {
          db.prepare("UPDATE vocab_typing_sessions SET tab_id = ? WHERE id = ?").run(tabId, open);
          return { sessionId: open, resumed: true };
        }
        finish(db, deps, open, "completed");
      }
      const prepared = (db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_lexicon").get() as { n: number }).n;
      if (prepared === 0) throw new ApiError(409, "VOCAB_NOT_PREPARED", "The word ranks are missing. Run npm run vtyping:prepare once.");
      const id = deps.newId();
      const seed = seedOf(id);
      const built = buildScreeningPlan(db, seed);
      if (!built) throw new ApiError(409, "NOTHING_TO_SCREEN", "Every word of the dictionary is already screened.");
      db.prepare("INSERT INTO vocab_typing_sessions(id, stage, status, plan_json, seed, algorithm_version, settings_json, tab_id, started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "screening", "active", JSON.stringify(built.plan), seed, SCREENING_VERSION, JSON.stringify(built.settings), tabId, deps.now().toISOString());
      return { sessionId: id, resumed: false };
    })
    .immediate();
}

export interface ScreeningInput {
  clientEventId: string;
  tabId: string;
  lemma: string;
  kind: "screen_known" | "screen_unknown" | "screen_archived";
  typing: VtTyping;
}

/** one screening decision (append-only, idempotent by client id); the XP row is written in the same transaction (D172) */
export function recordScreening(db: Db, deps: Deps, sessionId: string, b: ScreeningInput): void {
  db.transaction(() => {
    const prev = db.prepare("SELECT session_id AS s, lemma, kind FROM vocab_typing_events WHERE client_event_id = ?").get(b.clientEventId) as { s: string; lemma: string; kind: string } | undefined;
    if (prev) {
      if (prev.s !== sessionId || prev.lemma !== b.lemma || prev.kind !== b.kind) throw new ApiError(409, "EVENT_ID_CONFLICT", "This event id was already used for another answer");
      return;
    }
    const s = requireActive(db, sessionId, b.tabId);
    if (s.stage !== "screening") throw new ApiError(409, "WRONG_STAGE", "This is not a screening session");
    const entry = (s.plan as ScreeningPlan).words.find((w) => w.lemma === b.lemma);
    if (!entry) throw new ApiError(409, "WORD_NOT_IN_PLAN", "This word is not part of the session");
    if (db.prepare("SELECT 1 FROM vocab_typing_events WHERE session_id = ? AND lemma = ? AND stage = 'screening'").get(sessionId, b.lemma)) throw new ApiError(409, "ALREADY_ANSWERED", "This word was already answered in this session");
    const now = deps.now();
    const id = deps.newId();
    db.prepare("INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, sentence_id, is_probe, card_index, typing_json, local_date, created_at) VALUES (?,?,?,?,'screening',?,NULL,?,NULL,?,?,?)").run(id, b.clientEventId, sessionId, b.lemma, b.kind, entry.probe ? 1 : 0, typingJson(b.typing), learningDate(now.getTime()), now.toISOString());
    if (b.kind === "screen_archived") {
      // D184: the word is archived (kept, but never practised again); Restore or Undo clears the flag
      archiveWord(db, b.lemma, "learner", "archived by the learner", now.toISOString());
    } else awardModeXp(db, { id: deps.newId(), source: "vocabTyping", sourceId: id, amount: XP_VOCAB_TYPING_SCREEN, at: now.toISOString() });
  }).immediate();
}

export function finish(db: Db, deps: Deps, sessionId: string, status: "completed" | "abandoned", keyStats?: unknown): void {
  const agg = db.prepare("SELECT COALESCE(SUM(json_extract(typing_json,'$.activeMs')),0) AS ms, COALESCE(SUM(json_extract(typing_json,'$.chars')),0) AS chars, COALESCE(SUM(json_extract(typing_json,'$.errors')),0) AS errors FROM vocab_typing_events WHERE session_id = ?").get(sessionId) as { ms: number; chars: number; errors: number };
  const minutes = agg.ms / 60000;
  const wpm = minutes > 0 ? Math.round((agg.chars / 5 / minutes) * 10) / 10 : 0;
  const accuracy = agg.chars + agg.errors > 0 ? Math.round((agg.chars / (agg.chars + agg.errors)) * 1000) / 10 : null;
  db.prepare("UPDATE vocab_typing_sessions SET status = ?, ended_at = ?, active_ms = ?, chars_typed = ?, errors = ?, wpm = ?, accuracy = ?, metrics_version = ?, key_stats_json = ? WHERE id = ?").run(status, deps.now().toISOString(), agg.ms, agg.chars, agg.errors, wpm, accuracy, METRICS_VERSION, keyStats ? JSON.stringify(keyStats) : null, sessionId);
}

/** closes the session and stores its typing metrics (summed from the decisions); closing a finished session changes nothing */
export function completeSession(db: Db, deps: Deps, sessionId: string, tabId: string, keyStats?: unknown): void {
  db.transaction(() => {
    const s = loadSession(db, sessionId);
    if (s.status !== "active") return;
    if (s.tabId !== tabId) throw new ApiError(409, "LEASE_REQUIRED", "This session is open in another tab");
    finish(db, deps, sessionId, "completed", keyStats);
  }).immediate();
}

export interface Interval {
  id: string;
  tabId: string;
  startMs: number;
  endMs: number;
}

/** visible time of a session: short intervals, written once, never overlapping any recorded activity (D171) */
export function recordActivity(db: Db, deps: Deps, sessionId: string, b: Interval): { recorded: boolean } {
  return db
    .transaction(() => {
      const prev = db.prepare("SELECT session_id AS s, tab_id AS t, start_ms AS a, end_ms AS e FROM vocab_typing_activity_intervals WHERE id = ?").get(b.id) as { s: string; t: string; a: number; e: number } | undefined;
      if (prev) {
        if (prev.s !== sessionId || prev.t !== b.tabId || prev.a !== b.startMs || prev.e !== b.endMs) throw new ApiError(409, "ACTIVITY_ID_CONFLICT", "Activity interval id already used");
        return { recorded: false };
      }
      const s = loadSession(db, sessionId);
      const now = deps.now().getTime();
      if (b.endMs <= b.startMs || b.endMs - b.startMs > 15000 || b.startMs < Date.parse(s.startedAt) || b.endMs > now + 2000 || (s.endedAt && b.endMs > Date.parse(s.endedAt) + 2000)) throw new ApiError(400, "ACTIVITY_INVALID", "Invalid activity interval");
      if (s.status === "active" && s.tabId !== b.tabId) throw new ApiError(409, "LEASE_REQUIRED", "This session is open in another tab");
      if (overlapsRecordedActivity(db, b.startMs, b.endMs)) throw new ApiError(409, "ACTIVITY_OVERLAP", "Activity interval overlaps a recorded interval");
      db.prepare("INSERT INTO vocab_typing_activity_intervals(id, session_id, tab_id, start_ms, end_ms, recorded_at) VALUES (?,?,?,?,?,?)").run(b.id, sessionId, b.tabId, b.startMs, b.endMs, deps.now().toISOString());
      return { recorded: true };
    })
    .immediate();
}
