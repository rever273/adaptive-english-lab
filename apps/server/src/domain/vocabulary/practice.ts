import { createHash } from "node:crypto";
import { VocabularyPracticeMetadataSchema, vocabularyNewWordsPerSession, vocabularyTaskCount, type CreateSessionResponse } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { localDateIn } from "../attempts/canonical.js";
import { loadBlockedFingerprints } from "../sessions/bank.js";
import { loadPlan, loadSettings, type SessionDeps } from "../sessions/policy.js";
import { getSnapshot } from "../sessions/snapshot.js";
import { normalizeWord } from "./forms.js";
import { FAMILY_WEIGHT, SELECTION_CONFIG, VOCABULARY_SELECTION_V4, pickVocabulary, wordState, type Outcome, type ShownCandidate, type VocabularyCandidate, type WordEvent } from "./schedule.js";

export const VOCABULARY_SELECTION = VOCABULARY_SELECTION_V4;
export type { VocabularyCandidate, ShownCandidate } from "./schedule.js";
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** entries the learner keeps (not hidden), by normalised lemma */
function visibleEntries(db: Db): Map<string, { id: string; learned: boolean }> {
  const rows = db
    .prepare(
      `SELECT id, lemma, learned FROM vocabulary_entries e
        WHERE (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = e.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'`,
    )
    .all() as Array<{ id: string; lemma: string; learned: number }>;
  return new Map(rows.map((r) => [normalizeWord(r.lemma), { id: r.id, learned: r.learned === 1 }]));
}

/** every approved + released vocabulary exercise, whether or not it can still be used */
function bank(db: Db): Array<{ revisionId: string; content: string; difficulty: string; rubricVersion: string }> {
  return db
    .prepare(
      `SELECT er.id AS revisionId, er.content_json AS content, er.difficulty AS difficulty, er.rubric_version AS rubricVersion
         FROM selectable_revisions s JOIN exercise_revisions er ON er.id = s.revision_id
        WHERE er.bank_role = 'practice' AND json_type(er.content_json, '$.vocabulary') IS NOT NULL
        ORDER BY er.id`,
    )
    .all() as Array<{ revisionId: string; content: string; difficulty: string; rubricVersion: string }>;
}

function unitsOf(db: Db): Map<string, Array<{ id: string; fingerprint: string }>> {
  const out = new Map<string, Array<{ id: string; fingerprint: string }>>();
  for (const u of db
    .prepare(
      `SELECT rpu.revision_id AS revisionId, u.id AS id, u.fingerprint AS fingerprint
         FROM revision_prompt_units rpu JOIN prompt_units u ON u.id = rpu.unit_id
        WHERE rpu.revision_id IN (SELECT revision_id FROM selectable_revisions)`,
    )
    .all() as Array<{ revisionId: string; id: string; fingerprint: string }>) {
    (out.get(u.revisionId) ?? out.set(u.revisionId, []).get(u.revisionId)!).push({ id: u.id, fingerprint: u.fingerprint });
  }
  return out;
}

/**
 * Independent first attempts per word in time order (the same rule as vocabulary analytics): confirmed correct = success, confirmed
 * incorrect or "I don't know" = miss, a hint or shown answer before the try = assisted; not-yet-confirmed answers are ignored.
 * Attempts on repeat slots count too (they are real retrieval); analytics keeps them apart from the fresh-sentence rates.
 */
