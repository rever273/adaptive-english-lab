import type { Db } from "../../db/open.js";
import { localDateIn } from "../attempts/canonical.js";
import { activityProgress } from "../sessions/xp.js";

/**
 * Vocabulary Analytics (vocabulary TZ, stage F). Everything is counted by code from stored events; nothing here touches Grammar Mastery.
 * Accuracy = confirmed correct FIRST independent attempts / confirmed first independent attempts, "I don't know" included as a miss.
 * Skipped, assisted (hint or answer seen before the first try) and not-yet-confirmed answers are shown apart and never in a denominator.
 * v2 (D64): every metric below is about FRESH sentences only; attempts on labelled repeats are summarised apart in `repeats` and never feed
 * accuracy, per-family rates, retention or the weak-word rule.
 */
export const VOCAB_ANALYTICS_VERSION = "vocabulary-analytics-v2";
const FAMILIES = ["recognition", "guided_recall", "collocation"] as const;
type Family = (typeof FAMILIES)[number];
/** below this many confirmed first tries a rate is shown as "insufficient data", never as a score */
export const MIN_SAMPLE = 5;
/** missed first tries before a word is listed under "need another look" */
export const WEAK_MIN_MISSES = 2;

interface Fact {
  at: string;
  localDate: string;
  family: Family;
  lemma: string;
  revisionId: string;
  prompt: string;
  independent: boolean;
  outcome: "correct" | "miss" | "pending";
  /** the slot was a labelled repeat of an already shown sentence */
  repeat: boolean;
}

function facts(db: Db, since: string | null): Fact[] {
  const rows = db
    .prepare(
      `SELECT t.submitted_at AS at, t.local_date AS localDate, t.hints_before AS hints, t.answer_seen_before AS seen, t.idk AS idk,
              er.id AS revisionId, er.content_json AS c, COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) AS rep,
              (SELECT a.verdict FROM assessment_revisions a WHERE a.attempt_id = t.id ORDER BY a.sequence DESC LIMIT 1) AS verdict,
              (SELECT a.confirmation FROM assessment_revisions a WHERE a.attempt_id = t.id ORDER BY a.sequence DESC LIMIT 1) AS confirmation
         FROM attempts t
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN vocabulary_sessions vs ON vs.session_id = ss.session_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE t.attempt_no = 1 AND (@since IS NULL OR t.submitted_at >= @since)
        ORDER BY t.submitted_at, t.id`,
    )
    .all({ since }) as Array<{ at: string; localDate: string; hints: number; seen: number; idk: number; revisionId: string; c: string; rep: number; verdict: string; confirmation: string }>;
  const out: Fact[] = [];
  for (const r of rows) {
    const c = JSON.parse(r.c) as { prompt_en: string; vocabulary?: { family?: Family; target?: { lemma?: string } } };
    const family = c.vocabulary?.family;
    const lemma = c.vocabulary?.target?.lemma;
    if (!family || !lemma || !FAMILIES.includes(family)) continue;
    const confirmed = r.confirmation === "confirmed";
    const outcome = r.idk === 1 || (confirmed && r.verdict === "incorrect") ? "miss" : confirmed && r.verdict === "correct" ? "correct" : "pending";
    out.push({ at: r.at, localDate: r.localDate, family, lemma: lemma.toLowerCase(), revisionId: r.revisionId, prompt: c.prompt_en, independent: r.hints === 0 && r.seen === 0, outcome, repeat: r.rep === 1 });
  }
  return out;
}

const rate = (correct: number, total: number) => ({ correct, total, rate: total >= MIN_SAMPLE ? correct / total : null, insufficient: total < MIN_SAMPLE });

