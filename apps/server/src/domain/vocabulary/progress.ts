import type { Db } from "../../db/open.js";
import { learningDate } from "../journey/calendar.js";
import { strengthEvidence, wordStrength, WORD_STRENGTH_VERSION, type Evidence } from "./strength.js";

/**
 * vocabulary-progress-v1: how the saved words move over time, recomputed on every request from the raw events of the three vocabulary modes
 * (the same evidence as word-strength-v1, replayed day by day). Nothing is stored; a new version can change the rules without touching history.
 * "Strong" is a computed figure (strength at or above STRONG), not the learner's own "learned" mark, which is shown apart.
 */
export const VOCAB_PROGRESS_VERSION = "vocabulary-progress-v1";
export const STRONG = 7;
/** at most this many points on a time axis: a longer span is grouped by week */
const MAX_POINTS = 120;
/** words per group in the word tracks */
const TRACK_WORDS = 5;
/** a word needs this many pieces of evidence before it can be called hard to remember */
const WEAK_MIN_EVIDENCE = 3;
const DAY = 86_400_000;

export interface ProgressPoint {
  /** the last learning date of the point (a day, or a week when grouped) */
  date: string;
  total: number;
  notStarted: number;
  learning: number;
  strong: number;
  markedLearned: number;
  right: number;
  missed: number;
  words: number;
}

export interface WordTrack {
  entryId: string;
  lemma: string;
  strength: Array<number | null>;
  right: number[];
  missed: number[];
  now: number;
  evidence: number;
  /** time on the word in the period (see timeOnWords) */
  timeMs: number;
}

/** caps that keep a walk away from the screen out of the time figures */
const CAP = { practiceMs: 120_000, contextCardMs: 180_000, lessonMs: 30 * 60_000 } as const;

/**
 * Time spent on each word since `from` (a learning date), by source: Vocabulary Practice = the recorded answer latency; Single Word = the
 * finished pass from start to end; Context Loop = the time from the previous card (or the session start) to the answer. Each piece is capped.
 */
