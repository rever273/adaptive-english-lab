import type { Db } from "../../db/open.js";
import { canonicalCards, skillCard } from "../skills/cards.js";
import { exportLessonPriorities } from "../reports/lessonPriorities.js";
import { wordEvents } from "../vocabulary/practice.js";
import { wordState } from "../vocabulary/schedule.js";
import { normalizeWord } from "../vocabulary/forms.js";
import { currentTranslations } from "../vocabulary/repository.js";

/**
 * Conversation lessons: a teacher works through up to three targets, one at a time: the weakest grammar rule, a saved word and a saved
 * expression. The choice follows the learner's knowledge (grammar priority from the lesson report, word state from the vocabulary
 * schedule, newest saved expressions first) and rotates: a target comes back only after every other candidate of its kind was used.
 * Nothing here records practice evidence: the lesson is a conversation, and the model's view of an answer is never a verdict.
 */
export type LessonKind = "grammar" | "word" | "expression";
export interface LessonTarget { kind: LessonKind; key: string; label: string; brief: Record<string, unknown> }
export interface LessonTargetView { ordinal: number; kind: LessonKind; label: string; status: "done" | "current" | "queued" }

export const LESSON_TARGETS = 3;
const MAX_ORDINAL = 5;

/** when each target was last started in any lesson */
function lastUsed(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT kind, target_key AS key, max(started_at) AS at FROM conversation_lesson_targets WHERE started_at IS NOT NULL GROUP BY kind, target_key").all() as Array<{ kind: string; key: string; at: string }>;
  return new Map(rows.map((r) => [`${r.kind}\0${r.key}`, r.at]));
}

/** the first candidate (they come weakest first) never used yet; when all were used, the one used longest ago */
export function rotate<T extends { key: string }>(kind: LessonKind, ordered: readonly T[], used: ReadonlyMap<string, string>, skip: ReadonlySet<string> = new Set()): T | undefined {
  const pool = ordered.filter((c) => !skip.has(`${kind}\0${c.key}`));
  return pool.find((c) => !used.has(`${kind}\0${c.key}`)) ?? [...pool].sort((a, b) => (used.get(`${kind}\0${a.key}`)! < used.get(`${kind}\0${b.key}`)! ? -1 : 1))[0];
}

function grammarCandidates(db: Db, now: Date): LessonTarget[] {
  let ids: string[] = [];
  try {
    const skills = (exportLessonPriorities(db, now.toISOString(), 5).json as { skills: Array<{ id: string; priority: number | null }> }).skills;
    ids = [...skills].sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1)).map((s) => s.id);
  } catch {
    /* no taxonomy yet: every card below, in its own order */
  }
  const all = Object.entries(canonicalCards().skills).filter(([, c]) => c.inTaxonomy && c.rule).map(([id]) => id);
  const ordered = [...new Set([...ids, ...all])];
  return ordered.flatMap((id) => {
    const c = skillCard(id);
    if (!c?.rule) return [];
    return [{ kind: "grammar" as const, key: id, label: c.displayName ?? id, brief: { grammar_point: c.displayName ?? id, name_ru: c.displayNameRu ?? null, rule: c.rule, good_examples: c.good ?? [], typical_mistake: c.wrong ?? null } }];
  });
}

function wordCandidates(db: Db, now: Date): LessonTarget[] {
  const entries = db.prepare("SELECT id, lemma, learned FROM vocabulary_entries e WHERE (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id=e.id ORDER BY ev.created_at DESC,ev.rowid DESC LIMIT 1) IS NOT 'removed'").all() as Array<{ id: string; lemma: string; learned: number }>;
  if (entries.length === 0) return [];
  const events = wordEvents(db);
  const translations = currentTranslations(db, entries.map((e) => e.id));
  // due words first (most overdue / most missed), then new ones, then the rest; learned words only when nothing else is left
  const rank = entries.flatMap((e) => {
    const lemma = normalizeWord(e.lemma);
    if (!lemma || lemma.length > 60) return [];
    const st = wordState(lemma, events.get(lemma) ?? [], e.learned === 1, now);
    const group = e.learned === 1 ? 3 : st.due ? 0 : st.state === "new" ? 1 : 2;
    return [{ e, lemma, group, priority: st.priority }];
  });
  rank.sort((a, b) => a.group - b.group || b.priority - a.priority || a.lemma.localeCompare(b.lemma));
  return rank.map(({ e, lemma }) => ({ kind: "word", key: lemma, label: e.lemma, brief: { word: e.lemma, meaning_ru: translations.get(e.id) ?? null } }));
}

function expressionCandidates(db: Db): LessonTarget[] {
  const rows = db.prepare("SELECT phrase, phrase_key AS key FROM vocabulary_expressions e WHERE (SELECT kind FROM vocabulary_expression_events ev WHERE ev.expression_id=e.id ORDER BY ev.created_at DESC,ev.rowid DESC LIMIT 1) IS NOT 'removed' ORDER BY created_at DESC, rowid DESC").all() as Array<{ phrase: string; key: string }>;
  return rows.filter((r) => r.phrase.trim() && r.phrase.length <= 200 && r.key).map((r) => ({ kind: "expression", key: r.key.slice(0, 200), label: r.phrase, brief: { expression: r.phrase } }));
}