export function vocabularyAnalytics(db: Db, p: { days: number | null; now: Date; timezone: string }) {
  const since = p.days === null ? null : new Date(p.now.getTime() - p.days * 86_400_000).toISOString();
  const allFacts = facts(db, since);
  const f = allFacts.filter((x) => !x.repeat);
  const rf = allFacts.filter((x) => x.repeat);
  const scored = f.filter((x) => x.independent && x.outcome !== "pending");

  const families = Object.fromEntries(
    FAMILIES.map((fam) => {
      const mine = f.filter((x) => x.family === fam);
      const s = mine.filter((x) => x.independent && x.outcome !== "pending");
      return [fam, { ...rate(s.filter((x) => x.outcome === "correct").length, s.length), assisted: mine.filter((x) => !x.independent).length, pending: mine.filter((x) => x.independent && x.outcome === "pending").length }];
    }),
  ) as Record<Family, ReturnType<typeof rate> & { assisted: number; pending: number }>;

  const skipped = (db
    .prepare(
      `SELECT COUNT(DISTINCT ss.id) AS n FROM session_slots ss JOIN vocabulary_sessions vs ON vs.session_id = ss.session_id
         JOIN session_events e ON e.slot_id = ss.id AND e.event_type = 'skip'
        WHERE NOT EXISTS (SELECT 1 FROM attempts t WHERE t.slot_id = ss.id) AND COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) <> 1 AND (@since IS NULL OR e.server_at >= @since)`,
    )
    .get({ since }) as { n: number }).n;

  // one point per local day: first-try accuracy (scored only) and XP earned that day
  const days = new Map<string, { date: string; correct: number; total: number; xp: number }>();
  const day = (d: string) => days.get(d) ?? days.set(d, { date: d, correct: 0, total: 0, xp: 0 }).get(d)!;
  for (const x of scored) {
    const d = day(x.localDate);
    d.total++;
    if (x.outcome === "correct") d.correct++;
  }
  for (const r of db
    .prepare(
      `SELECT e.local_date AS d, SUM(x.amount) AS xp FROM activity_xp_events x JOIN session_events e ON e.id = x.event_id
        WHERE x.track = 'vocabulary' AND (@since IS NULL OR x.created_at >= @since) GROUP BY e.local_date`,
    )
    .all({ since }) as Array<{ d: string; xp: number }>)
    day(r.d).xp = r.xp;
  const series = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  // the dictionary: words added and words marked learned, by local date (a flag set before migration 018 has no known date)
  const local = (iso: string) => localDateIn(p.timezone, new Date(iso));
  const growth = new Map<string, { date: string; added: number; learned: number }>();
  const g = (d: string) => growth.get(d) ?? growth.set(d, { date: d, added: 0, learned: 0 }).get(d)!;
  for (const r of db.prepare("SELECT created_at AS at FROM vocabulary_entries WHERE (@since IS NULL OR created_at >= @since)").all({ since }) as Array<{ at: string }>) g(local(r.at)).added++;
  for (const r of db.prepare("SELECT created_at AS at FROM vocabulary_learned_events WHERE learned = 1 AND (@since IS NULL OR created_at >= @since)").all({ since }) as Array<{ at: string }>) g(local(r.at)).learned++;
  const learnedNow = (db.prepare("SELECT COUNT(*) AS n FROM vocabulary_entries WHERE learned = 1").get() as { n: number }).n;
  const learnedDated = (db.prepare("SELECT COUNT(*) AS n FROM vocabulary_entries e WHERE learned = 1 AND EXISTS (SELECT 1 FROM vocabulary_learned_events l WHERE l.entry_id = e.id AND l.learned = 1)").get() as { n: number }).n;

  // encounters: what was really shown (any mode) vs what merely exists in the approved bank - never mixed
  const shown = db
    .prepare("SELECT COUNT(DISTINCT entry_id) AS words, COUNT(*) AS displays FROM vocabulary_encounters WHERE kind = 'displayed' AND (@since IS NULL OR created_at >= @since)")
    .get({ since }) as { words: number; displays: number };
  const bank = db.prepare("SELECT COUNT(DISTINCT entry_id) AS words, COUNT(*) AS contexts FROM vocabulary_encounters WHERE kind = 'bank'").get() as { words: number; contexts: number };

  // words that keep going wrong: first tries only, with the sentence of the latest miss
  const byLemma = new Map<string, Fact[]>();
  for (const x of f) (byLemma.get(x.lemma) ?? byLemma.set(x.lemma, []).get(x.lemma)!).push(x);
  const entryIds = new Map((db.prepare("SELECT id, lemma FROM vocabulary_entries").all() as Array<{ id: string; lemma: string }>).map((r) => [r.lemma.toLowerCase(), r.id]));
  const words = [...byLemma.entries()].map(([lemma, xs]) => {
    const s = xs.filter((x) => x.independent && x.outcome !== "pending");
    const misses = s.filter((x) => x.outcome === "miss");
    const last = s[s.length - 1];
    return { lemma, entryId: entryIds.get(lemma) ?? null, attempts: s.length, misses: misses.length, firstSeen: xs[0]!.at, lastSeen: xs[xs.length - 1]!.at, lastResult: last?.outcome ?? null, example: misses[misses.length - 1]?.prompt ?? null };
  });
  // a word is listed once it was missed (or "I don't know") on at least two first tries; the most recently seen come first, the page shows 10
  const weak = words.filter((w) => w.misses >= WEAK_MIN_MISSES).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  // retention: later first tries on the same word in a DIFFERENT sentence than the first one met
  let rc = 0;
  let rt = 0;
  for (const xs of byLemma.values()) {
    const s = xs.filter((x) => x.independent && x.outcome !== "pending");
    const firstRev = s[0]?.revisionId;
    for (const x of s.slice(1)) {
      if (x.revisionId === firstRev) continue;
      rt++;
      if (x.outcome === "correct") rc++;
    }
  }

  return {
    version: VOCAB_ANALYTICS_VERSION,
    window: { days: p.days, since, timezone: p.timezone },
    minSample: MIN_SAMPLE,
    weakMinMisses: WEAK_MIN_MISSES,
    xp: activityProgress(db, "vocabulary"),
    overall: { ...rate(scored.filter((x) => x.outcome === "correct").length, scored.length), assisted: f.filter((x) => !x.independent).length, pending: f.filter((x) => x.independent && x.outcome === "pending").length, skipped },
    families,
    series,
    growth: { series: [...growth.values()].sort((a, b) => a.date.localeCompare(b.date)), learnedNow, learnedWithoutDate: learnedNow - learnedDated },
    encounters: { uniqueWordsShown: shown.words, displays: shown.displays, bankWords: bank.words, bankContexts: bank.contexts },
    weak,
    words: words.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    retention: rate(rc, rt),
    // labelled repeats of sentences shown before: weaker evidence, kept apart from every fresh-sentence metric above
    repeats: {
      count: rf.length,
      correct: rf.filter((x) => x.independent && x.outcome === "correct").length,
      miss: rf.filter((x) => x.independent && x.outcome === "miss").length,
      assisted: rf.filter((x) => !x.independent).length,
      pending: rf.filter((x) => x.independent && x.outcome === "pending").length,
    },
  };
}
