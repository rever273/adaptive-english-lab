import { randomUUID } from "node:crypto";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { enqueue } from "../../queue/jobs.js";
import { awardModeXp, XP_CONVERSATION_ANSWER } from "../sessions/modeXp.js";
import { insertTargets, lessonFinished, lessonTargets, planLesson, startNextTarget } from "./lessons.js";

export interface ConversationDeps { now: () => Date; newId: () => string }

function session(db: Db, id: string): { id: string; status: string; tab_id: string | null; heartbeat_at: string | null; history_deleted: number } {
  const row = db.prepare("SELECT id, status, tab_id, heartbeat_at, history_deleted FROM conversation_sessions WHERE id=?").get(id) as ReturnType<typeof session> | undefined;
  if (!row || row.history_deleted) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
  return row;
}

function owns(db: Db, id: string, tab: string): void {
  const s = session(db, id);
  if (s.status !== "active" || s.tab_id !== tab) throw new ApiError(409, "CONVERSATION_PAUSED", "Resume the conversation in this tab first.");
}

/** Only account for a short, observed heartbeat interval; a browser crash cannot count hours of absence. */
function accrue(db: Db, id: string, now: string): void {
  const s = session(db, id);
  const elapsed = s.status === "active" && s.heartbeat_at ? Math.max(0, Math.min(15000, Date.parse(now) - Date.parse(s.heartbeat_at))) : 0;
  if (elapsed) {
    const end = Date.parse(now), start = end - elapsed;
    const overlaps = db.prepare(`SELECT start_ms AS startMs,end_ms AS endMs FROM practice_activity_intervals WHERE start_ms < ? AND end_ms > ? UNION ALL SELECT start_ms,end_ms FROM journey_typing_intervals WHERE start_ms < ? AND end_ms > ? UNION ALL SELECT start_ms,end_ms FROM word_lesson_activity_intervals WHERE start_ms < ? AND end_ms > ? UNION ALL SELECT start_ms,end_ms FROM conversation_activity_intervals WHERE start_ms < ? AND end_ms > ? UNION ALL SELECT start_ms,end_ms FROM grammar_cloze_activity_intervals WHERE start_ms < ? AND end_ms > ? ORDER BY startMs`).all(end,start,end,start,end,start,end,start,end,start) as Array<{startMs:number;endMs:number}>;
    let cursor = start;
    const insert = db.prepare("INSERT INTO conversation_activity_intervals(session_id,start_ms,end_ms) VALUES (?,?,?)");
    for (const row of overlaps) { if (row.startMs > cursor) insert.run(id,cursor,Math.min(row.startMs,end)); cursor = Math.max(cursor,row.endMs); if (cursor >= end) break; }
    if (cursor < end) insert.run(id,cursor,end);
  }
  db.prepare("UPDATE conversation_sessions SET active_ms=active_ms+?, heartbeat_at=?, updated_at=? WHERE id=?").run(elapsed, now, now, id);
}

/** a lesson's switch reply still being written: it follows no learner message, so the last-role check cannot see it (other replies it can) */
function replyPending(db: Db, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM jobs WHERE idempotency_key LIKE ? AND state IN ('queued','waiting_for_gpu','running','paused') LIMIT 1").get(`conversation:${id}:topic:%`);
}

function pauseActive(db: Db, now: string): void {
  const active = db.prepare("SELECT id FROM conversation_sessions WHERE status='active' AND history_deleted=0").all() as Array<{ id: string }>;
  for (const row of active) accrue(db, row.id, now);
  db.prepare("UPDATE conversation_sessions SET status='paused', tab_id=NULL, heartbeat_at=NULL WHERE status='active'").run();
}

export function conversationState(db: Db, id: string) {
  session(db, id);
  const head = db.prepare("SELECT id, topic, mode, status, started_at AS startedAt, updated_at AS updatedAt, active_ms AS activeMs, answer_count AS answerCount FROM conversation_sessions WHERE id=?").get(id) as { mode: string };
  return {
    session: head,
    lesson: head.mode === "lesson" ? { targets: lessonTargets(db, id), finished: lessonFinished(db, id) } : null,
    messages: db.prepare("SELECT m.id, m.role, m.text, m.created_at AS createdAt, a.status AS analysisStatus, a.text AS analysis FROM conversation_messages m LEFT JOIN conversation_analyses a ON a.message_id=m.id WHERE m.session_id=? ORDER BY m.rowid").all(id),
    vocabulary: [
      ...(db.prepare("SELECT lemma,surface_forms_json AS forms FROM vocabulary_entries e WHERE (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id=e.id ORDER BY ev.created_at DESC,ev.rowid DESC LIMIT 1) IS NOT 'removed'").all() as Array<{ lemma: string; forms: string }>).flatMap(r => { try { const v: unknown = JSON.parse(r.forms); return [r.lemma, ...(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])]; } catch { return [r.lemma]; } }),
      ...(db.prepare("SELECT phrase FROM vocabulary_expressions e WHERE (SELECT kind FROM vocabulary_expression_events ev WHERE ev.expression_id=e.id ORDER BY ev.created_at DESC,ev.rowid DESC LIMIT 1) IS NOT 'removed'").all() as Array<{ phrase: string }>).map(x => x.phrase),
    ],
    jobs: db.prepare("SELECT id, state, error_code AS errorCode, json_extract(payload_json,'$.action') AS action, json_extract(payload_json,'$.messageId') AS messageId FROM jobs WHERE idempotency_key LIKE ? AND state IN ('queued','waiting_for_gpu','running','paused','failed') ORDER BY rowid DESC LIMIT 8").all(`conversation:${id}:%`),
  };
}

/** the title of every lesson; what it teaches is in its targets */
export const LESSON_TOPIC = "Lesson with a teacher";