function candidates(db: Db, now: Date): Record<LessonKind, LessonTarget[]> {
  return { grammar: grammarCandidates(db, now), word: wordCandidates(db, now), expression: expressionCandidates(db) };
}

/** the plan of a new lesson: one target of each kind; which kind leads changes from lesson to lesson */
export function planLesson(db: Db, now: Date): LessonTarget[] {
  const pools = candidates(db, now);
  const used = lastUsed(db);
  const lessons = (db.prepare("SELECT count(*) AS n FROM conversation_sessions WHERE mode='lesson'").get() as { n: number }).n;
  const kinds: LessonKind[] = ["grammar", "word", "expression"];
  const order = kinds.map((_, i) => kinds[(i + lessons) % kinds.length]!);
  return order.flatMap((k) => { const t = rotate(k, pools[k], used); return t ? [t] : []; }).slice(0, LESSON_TARGETS);
}

/** one more target when the planned ones are used up: the kind that came up least in this lesson, not one already in it */
export function extraTarget(db: Db, sessionId: string, now: Date): LessonTarget | undefined {
  const inLesson = db.prepare("SELECT kind, target_key AS key FROM conversation_lesson_targets WHERE session_id=?").all(sessionId) as Array<{ kind: LessonKind; key: string }>;
  const skip = new Set(inLesson.map((t) => `${t.kind}\0${t.key}`));
  const pools = candidates(db, now);
  const used = lastUsed(db);
  const count = (k: LessonKind) => inLesson.filter((t) => t.kind === k).length;
  for (const k of (["grammar", "word", "expression"] as LessonKind[]).sort((a, b) => count(a) - count(b))) {
    const t = rotate(k, pools[k], used, skip);
    if (t) return t;
  }
  return undefined;
}

export function insertTargets(db: Db, sessionId: string, from: number, targets: readonly LessonTarget[], startFirstAt: string | null): void {
  const insert = db.prepare("INSERT INTO conversation_lesson_targets(session_id, ordinal, kind, target_key, label, brief_json, started_at) VALUES (?,?,?,?,?,?,?)");
  targets.forEach((t, i) => insert.run(sessionId, from + i, t.kind, t.key, t.label.slice(0, 200), JSON.stringify(t.brief), i === 0 ? startFirstAt : null));
}

export function lessonTargets(db: Db, sessionId: string): LessonTargetView[] {
  const rows = db.prepare("SELECT ordinal, kind, label, started_at AS startedAt FROM conversation_lesson_targets WHERE session_id=? ORDER BY ordinal").all(sessionId) as Array<{ ordinal: number; kind: LessonKind; label: string; startedAt: string | null }>;
  const current = Math.max(-1, ...rows.filter((r) => r.startedAt).map((r) => r.ordinal));
  return rows.map((r) => ({ ordinal: r.ordinal, kind: r.kind, label: r.label, status: r.ordinal === current ? "current" : r.ordinal < current ? "done" : "queued" }));
}

/** start the next target: the next queued one, or a new one (up to six per lesson). Returns its ordinal, or null when there is none */
export function startNextTarget(db: Db, sessionId: string, now: Date): number | null {
  const views = lessonTargets(db, sessionId);
  const current = views.find((v) => v.status === "current")?.ordinal ?? -1;
  let next = views.find((v) => v.ordinal > current)?.ordinal;
  if (next === undefined) {
    const ordinal = views.length ? Math.max(...views.map((v) => v.ordinal)) + 1 : 0;
    if (ordinal > MAX_ORDINAL) return null;
    const extra = extraTarget(db, sessionId, now);
    if (!extra) return null;
    insertTargets(db, sessionId, ordinal, [extra], null);
    next = ordinal;
  }
  db.prepare("UPDATE conversation_lesson_targets SET started_at=? WHERE session_id=? AND ordinal=? AND started_at IS NULL").run(now.toISOString(), sessionId, next);
  return next;
}

/** what the reply prompt needs: the current target with its brief, how many answers were given on it, and the other targets' names */
export function lessonContext(db: Db, sessionId: string): { current: { kind: LessonKind; label: string; brief: Record<string, unknown>; answers: number } | null; done: string[]; upcoming: string[] } {
  const rows = db.prepare("SELECT ordinal, kind, label, brief_json AS brief, started_at AS startedAt FROM conversation_lesson_targets WHERE session_id=? ORDER BY ordinal").all(sessionId) as Array<{ ordinal: number; kind: LessonKind; label: string; brief: string; startedAt: string | null }>;
  const started = rows.filter((r) => r.startedAt);
  const cur = started.at(-1);
  if (!cur) return { current: null, done: [], upcoming: rows.map((r) => r.label) };
  const answers = (db.prepare("SELECT count(*) AS n FROM conversation_messages WHERE session_id=? AND role='user' AND created_at >= ?").get(sessionId, cur.startedAt) as { n: number }).n;
  let brief: Record<string, unknown> = {};
  try { brief = JSON.parse(cur.brief) as Record<string, unknown>; } catch { /* keep empty */ }
  return { current: { kind: cur.kind, label: cur.label, brief, answers }, done: rows.filter((r) => r.ordinal < cur.ordinal).map((r) => r.label), upcoming: rows.filter((r) => r.ordinal > cur.ordinal).map((r) => r.label) };
}