export function timeOnWords(db: Db, from: string, entryOfLemma: Map<string, string>) {
  const bySource = { practice: 0, oneWord: 0, contextLoop: 0, checks: 0 };
  const byWord = new Map<string, number>();
  const add = (id: string | undefined, source: keyof typeof bySource, ms: number) => {
    if (!id || !(ms > 0)) return;
    bySource[source] += ms;
    byWord.set(id, (byWord.get(id) ?? 0) + ms);
  };
  for (const r of db
    .prepare(
      `SELECT t.latency_ms AS ms, t.submitted_at AS at, er.content_json AS c FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id
         JOIN vocabulary_sessions vs ON vs.session_id = ss.session_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE t.latency_ms IS NOT NULL`,
    )
    .all() as Array<{ ms: number; at: string; c: string }>) {
    if (dayOf(r.at) < from) continue;
    const lemma = (JSON.parse(r.c) as { vocabulary?: { target?: { lemma?: string } } }).vocabulary?.target?.lemma;
    if (lemma) add(entryOfLemma.get(lemma.toLowerCase()), "practice", Math.min(CAP.practiceMs, r.ms));
  }
  // the visible, active time the lesson recorded (heartbeat intervals), not the clock from start to end
  for (const r of db
    .prepare("SELECT l.entry_id AS id, r.started_at AS s, COALESCE((SELECT SUM(i.end_ms - i.start_ms) FROM word_lesson_activity_intervals i WHERE i.run_id = r.id), 0) AS ms FROM word_lesson_runs r JOIN word_lessons l ON l.id = r.lesson_id")
    .all() as Array<{ id: string; s: string; ms: number }>) {
    if (dayOf(r.s) >= from) add(r.id, "oneWord", Math.min(CAP.lessonMs, r.ms));
  }
  let prev: { session: string; at: number } | null = null;
  for (const r of db
    .prepare("SELECT a.session_id AS session, a.entry_id AS id, a.kind, a.created_at AS at, s.started_at AS started FROM context_loop_attempts a JOIN context_loop_sessions s ON s.id = a.session_id ORDER BY a.session_id, a.card_index")
    .all() as Array<{ session: string; id: string; kind: string; at: string; started: string }>) {
    const at = Date.parse(r.at);
    const since = prev && prev.session === r.session ? prev.at : Date.parse(r.started);
    if (dayOf(r.at) >= from) add(r.id, r.kind === "check" ? "checks" : "contextLoop", Math.min(CAP.contextCardMs, at - since));
    prev = { session: r.session, at };
  }
  return { bySource, byWord };
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayOf = (iso: string) => learningDate(Date.parse(iso));
/** strength at the end of a learning date */
const endOf = (date: string) => new Date(Date.parse(`${date}T23:59:59Z`));

export function vocabularyProgress(db: Db, p: { days: number | null; now: Date }) {
  const entries = db.prepare("SELECT id, lemma, created_at AS at FROM vocabulary_entries").all() as Array<{ id: string; lemma: string; at: string }>;
  const lemmaOf = new Map(entries.map((e) => [e.id, e.lemma]));
  const evidence = new Map<string, Array<Evidence & { day: string }>>();
  for (const [id, list] of strengthEvidence(db)) {
    if (!lemmaOf.has(id)) continue;
    evidence.set(id, list.map((e) => ({ ...e, day: dayOf(e.at) })).sort((a, b) => a.at.localeCompare(b.at)));
  }
  const learnedEvents = db.prepare("SELECT entry_id AS id, learned, created_at AS at FROM vocabulary_learned_events ORDER BY created_at, rowid").all() as Array<{ id: string; learned: number; at: string }>;

  const today = learningDate(p.now.getTime());
  const firstSeen = [...entries.map((e) => dayOf(e.at)), ...[...evidence.values()].flatMap((l) => (l[0] ? [l[0].day] : []))].sort()[0] ?? today;
  const start = p.days === null ? firstSeen : addDays(today, -(p.days - 1));
  const span = Math.max(1, Math.round((Date.parse(today) - Date.parse(start)) / DAY) + 1);
  const step = span > MAX_POINTS ? 7 : 1;
  // the end date of every point, the last one is today
  const ends: string[] = [];
  for (let d = today; d >= start; d = addDays(d, -step)) ends.unshift(d);
  const from = addDays(ends[0]!, -(step - 1));
  const bucketOf = (day: string): number => {
    if (day < from || day > today) return -1;
    return ends.findIndex((e) => day <= e);
  };

  const points: ProgressPoint[] = ends.map((date) => ({ date, total: 0, notStarted: 0, learning: 0, strong: 0, markedLearned: 0, right: 0, missed: 0, words: 0 }));
  const strengthAt = new Map<string, Array<number | null>>();
  const rightOf = new Map<string, number[]>();
  const missOf = new Map<string, number[]>();
  const wordsPerPoint = ends.map(() => new Set<string>());

  for (const e of entries) {
    const list = evidence.get(e.id) ?? [];
    const created = dayOf(e.at);
    const series: Array<number | null> = [];
    const right = ends.map(() => 0);
    const missed = ends.map(() => 0);
    for (const x of list) {
      const b = bucketOf(x.day);
      if (b < 0) continue;
      if (x.s >= 0.5) right[b]!++;
      else missed[b]!++;
      wordsPerPoint[b]!.add(e.id);
    }
    let n = 0;
    ends.forEach((date, i) => {
      const pt = points[i]!;
      if (created > date && !(list[0] && list[0].day <= date)) {
        series.push(null);
        return;
      }
      pt.total++;
      while (n < list.length && list[n]!.day <= date) n++;
      if (n === 0) {
        pt.notStarted++;
        series.push(null);
        return;
      }
      const v = wordStrength(list.slice(0, n), endOf(date)).value;
      series.push(v);
      if (v >= STRONG) pt.strong++;
      else pt.learning++;
    });
    strengthAt.set(e.id, series);
    rightOf.set(e.id, right);
    missOf.set(e.id, missed);
  }
  ends.forEach((_, i) => {
    const pt = points[i]!;
    for (const id of entries.map((e) => e.id)) {
      pt.right += rightOf.get(id)![i]!;
      pt.missed += missOf.get(id)![i]!;
    }
    pt.words = wordsPerPoint[i]!.size;
  });
  // the learner's own mark, replayed: the latest event of each word up to the date
  const state = new Map<string, number>();
  let k = 0;
  ends.forEach((date, i) => {
    while (k < learnedEvents.length && dayOf(learnedEvents[k]!.at) <= date) {
      state.set(learnedEvents[k]!.id, learnedEvents[k]!.learned);
      k++;
    }
    points[i]!.markedLearned = [...state.values()].filter((v) => v === 1).length;
  });

  // strength now, by band
  const nowStrength = new Map<string, number>();
  for (const [id, list] of evidence) if (list.length > 0) nowStrength.set(id, wordStrength(list, p.now).value);
  const bands = [0, 2, 4, 6, 8].map((lo) => ({ from: lo, to: lo + 2, words: 0 }));
  for (const v of nowStrength.values()) bands[Math.min(4, Math.floor(v / 2))]!.words++;

  // word tracks: the most practised, the hardest to remember and the latest words in the period
  const inWindow = (id: string) => (evidence.get(id) ?? []).filter((x) => x.day >= from);
  const practised = entries.filter((e) => inWindow(e.id).length > 0);
  const pick = (list: typeof practised) => list.slice(0, TRACK_WORDS).map((e) => e.id);
  const groups = {
    active: pick([...practised].sort((a, b) => inWindow(b.id).length - inWindow(a.id).length || a.lemma.localeCompare(b.lemma))),
    weak: pick(practised.filter((e) => (evidence.get(e.id)?.length ?? 0) >= WEAK_MIN_EVIDENCE).sort((a, b) => nowStrength.get(a.id)! - nowStrength.get(b.id)! || a.lemma.localeCompare(b.lemma))),
    recent: pick([...practised].sort((a, b) => inWindow(b.id).at(-1)!.at.localeCompare(inWindow(a.id).at(-1)!.at))),
  };
  const tracks: WordTrack[] = [...new Set(Object.values(groups).flat())].map((id) => ({
    entryId: id,
    lemma: lemmaOf.get(id)!,
    strength: strengthAt.get(id)!,
    right: rightOf.get(id)!,
    missed: missOf.get(id)!,
    now: nowStrength.get(id) ?? 0,
    evidence: evidence.get(id)?.length ?? 0,
    timeMs: 0,
  }));

  // time on each word and the four sources side by side, in the same period
  const time = timeOnWords(db, from, new Map(entries.map((e) => [e.lemma.toLowerCase(), e.id])));
  const modes = (["practice", "oneWord", "contextLoop", "checks"] as const).map((source) => {
    const list = [...evidence.entries()].flatMap(([id, l]) => l.filter((x) => x.source === source && x.day >= from).map((x) => ({ id, ok: x.s >= 0.5 })));
    return { source, answers: list.length, right: list.filter((x) => x.ok).length, words: new Set(list.map((x) => x.id)).size, timeMs: time.bySource[source] };
  });
  for (const t of tracks) t.timeMs = time.byWord.get(t.entryId) ?? 0;
  const timeTop = [...time.byWord.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, ms]) => ({ entryId: id, lemma: lemmaOf.get(id) ?? "?", timeMs: ms, answers: inWindow(id).length }));

  return {
    version: VOCAB_PROGRESS_VERSION,
    modes,
    timeTop,
    timeTotalMs: Object.values(time.bySource).reduce((a, b) => a + b, 0),
    strengthVersion: WORD_STRENGTH_VERSION,
    strong: STRONG,
    grouping: step === 7 ? ("week" as const) : ("day" as const),
    points,
    bands,
    practisedWords: nowStrength.size,
    groups,
    tracks,
  };
}