export function wordEvents(db: Db): Map<string, WordEvent[]> {
  const rows = db
    .prepare(
      `SELECT t.submitted_at AS at, t.hints_before AS hints, t.answer_seen_before AS seen, t.idk AS idk, ss.id AS slotId, ss.exercise_revision_id AS revisionId,
              json_extract(er.content_json, '$.vocabulary.target.lemma') AS lemma, COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) AS repeat,
              (SELECT a.verdict FROM assessment_revisions a WHERE a.attempt_id = t.id ORDER BY a.sequence DESC LIMIT 1) AS verdict,
              (SELECT a.confirmation FROM assessment_revisions a WHERE a.attempt_id = t.id ORDER BY a.sequence DESC LIMIT 1) AS confirmation
         FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id JOIN vocabulary_sessions vs ON vs.session_id = ss.session_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE t.attempt_no = 1 ORDER BY t.submitted_at, t.id`,
    )
    .all() as Array<{ at: string; hints: number; seen: number; idk: number; slotId: string; revisionId: string; lemma: string | null; repeat: number; verdict: string | null; confirmation: string | null }>;
  const out = new Map<string, WordEvent[]>();
  for (const r of rows) {
    if (!r.lemma) continue;
    const confirmed = r.confirmation === "confirmed";
    const result: "correct" | "miss" | null = r.idk === 1 || (confirmed && r.verdict === "incorrect") ? "miss" : confirmed && r.verdict === "correct" ? "correct" : null;
    if (!result) continue; // pending or ambiguous: not evidence yet
    const outcome: Outcome = r.hints > 0 || r.seen === 1 ? "assisted" : result === "correct" ? "success" : "miss";
    const lemma = normalizeWord(r.lemma);
    (out.get(lemma) ?? out.set(lemma, []).get(lemma)!).push({ at: r.at, outcome, revisionId: r.revisionId, slotId: r.slotId, independent: r.repeat !== 1 });
  }
  return out;
}

/** revision -> latest moment it was shown (reveal, skip, attempt or exposure) in a vocabulary session that is not active */
function shownRevisions(db: Db): Map<string, { at: string; slotId: string }> {
  const rows = db
    .prepare(
      `SELECT ss.id AS slotId, ss.exercise_revision_id AS revisionId, MAX(x.at) AS at
         FROM session_slots ss JOIN vocabulary_sessions vs ON vs.session_id = ss.session_id JOIN sessions s ON s.id = ss.session_id
         JOIN (SELECT slot_id, server_at AS at FROM session_events WHERE event_type IN ('reveal','skip') AND slot_id IS NOT NULL
               UNION ALL SELECT slot_id, submitted_at FROM attempts
               UNION ALL SELECT slot_id, exposed_at FROM exposures) x ON x.slot_id = ss.id
        WHERE s.status <> 'active' GROUP BY ss.id ORDER BY at, ss.id`,
    )
    .all() as Array<{ slotId: string; revisionId: string; at: string }>;
  const out = new Map<string, { at: string; slotId: string }>();
  for (const r of rows) out.set(r.revisionId, { at: r.at, slotId: r.slotId }); // ordered by time: the last one wins
  return out;
}

/**
 * Approved, released vocabulary exercises for words in the learner's dictionary. `usable` = sentences never shown or reserved in ANY mode
 * (the same global no-repeat ledger as grammar); `shown` = sentences already shown in an earlier vocabulary session, offered only as
 * labelled repeats (D64). Exercises for words that are not in the dictionary are never offered.
 */
export function vocabularyCandidates(db: Db): { usable: VocabularyCandidate[]; shown: ShownCandidate[]; approvedForWords: number; approvedTotal: number } {
  const entries = visibleEntries(db);
  const blocked = loadBlockedFingerprints(db);
  const units = unitsOf(db);
  const shownAt = shownRevisions(db);
  const exposed = new Set((db.prepare("SELECT unit_id AS id FROM exposures").all() as Array<{ id: string }>).map((r) => r.id));
  const reserved = new Set((db.prepare("SELECT unit_id AS id FROM prompt_reservations").all() as Array<{ id: string }>).map((r) => r.id));
  const events = wordEvents(db);
  const attempted = new Set((db.prepare("SELECT slot_id AS id FROM attempts WHERE attempt_no = 1").all() as Array<{ id: string }>).map(r => r.id));
  const outcomeBySlot = new Map<string, Outcome>();
  for (const evs of events.values()) for (const e of evs) outcomeBySlot.set(e.slotId, e.outcome);
  const usable: VocabularyCandidate[] = [];
  const shown: ShownCandidate[] = [];
  let approvedForWords = 0;
  const all = bank(db);
  for (const r of all) {
    const meta = VocabularyPracticeMetadataSchema.safeParse((JSON.parse(r.content) as { vocabulary?: unknown }).vocabulary);
    if (!meta.success) continue;
    const entry = entries.get(normalizeWord(meta.data.target.lemma));
    if (!entry) continue;
    approvedForWords++;
    const u = units.get(r.revisionId) ?? [];
    if (u.length === 0) continue;
    const cand: VocabularyCandidate = { revisionId: r.revisionId, lemma: normalizeWord(meta.data.target.lemma), entryId: entry.id, learned: entry.learned, family: meta.data.family, difficulty: r.difficulty, rubricVersion: r.rubricVersion, units: u.map((x) => x.id), unitFingerprints: u.map((x) => x.fingerprint) };
    const seen = shownAt.get(r.revisionId);
    if (seen) {
      // a repeat reserves the units never exposed (so they enter the ledger when shown); one held by another slot makes it ineligible
      const unexposedUnits = cand.units.filter((x) => !exposed.has(x));
      if (unexposedUnits.some((x) => reserved.has(x))) continue;
      shown.push({ ...cand, unexposedUnits, lastShownAt: seen.at, lastSlotId: seen.slotId, lastOutcome: outcomeBySlot.get(seen.slotId) ?? (attempted.has(seen.slotId) ? "success" : null) });
    } else if (!u.some((x) => blocked.has(x.fingerprint))) usable.push(cand);
  }
  return { usable, shown, approvedForWords, approvedTotal: all.length };
}

