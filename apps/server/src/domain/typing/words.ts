import type { Db } from "../../db/open.js";
import type { SettingsV1, TypingPlanWord, TypingSpeed, TypingWordsStartResponse } from "@english-lab/contracts";
import { ApiError } from "../../errors.js";
import { loadSettings } from "../sessions/policy.js";
import { currentTranslations, VISIBLE } from "../vocabulary/repository.js";
import { computeMetrics, METRICS_VERSION } from "./metrics.js";
import { buildTypingResult, sessionRow, type TypingSessionRow } from "./result.js";
import { computeSpeed, fallMs, type SpeedHistoryPoint } from "./speed.js";
import { awardTypingXp, typingXpForWords } from "./xp.js";

export interface WordsDeps {
  now: () => Date;
  newId: () => string;
  random?: () => number;
}

const rand = (deps: WordsDeps): (() => number) => deps.random ?? Math.random;

interface BankWord {
  lemma: string;
  part_of_speech: string;
  translation_ru: string;
  definition_ru: string;
  transcription: string;
  difficulty: number;
  char_count: number;
}

interface PersonalCandidate {
  id: string;
  lemma: string;
  learned: number;
  last: string | null;
}

function levelBucket(level: number): { difficultyMax: number; short: number; med: number; long: number; maxLen: number; restrict: boolean } {
  if (level <= 3) return { difficultyMax: 3, short: 0.6, med: 0.35, long: 0.05, maxLen: 10, restrict: true };
  if (level <= 7) return { difficultyMax: 4, short: 0.5, med: 0.4, long: 0.1, maxLen: 12, restrict: false };
  if (level <= 12) return { difficultyMax: 5, short: 0.45, med: 0.4, long: 0.15, maxLen: 14, restrict: false };
  return { difficultyMax: 5, short: 0.4, med: 0.4, long: 0.2, maxLen: Number.POSITIVE_INFINITY, restrict: false };
}

/** Distribute N into short/med/long using largest-remainder so the three always sum to exactly N. */
function bucketTargets(level: number, n: number): { short: number; med: number; long: number } {
  const b = levelBucket(level);
  const weights = [b.short, b.med, b.long];
  const exact = weights.map((w) => w * n);
  const floors = exact.map(Math.floor);
  let remaining = n - floors.reduce((a, x) => a + x, 0);
  const frac = exact.map((e, i) => ({ i, f: e - floors[i]! })).sort((a, b) => b.f - a.f);
  for (let k = 0; k < remaining; k++) floors[frac[k % frac.length]!.i]!++;
  return { short: floors[0]!, med: floors[1]!, long: floors[2]! };
}

const bucketOf = (len: number): "short" | "med" | "long" => (len <= 5 ? "short" : len <= 9 ? "med" : "long");

function shuffle<T>(arr: T[], r: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** personal entries, not removed, a single (possibly hyphenated) lowercase word, with the priority: learned=0 first, then longest-unseen, ties random. */
function personalCandidates(db: Db, level: number, deps: WordsDeps): PersonalCandidate[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.lemma, e.learned,
              (SELECT MAX(w.shown_at) FROM typing_words w WHERE w.vocabulary_entry_id = e.id) AS last
         FROM vocabulary_entries e
        WHERE (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = e.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'`,
    )
    .all() as Array<{ id: string; lemma: string; learned: number; last: string | null }>;
  const maxLen = level <= 3 ? 12 : Number.POSITIVE_INFINITY;
  const candidates = rows.filter((r) => /^[a-z]+(-[a-z]+)?$/.test(r.lemma) && r.lemma.length <= maxLen && r.lemma.length <= 32);
  // shuffle first, then stable-sort by (learned, last): ties keep their random order
  shuffle(candidates, rand(deps)).sort((a, b) => {
    if (a.learned !== b.learned) return a.learned - b.learned;
    if ((a.last === null) !== (b.last === null)) return a.last === null ? -1 : 1;
    if (a.last !== null && b.last !== null && a.last !== b.last) return a.last < b.last ? -1 : 1;
    return 0;
  });
  // a word without a translation is dropped: it cannot be a target with a translation (D77)
  const ids = candidates.map((c) => c.id);
  const translations = currentTranslations(db, ids);
  return candidates.filter((c) => translations.has(c.id));
}

function bankWords(db: Db, level: number): BankWord[] {
  const b = levelBucket(level);
  const maxLen = b.maxLen === Number.POSITIVE_INFINITY ? 32 : b.maxLen;
  const rows = db
    .prepare("SELECT lemma, part_of_speech, translation_ru, definition_ru, transcription, difficulty, char_count FROM typing_word_bank WHERE difficulty <= ? AND char_count >= 3 AND char_count <= ?")
    .all(b.difficultyMax, maxLen) as BankWord[];
  if (!b.restrict) return rows;
  const hasAtMostOneRare = (w: string) => (w.match(/[qjzx]/g) ?? []).length <= 1;
  const noTriple = (w: string) => !/([a-z])\1\1/.test(w);
  return rows.filter((r) => hasAtMostOneRare(r.lemma) && noTriple(r.lemma));
}

export interface WordsPlan {
  level: number;
  words: TypingPlanWord[];
  speed: TypingSpeed;
}

function wordsHistory(db: Db): { points: SpeedHistoryPoint[]; previousEstimate: number | null } {
  const rows = db
    .prepare("SELECT status, chars_correct, active_ms, plan_json FROM typing_sessions WHERE mode = 'words' AND status <> 'active' ORDER BY ended_at ASC")
    .all() as Array<{ status: string; chars_correct: number | null; active_ms: number; plan_json: string | null }>;
  const points = rows.map((r) => ({ status: (r.status === "failed" ? "failed" : "completed") as "completed" | "failed", charsCorrect: r.chars_correct ?? 0, activeMs: r.active_ms }));
  let previousEstimate: number | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (!r.plan_json) continue;
    try {
      const plan = JSON.parse(r.plan_json) as { speed?: { estimateWpm?: number } };
      if (typeof plan.speed?.estimateWpm === "number") {
        previousEstimate = plan.speed.estimateWpm;
        break;
      }
    } catch {
      /* ignore malformed plan */
    }
  }
  return { points, previousEstimate };
}