export function startConversation(db: Db, deps: ConversationDeps, topic: string, tab: string, mode: "topic" | "lesson" = "topic", free = false): string {
  const id = deps.newId(), now = deps.now().toISOString();
  // a free-topic lesson starts with no target: the teacher asks what the learner wants to practise
  const plan = mode === "lesson" && !free ? planLesson(db, deps.now()) : [];
  if (mode === "lesson" && !free && plan.length === 0) throw new ApiError(409, "NOTHING_TO_PRACTISE", "There is nothing to practise yet: add words or practise grammar first.");
  db.transaction(() => {
    pauseActive(db, now);
    db.prepare("INSERT INTO conversation_sessions(id,topic,mode,status,tab_id,started_at,updated_at,heartbeat_at) VALUES (?,?,?,'active',?,?,?,?)").run(id, mode === "lesson" ? LESSON_TOPIC : topic, mode, tab, now, now, now);
    if (plan.length) insertTargets(db, id, 0, plan, now);
    enqueue(db, deps, { kind: "tutor", priority: 1, payload: { conversation: true, sessionId: id, action: "reply", messageId: null }, idempotencyKey: `conversation:${id}:opening` });
  })();
  return id;
}

export function resumeConversation(db: Db, deps: ConversationDeps, id: string, tab: string): void {
  session(db, id);
  const now = deps.now().toISOString();
  db.transaction(() => {
    pauseActive(db, now);
    db.prepare("UPDATE conversation_sessions SET status='active', tab_id=?, updated_at=?, heartbeat_at=? WHERE id=?").run(tab, now, now, id);
  })();
}

export function heartbeatConversation(db: Db, deps: ConversationDeps, id: string, tab: string): void {
  db.transaction(() => { owns(db, id, tab); accrue(db, id, deps.now().toISOString()); }).immediate();
}

export function pauseConversation(db: Db, deps: ConversationDeps, id: string, tab: string): void {
  owns(db, id, tab);
  db.transaction(() => {
    accrue(db, id, deps.now().toISOString());
    db.prepare("UPDATE conversation_sessions SET status='paused', tab_id=NULL, heartbeat_at=NULL WHERE id=?").run(id);
  })();
}

export function submitConversation(db: Db, deps: ConversationDeps, id: string, tab: string, messageId: string, text: string): void {
  owns(db, id, tab);
  db.transaction(() => {
    const previous = db.prepare("SELECT session_id AS sessionId, text FROM conversation_messages WHERE id=?").get(messageId) as { sessionId: string; text: string } | undefined;
    if (previous) {
      if (previous.sessionId !== id || previous.text !== text) throw new ApiError(409, "DUPLICATE_MESSAGE", "This message ID is already used.");
      return;
    }
    const last = db.prepare("SELECT role FROM conversation_messages WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(id) as { role: string } | undefined;
    if (!last || last.role !== "assistant" || replyPending(db, id)) throw new ApiError(409, "WAITING_FOR_REPLY", "Please wait for the next question.");
    if (lessonFinished(db, id)) throw new ApiError(409, "LESSON_FINISHED", "This lesson is finished. Start a new lesson to practise another topic.");
    const now = deps.now().toISOString();
    db.prepare("INSERT INTO conversation_messages(id,session_id,role,text,created_at) VALUES (?,?,'user',?,?)").run(messageId, id, text, now);
    db.prepare("INSERT INTO conversation_analyses(message_id,status,created_at) VALUES (?,'pending',?)").run(messageId, now);
    db.prepare("UPDATE conversation_sessions SET answer_count=answer_count+1,updated_at=? WHERE id=?").run(now, id);
    awardModeXp(db, { id: randomUUID(), source: "conversation", sourceId: messageId, amount: XP_CONVERSATION_ANSWER, at: now });
    enqueue(db, deps, { kind: "tutor", priority: 1, payload: { conversation: true, sessionId: id, action: "reply", messageId }, idempotencyKey: `conversation:${id}:reply:${messageId}` });
    enqueue(db, deps, { kind: "tutor", priority: 2, payload: { conversation: true, sessionId: id, action: "analysis", messageId }, idempotencyKey: `conversation:${id}:analysis:${messageId}` });
  })();
}

/** Lesson: the learner moves on to the next target. The teacher closes the old one and introduces the new one in a fresh reply. */
export function nextLessonTopic(db: Db, deps: ConversationDeps, id: string, tab: string): void {
  owns(db, id, tab);
  db.transaction(() => {
    const mode = (db.prepare("SELECT mode FROM conversation_sessions WHERE id=?").get(id) as { mode: string }).mode;
    if (mode !== "lesson") throw new ApiError(409, "NOT_A_LESSON", "Only a lesson has topics to switch.");
    const last = db.prepare("SELECT role FROM conversation_messages WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(id) as { role: string } | undefined;
    if (!last || last.role !== "assistant" || replyPending(db, id)) throw new ApiError(409, "WAITING_FOR_REPLY", "Please wait for the teacher's reply.");
    if (lessonFinished(db, id)) throw new ApiError(409, "LESSON_FINISHED", "This lesson is finished. Start a new lesson to practise another topic.");
    const ordinal = startNextTarget(db, id, deps.now());
    if (ordinal === null) throw new ApiError(409, "NO_MORE_TOPICS", "There are no more topics for this lesson.");
    db.prepare("UPDATE conversation_sessions SET updated_at=? WHERE id=?").run(deps.now().toISOString(), id);
    enqueue(db, deps, { kind: "tutor", priority: 1, payload: { conversation: true, sessionId: id, action: "reply", messageId: null }, idempotencyKey: `conversation:${id}:topic:${ordinal}` });
  })();
}