export interface VocabularyPracticeStatus {
  taskCount: number;
  /** exercises the picker can offer now: new sentences plus eligible labelled repeats (D64) */
  available: number;
  /** new (never shown) sentences only; repeats are not counted. Content stock warnings use this. */
  freshAvailable: number;
  /** repeats among `available` (in your next session) */
  repeatsAvailable: number;
  /** shown sentences that can come back as repeats (stock, not the next session) */
  repeatStock: number;
  wordsWithContexts: number;
  words: number;
  learned: number;
  approvedForWords: number;
  /** vocabulary drafts that exist but are not approved and released (they are never offered) */
  draftsNotReleased: number;
  shortage: { available: number; requested: number; message: string } | null;
  activeSessionId: string | null;
  wordQueue: { due: number; newWords: number; recent: number };
}

export function vocabularyPracticeStatus(db: Db, now: Date = new Date()): VocabularyPracticeStatus {
  const settings = loadSettings(db);
  const n = vocabularyTaskCount(settings.values);
  const { usable, shown, approvedForWords } = vocabularyCandidates(db);
  const entries = visibleEntries(db);
  const drafts = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM exercise_revisions er
        WHERE json_type(er.content_json, '$.vocabulary') IS NOT NULL AND er.id NOT IN (SELECT revision_id FROM selectable_revisions)
          AND er.exercise_id NOT IN (SELECT exercise_id FROM selectable_revisions)`, // a revision replaced by a newer approved one is history, not a draft
    )
    .get() as { n: number }).n;
  const active = db.prepare("SELECT s.id FROM sessions s JOIN vocabulary_sessions v ON v.session_id = s.id WHERE s.status = 'active' ORDER BY s.created_at DESC LIMIT 1").get() as { id: string } | undefined;
  const all = Number.MAX_SAFE_INTEGER;
  // `available` = the largest session (up to the configured size) the picker can really build with the soft repeat cap and the new-word cap
  const events = wordEvents(db);
  const newWords = vocabularyNewWordsPerSession(settings.values);
  const candidateLemmas = new Set([...usable, ...shown].map(c => c.lemma));
  const wordQueue = { due: 0, newWords: 0, recent: 0 };
  for (const lemma of candidateLemmas) {
    const state = wordState(lemma, events.get(lemma) ?? [], entries.get(lemma)?.learned ?? false, now);
    if (state.state === "new") wordQueue.newWords++;
    else if (state.due) wordQueue.due++;
    else wordQueue.recent++;
  }
  const { n: available, picks } = largestFeasible((m) => pickVocabulary({ fresh: usable, shown, events, now, n: m, seed: "status", newWordsPerSession: newWords }), n);
  const freshAvailable = pickVocabulary({ fresh: usable, shown: [], events: new Map(), now, n: all, seed: "status", newWordsPerSession: all }).length;
  return {
    taskCount: n,
    wordQueue,
    available,
    freshAvailable,
    repeatsAvailable: picks.filter((p) => p.repeat).length,
    repeatStock: shown.length,
    wordsWithContexts: new Set(usable.map((c) => c.lemma)).size,
    words: entries.size,
    learned: [...entries.values()].filter((e) => e.learned).length,
    approvedForWords,
    draftsNotReleased: drafts,
    shortage:
      available >= n
        ? null
        : {
            available,
            requested: n,
            message:
              available === 0
                ? "There are no approved vocabulary exercises ready for the words in your dictionary (no new sentences and no repeats due). Create some in Content Studio → Vocabulary (your coding agent writes and reviews them)."
                : `Only ${available} approved exercise(s) (new sentences and repeats) are ready for your words — fewer than the ${n} in your settings. You can start a shorter session or create more in Content Studio → Vocabulary.`,
          },
    activeSessionId: active?.id ?? null,
  };
}

/** the largest m <= max for which the picker returns m exercises (0 when none); the picks of that session come with it */
function largestFeasible(pick: (m: number) => ReturnType<typeof pickVocabulary>, max: number): { n: number; picks: ReturnType<typeof pickVocabulary> } {
  for (let m = max; m >= 1; m--) {
    const picks = pick(m);
    if (picks.length >= m) return { n: m, picks };
  }
  return { n: 0, picks: [] };
}

/**
 * A vocabulary practice session (purpose `practice`, category row in vocabulary_sessions written first). Same tables, reservations, lease,
 * attempts and events as grammar; no blueprint and no grammar evidence (assessments in these sessions write no skill opportunities).
 * `count` may ask for a shorter session when the stock is small; otherwise the setting decides. Never an empty or padded session.
 */
export function createVocabularySession(db: Db, deps: SessionDeps, req: { timezone: string; count?: number; seed?: string }): CreateSessionResponse {
  return db
    .transaction((): CreateSessionResponse => {
      try {
        localDateIn(req.timezone, deps.now());
      } catch {
        throw new ApiError(422, "TIMEZONE_INVALID", `Unknown time zone ${req.timezone}`);
      }
      const active = db.prepare("SELECT id FROM sessions WHERE status = 'active' LIMIT 1").get() as { id: string } | undefined;
      if (active) throw new ApiError(409, "SESSION_ACTIVE", "A session is already in progress: resume it or finish it first", { sessionId: active.id });
      const settings = loadSettings(db);
      const configured = vocabularyTaskCount(settings.values);
      const n = req.count !== undefined ? Math.max(1, Math.min(configured, Math.floor(req.count))) : configured;
      const { usable, shown } = vocabularyCandidates(db);
      const seed = req.seed ?? deps.newId();
      const newWords = vocabularyNewWordsPerSession(settings.values);
      const events = wordEvents(db);
      const picked = pickVocabulary({ fresh: usable, shown, events, now: deps.now(), n, seed, newWordsPerSession: newWords });
      if (picked.length < n || picked.length === 0) {
        const feasible = largestFeasible((m) => pickVocabulary({ fresh: usable, shown, events, now: deps.now(), n: m, seed, newWordsPerSession: newWords }), n - 1).n;
        throw new ApiError(409, "CONTENT_SHORTAGE", `Not enough approved vocabulary exercises (new sentences or repeats) for ${n} tasks`, { deficits: [{ kind: "vocabulary", needed: n, available: feasible, message: "Create more in Content Studio → Vocabulary" }], largestFeasibleN: feasible, requestedN: n });
      }
      const nowIso = deps.now().toISOString();
      const json = JSON.stringify(SELECTION_CONFIG);
      if (!db.prepare("SELECT 1 FROM algorithm_versions WHERE id = ?").get(VOCABULARY_SELECTION)) {
        db.prepare("INSERT INTO algorithm_versions(id, config_json, config_hash, source_version, created_at) VALUES (?,?,?,?,?)").run(VOCABULARY_SELECTION, json, sha256(json), "apps/server vocabulary/practice", nowIso);
      }
      const plan = loadPlan(db, deps);
      const sessionId = deps.newId();
      db.prepare(
        `INSERT INTO sessions(id, blueprint_revision_id, purpose, settings_revision_id, plan_id, selection_version, random_seed, status, created_at, timezone)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(sessionId, null, "practice", settings.id, plan.id, VOCABULARY_SELECTION, seed, "active", nowIso, req.timezone);
      db.prepare("INSERT INTO vocabulary_sessions(session_id, created_at) VALUES (?,?)").run(sessionId, nowIso); // before any activity (trigger)
      const insSlot = db.prepare("INSERT INTO session_slots(id, session_id, ordinal, exercise_revision_id, question_id, reading_group_id, input_preference, cohort_json) VALUES (?,?,?,?,?,?,?,?)");
      const reserve = db.prepare("INSERT INTO prompt_reservations(unit_id, slot_id, created_at) VALUES (?,?,?)");
      const choices = picked.map((p, i) => {
        const c = p.candidate;
        const slotId = deps.newId();
        // a repeat shows an already shown sentence: it reserves only units never exposed (answer sentences), so the ledger stays complete
        const repeatMeta = p.repeat ? { repeat: true, repeatOfSlotId: p.repeat.ofSlotId, reason: p.repeat.reason } : {};
        insSlot.run(slotId, sessionId, i, c.revisionId, null, null, "text", JSON.stringify({ criterionVersion: c.rubricVersion, difficulty: c.difficulty, role: "vocabulary", family: c.family, lemma: c.lemma, ...repeatMeta }));
        for (const u of p.repeat ? (c as ShownCandidate).unexposedUnits : c.units) reserve.run(u, slotId, nowIso);
        return { slotId, ordinal: i, revisionId: c.revisionId, lemma: c.lemma, family: c.family, repeat: p.repeat !== null, reason: p.repeat?.reason ?? null, state: p.state.state, streak: p.state.streak, priority: Math.round(p.state.priority * 1000) / 1000, dueAt: p.state.dueAt };
      });
      db.prepare("INSERT INTO scheduling_decisions(id, session_id, algorithm_id, candidate_hash, choices_json, deficits_json, created_at) VALUES (?,?,?,?,?,?,?)").run(
        deps.newId(),
        sessionId,
        VOCABULARY_SELECTION,
        sha256(JSON.stringify({ fresh: usable.map((c) => c.revisionId), shown: shown.map((c) => c.revisionId) })),
        JSON.stringify({ selectionVersion: VOCABULARY_SELECTION, seed, asOf: nowIso, settings: { revision: settings.revision, vocabularyTaskCount: configured, vocabularyNewWordsPerSession: newWords, requested: n }, slots: choices }),
        JSON.stringify({ soft: { familyMix: { target: FAMILY_WEIGHT, actual: Object.fromEntries(Object.keys(FAMILY_WEIGHT).map((f) => [f, picked.filter((p) => p.candidate.family === f).length])), repeats: picked.filter((p) => p.repeat).length } }, hard: [] }),
        nowIso,
      );
      return { sessionId, snapshot: getSnapshot(db, sessionId) };
    })
    .immediate();
}