/** Next Words level = one above the highest completed level (derived, nothing stored). */
export function wordsNextLevel(db: Db): number {
  const r = db.prepare("SELECT COALESCE(MAX(level_number), 0) AS n FROM typing_sessions WHERE mode = 'words' AND status = 'completed'").get() as { n: number };
  return r.n + 1;
}

export function buildWordsPlan(db: Db, level: number, settings: SettingsV1, deps: WordsDeps): WordsPlan {
  const n = settings.typingWordsPerLevel ?? 30;
  const share = settings.typingVocabularyShare ?? 0.3;
  const quota = Math.round(n * share);

  const personal = personalCandidates(db, level, deps);
  const translations = currentTranslations(db, personal.map((p) => p.id));
  const personalWords: Array<{ lemma: string; source: "vocabulary"; vocabularyEntryId: string }> = personal.slice(0, quota).map((p) => ({
    lemma: p.lemma,
    source: "vocabulary" as const,
    vocabularyEntryId: p.id,
  }));

  const targets = bucketTargets(level, n);
  const personalIn = { short: 0, med: 0, long: 0 };
  for (const w of personalWords) personalIn[bucketOf(w.lemma.length)]++;

  const generalCount = n - personalWords.length;
  const need = {
    short: Math.max(0, targets.short - personalIn.short),
    med: Math.max(0, targets.med - personalIn.med),
    long: Math.max(0, targets.long - personalIn.long),
  };
  // if personal words overflowed a bucket, shift the shortfall to the other buckets
  let deficit = generalCount - (need.short + need.med + need.long);
  const order = ["short", "med", "long"] as const;
  let k = 0;
  while (deficit > 0) {
    need[order[k % 3]!]!++;
    deficit--;
    k++;
  }

  const bank = shuffle(bankWords(db, level), rand(deps));
  const takenLemmas = new Set(personalWords.map((w) => w.lemma));
  const pool = { short: [] as BankWord[], med: [] as BankWord[], long: [] as BankWord[] };
  for (const b of bank) {
    if (takenLemmas.has(b.lemma)) continue;
    pool[bucketOf(b.char_count)].push(b);
  }

  const generalWords: Array<{ lemma: string; source: "general"; vocabularyEntryId: null }> = [];
  for (const bucket of order) {
    const take = pool[bucket].slice(0, need[bucket]);
    if (take.length < need[bucket]) {
      // fall back to neighbouring buckets when a bucket runs dry (spec 5.1)
      throw new ApiError(409, "TYPING_BANK_EMPTY", "Not enough words in the typing word bank for this level; run the typing seed first.");
    }
    for (const w of take) {
      generalWords.push({ lemma: w.lemma, source: "general", vocabularyEntryId: null });
      takenLemmas.add(w.lemma);
    }
  }

  if (generalWords.length < generalCount) {
    throw new ApiError(409, "TYPING_BANK_EMPTY", "Not enough words in the typing word bank for this level; run the typing seed first.");
  }

  const history = wordsHistory(db);
  const speed = computeSpeed(history.points, { multiplier: settings.typingSpeedMultiplier ?? 1.05, previousEstimate: history.previousEstimate });

  const planWords: TypingPlanWord[] = [...personalWords, ...generalWords]
    .map((w, i) => {
      const isVocab = w.source === "vocabulary";
      const entryId = isVocab ? (w as { vocabularyEntryId: string }).vocabularyEntryId : null;
      return {
        planIndex: i,
        lemma: w.lemma,
        source: w.source,
        vocabularyEntryId: entryId,
        translationRu: isVocab && entryId ? (translations.get(entryId) ?? null) : null,
        partOfSpeech: null,
        definitionRu: null,
        transcription: null,
        unverified: !isVocab,
        fallMs: fallMs(w.lemma.length, speed.msPerChar),
      };
    })
    .sort(() => rand(deps)() - 0.5);

  // reindex after shuffle so planIndex is stable and dense
  planWords.forEach((w, i) => (w.planIndex = i));

  // fill vocabulary lexicon facts (definition + transcription) for personal words
  const lexFor = (entryId: string | null) =>
    entryId ? ((db.prepare("SELECT transcription, definition_ru AS d FROM vocabulary_lexicon WHERE entry_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(entryId)) as { transcription: string; d: string } | undefined) : undefined;
  for (const w of planWords) {
    if (w.source === "vocabulary" && w.vocabularyEntryId) {
      const lex = lexFor(w.vocabularyEntryId);
      if (lex) {
        w.transcription = lex.transcription || null;
        w.definitionRu = lex.d || null;
      }
    } else if (w.source === "general") {
      const b = bank.find((x) => x.lemma === w.lemma);
      if (b) {
        w.translationRu = b.translation_ru;
        w.partOfSpeech = b.part_of_speech || null;
        w.definitionRu = b.definition_ru || null;
        w.transcription = b.transcription || null;
      }
    }
  }

  return { level, words: planWords, speed };
}

export function wordsOverview(db: Db): { nextLevel: number; completedLevel: number; activeSessionId: string | null; bankWords: number } {
  const active = db.prepare("SELECT id FROM typing_sessions WHERE mode = 'words' AND status = 'active' LIMIT 1").get() as { id: string } | undefined;
  const completed = db.prepare("SELECT COALESCE(MAX(level_number), 0) AS n FROM typing_sessions WHERE mode = 'words' AND status = 'completed'").get() as { n: number };
  const bank = db.prepare("SELECT COUNT(*) AS n FROM typing_word_bank").get() as { n: number };
  return { nextLevel: completed.n + 1, completedLevel: completed.n, activeSessionId: active?.id ?? null, bankWords: bank.n };
}

export function startWords(db: Db, deps: WordsDeps): TypingWordsStartResponse {
  const settings = loadSettings(db);
  // any leftover active Words session is interrupted before a new level starts (D80: no mid-level restore for Words)
  const active = db.prepare("SELECT id FROM typing_sessions WHERE mode = 'words' AND status = 'active' LIMIT 1").get() as { id: string } | undefined;
  if (active) {
    db.prepare("UPDATE typing_sessions SET status = 'interrupted', ended_at = ? WHERE id = ?").run(deps.now().toISOString(), active.id);
  }
  const level = wordsNextLevel(db);
  const plan = buildWordsPlan(db, level, settings.values, deps);
  const id = deps.newId();
  const now = deps.now().toISOString();
  db.prepare(
    "INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at) VALUES (?, 'words', 'active', ?, ?, ?, ?, ?)",
  ).run(id, level, settings.revision, JSON.stringify(settings.values), JSON.stringify(plan), now);

  return {
    sessionId: id,
    level,
    targetCount: plan.words.length,
    words: plan.words,
    speed: plan.speed,
  };
}

export function recordAppearances(db: Db, deps: WordsDeps, sessionId: string, appearances: Array<{ planIndex: number; order: number }>): { ok: true } {
  const row = sessionRow(db, sessionId);
  if (row.mode !== "words") throw new ApiError(409, "TYPING_SESSION_WRONG_MODE", "Not a words session");
  if (row.status !== "active") throw new ApiError(409, "TYPING_SESSION_FINISHED", "This session is already finished");
  const plan = JSON.parse(row.plan_json ?? "{}") as { words?: TypingPlanWord[] };
  const words = plan.words ?? [];
  const now = deps.now().toISOString();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO typing_words(id, session_id, plan_index, appearance_order, lemma, source, vocabulary_entry_id, shown_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (const a of appearances) {
      const w = words[a.planIndex];
      if (!w) throw new ApiError(400, "TYPING_INDEX_INVALID", `planIndex ${a.planIndex} is outside the plan`);
      ins.run(deps.newId(), sessionId, a.planIndex, a.order, w.lemma, w.source, w.vocabularyEntryId, now);
    }
  }).immediate();
  return { ok: true };
}

export interface WordsCompleteRequest {
  status: "completed" | "failed";
  activeMs: number;
  charsTyped: number;
  errors: number;
  appearances: Array<{ planIndex: number; order: number }>;
  destroyedPlanIndexes: number[];
}

export function completeWords(db: Db, deps: WordsDeps, sessionId: string, req: WordsCompleteRequest): ReturnType<typeof buildTypingResult> {
  const row = sessionRow(db, sessionId);
  if (row.mode !== "words") throw new ApiError(409, "TYPING_SESSION_WRONG_MODE", "Not a words session");
  if (row.status !== "active") return buildTypingResult(db, row); // idempotent: return the saved result

  // lost appearances are cheap to restore; validate the re-sent full set
  recordAppearances(db, deps, sessionId, req.appearances);

  const plan = JSON.parse(row.plan_json ?? "{}") as { words?: TypingPlanWord[] };
  const words = plan.words ?? [];
  const destroyedSet = new Set(req.destroyedPlanIndexes);
  if (destroyedSet.size !== req.destroyedPlanIndexes.length) throw new ApiError(400, "TYPING_INDEX_DUPLICATE", "destroyedPlanIndexes must be unique");
  for (const i of req.destroyedPlanIndexes) {
    if (!words[i]) throw new ApiError(400, "TYPING_INDEX_INVALID", `destroyedPlanIndexes ${i} is outside the plan`);
  }
  if (req.status === "completed" && destroyedSet.size !== words.length) {
    throw new ApiError(400, "TYPING_INCOMPLETE", "A completed Words level must destroy exactly all planned words");
  }
  const charsCorrect = [...destroyedSet].reduce((sum, i) => sum + words[i]!.lemma.length, 0);
  if (req.charsTyped - req.errors < charsCorrect) {
    throw new ApiError(400, "TYPING_COUNTERS_INVALID", "charsTyped minus errors cannot be below charsCorrect");
  }

  const metrics = computeMetrics({ mode: "words", activeMs: req.activeMs, charsTyped: req.charsTyped, errors: req.errors, charsCorrect, level: row.level_number, completed: req.status === "completed" });
  const xp = req.status === "completed" ? typingXpForWords(destroyedSet.size) : 0;
  const now = deps.now().toISOString();

  db.transaction(() => {
    for (const i of destroyedSet) {
      db.prepare("UPDATE typing_words SET destroyed_at = ? WHERE session_id = ? AND plan_index = ? AND destroyed_at IS NULL").run(now, sessionId, i);
    }
    db.prepare(
      "UPDATE typing_sessions SET status = ?, ended_at = ?, active_ms = ?, chars_typed = ?, errors = ?, chars_correct = ?, wpm = ?, cpm = ?, accuracy = ?, score = ?, metrics_version = ? WHERE id = ?",
    ).run(req.status, now, req.activeMs, req.charsTyped, req.errors, charsCorrect, metrics.wpm, metrics.cpm, metrics.accuracy, metrics.score, METRICS_VERSION, sessionId);
    if (xp > 0) awardTypingXp(db, { id: deps.newId(), sessionId, amount: xp, at: now });
  }).immediate();

  return buildTypingResult(db, sessionRow(db, sessionId));
}

export function abortWords(db: Db, deps: WordsDeps, sessionId: string, req: { activeMs?: number; charsTyped?: number; errors?: number }): { ok: true } {
  const row = sessionRow(db, sessionId);
  if (row.mode !== "words") throw new ApiError(409, "TYPING_SESSION_WRONG_MODE", "Not a words session");
  if (row.status !== "active") return { ok: true };
  db.prepare("UPDATE typing_sessions SET status = 'interrupted', ended_at = ?, active_ms = ?, chars_typed = ?, errors = ? WHERE id = ?").run(
    deps.now().toISOString(),
    req.activeMs ?? row.active_ms,
    req.charsTyped ?? row.chars_typed,
    req.errors ?? row.errors,
    sessionId,
  );
  return { ok: true };
}
