import { createHash } from "node:crypto";
import type { Db } from "../../db/open.js";
import { wordEvents } from "../vocabulary/practice.js";
import { wordState, type WordEvent } from "../vocabulary/schedule.js";
import { normalizeWord } from "../vocabulary/forms.js";
import { weakGrammarSkills } from "../typing/dictation/planning.js";

export interface ConversationTarget { kind: "word" | "expression" | "grammar" | "none"; value: string | null }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const order = (a: string, b: string, seed: string) => hash(`${seed}\0${a}`).localeCompare(hash(`${seed}\0${b}`)) || a.localeCompare(b);
const mentioned = (text: string, value: string) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
};

export function conversationWord(entries: readonly { lemma: string; learned: number }[], events: ReadonlyMap<string, readonly WordEvent[]>, input: { sessionId: string; cycle: number; recent: string; now: Date }): ConversationTarget {
  const { cycle } = input;
  const buckets: Record<"due" | "new" | "recent", Array<{ lemma: string; priority: number }>> = { due: [], new: [], recent: [] };
  for (const entry of entries) {
    const lemma = normalizeWord(entry.lemma);
    if (!lemma || lemma.length > 60) continue;
    const state = wordState(lemma, events.get(lemma) ?? [], entry.learned === 1, input.now);
    const bucket = state.state === "new" ? "new" : state.due ? "due" : "recent";
    buckets[bucket].push({ lemma, priority: state.priority });
  }
  const preferred: Array<"due" | "new" | "recent"> = cycle % 4 === 3 ? ["recent", "due", "new"] : cycle % 2 ? ["new", "due", "recent"] : ["due", "new", "recent"];
  for (const allowRecent of [false, true]) for (const bucket of preferred) {
    const pool = buckets[bucket].filter(x => allowRecent || !mentioned(input.recent, x.lemma)).sort((a, b) => bucket === "due" ? b.priority - a.priority || order(a.lemma, b.lemma, input.sessionId) : order(a.lemma, b.lemma, `${input.sessionId}:${bucket}`));
    if (!pool.length) continue;
    const limit = bucket === "due" ? Math.min(3, pool.length) : pool.length;
    return { kind: "word", value: pool[cycle % limit]!.lemma };
  }
  return { kind: "none", value: null };
}

/** A rotating prompt suggestion only; it never records practice, changes word state, or supplies Mastery evidence. */
export function conversationTarget(db: Db, input: { sessionId: string; turn: number; recent: string; now: Date }): ConversationTarget {
  const cycle = Math.floor(input.turn / 4), mode = input.turn % 4;
  if (mode === 3) return { kind: "none", value: null };
  if (mode === 1) {
    const skills = weakGrammarSkills(db, input.now.toISOString(), 4);
    return skills.length ? { kind: "grammar", value: skills[cycle % skills.length]!.label } : { kind: "none", value: null };
  }
  if (mode === 2) {
    const phrases = db.prepare("SELECT phrase FROM vocabulary_expressions e WHERE (SELECT kind FROM vocabulary_expression_events ev WHERE ev.expression_id=e.id ORDER BY ev.created_at DESC,ev.rowid DESC LIMIT 1) IS NOT 'removed'").all() as Array<{ phrase: string }>;
    const candidates = phrases.map(x => x.phrase).filter(x => x.trim().length > 0 && x.length <= 200);
    const fresh = candidates.filter(x => !mentioned(input.recent, x));
    const pool = (fresh.length ? fresh : candidates).sort((a, b) => order(a, b, `${input.sessionId}:expressions`));
    return pool.length ? { kind: "expression", value: pool[cycle % pool.length]! } : { kind: "none", value: null };
  }
  const entries = db.prepare("SELECT lemma,learned FROM vocabulary_entries e WHERE (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id=e.id ORDER BY ev.created_at DESC,ev.rowid DESC LIMIT 1) IS NOT 'removed'").all() as Array<{ lemma: string; learned: number }>;
  return conversationWord(entries, wordEvents(db), { sessionId: input.sessionId, cycle, recent: input.recent, now: input.now });
}