/**
 * Content Studio → Vocabulary: per dictionary word, how many approved exercises exist, how many are still new (never shown or reserved),
 * how many were shown, and how many vocabulary revisions exist that are not approved and released (drafts, flagged, rejected).
 */
export function vocabularyCoverage(db: Db, now: Date = new Date()) {
  const entries = visibleEntries(db);
  const blocked = loadBlockedFingerprints(db);
  const units = unitsOf(db);
  const selectable = new Set((db.prepare("SELECT revision_id AS id FROM selectable_revisions").all() as Array<{ id: string }>).map((r) => r.id));
  const per = new Map<string, { lemma: string; entryId: string; learned: boolean; approved: number; available: number; shown: number; notReleased: number; families: Record<string, number> }>();
  for (const [lemma, e] of entries) per.set(lemma, { lemma, entryId: e.id, learned: e.learned, approved: 0, available: 0, shown: 0, notReleased: 0, families: { recognition: 0, guided_recall: 0, collocation: 0 } });
  let outside = 0;
  const released = new Set((db.prepare("SELECT exercise_id AS id FROM selectable_revisions").all() as Array<{ id: string }>).map((r) => r.id));
  for (const r of db.prepare("SELECT id, exercise_id AS ex, content_json AS c FROM exercise_revisions WHERE json_type(content_json, '$.vocabulary') IS NOT NULL").all() as Array<{ id: string; ex: string; c: string }>) {
    const m = VocabularyPracticeMetadataSchema.safeParse((JSON.parse(r.c) as { vocabulary?: unknown }).vocabulary);
    if (!m.success) continue;
    const w = per.get(normalizeWord(m.data.target.lemma));
    if (!w) {
      outside++;
      continue;
    }
    if (!selectable.has(r.id)) {
      if (!released.has(r.ex)) w.notReleased++; // replaced by a newer approved revision: history, not a draft
      continue;
    }
    w.approved++;
    const u = units.get(r.id) ?? [];
    if (u.length > 0 && u.every((x) => !blocked.has(x.fingerprint))) {
      w.available++;
      w.families[m.data.family]!++;
    } else w.shown++;
  }
  // scheduling facts per word (TASK_020 H): streak, recent misses, due now, fresh sentences left
  const events = wordEvents(db);
  const words = [...per.values()]
    .map((w) => {
      const st = wordState(w.lemma, events.get(w.lemma) ?? [], w.learned, now);
      return { ...w, streak: st.streak, recentMisses: st.recentMisses, dueNow: st.state !== "new" && st.due, freshLeft: w.available };
    })
    // words with misses and no fresh sentences left come first: they need new exercises most
    .sort((a, b) => Number(b.recentMisses > 0 && b.freshLeft === 0) - Number(a.recentMisses > 0 && a.freshLeft === 0) || a.available - b.available || a.lemma.localeCompare(b.lemma));
  const status = vocabularyPracticeStatus(db, now);
  return { words, exercisesForOtherWords: outside, sessionSize: status.taskCount, available: status.available, freshAvailable: status.freshAvailable, warning: status.shortage?.message ?? null };
}

/** read-only export for the coding agent that writes vocabulary exercises: the words, their meaning so far and what already exists */
export function exportVocabulary(db: Db, now: Date = new Date()): { json: unknown; markdown: string } {
  const cov = vocabularyCoverage(db, now);
  const meaning = db.prepare(
    `SELECT translation_ru AS tr, part_of_speech AS pos, example_en AS ex FROM vocabulary_revisions WHERE entry_id = ? ORDER BY (source = 'user') DESC, revision DESC LIMIT 1`,
  );
  const level = db.prepare("SELECT level FROM vocabulary_levels WHERE entry_id = ? ORDER BY created_at DESC LIMIT 1");
  const words = cov.words.map((w) => {
    const m = meaning.get(w.entryId) as { tr: string; pos: string; ex: string } | undefined;
    return { lemma: w.lemma, partOfSpeech: m?.pos || null, translationRu: m?.tr || null, cefrDraft: (level.get(w.entryId) as { level: string } | undefined)?.level ?? null, learned: w.learned, approvedExercises: w.approved, newExercises: w.available, shownExercises: w.shown, streak: w.streak, recentMisses: w.recentMisses, dueNow: w.dueNow, freshLeft: w.freshLeft, notReleased: w.notReleased, newByFamily: w.families };
  });
  const json = { schema_version: "vocabulary-export-v1", exportedAt: new Date().toISOString(), sessionSize: cov.sessionSize, availableNow: cov.freshAvailable, words };
  const nl = String.fromCharCode(10);
  const markdown = [
    "# Vocabulary for new exercises",
    "",
    `Session size ${cov.sessionSize}; new approved exercises now ${cov.freshAvailable}. Write new exercises first for words with misses and no fresh sentences (listed first). Translations and parts of speech are drafts or the learner's own text: check the sense yourself.`,
    "",
    "| word | POS | translation | CEFR (AI draft) | learned | new / shown / approved | streak / recent misses / due | not released |",
    "|---|---|---|---|---|---|---|---|",
    ...words.map((w) => `| ${w.lemma} | ${w.partOfSpeech ?? "?"} | ${w.translationRu ?? "?"} | ${w.cefrDraft ?? "?"} | ${w.learned ? "yes" : "no"} | ${w.newExercises} / ${w.shownExercises} / ${w.approvedExercises} | ${w.streak} / ${w.recentMisses} / ${w.dueNow ? "due" : "no"} | ${w.notReleased} |`),
  ].join(nl);
  return { json, markdown };
}
