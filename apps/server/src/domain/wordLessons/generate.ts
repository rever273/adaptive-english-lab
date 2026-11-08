import { createHash } from "node:crypto";
import { WORD_LESSON_MAX_COUNT, difficultyLevels, type WordLessonStudioStatus } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { enqueue } from "../../queue/jobs.js";
import { loadSettings } from "../sessions/policy.js";
import { buildPlan, loadSkillPool } from "./plan.js";
import { clampCount, defaultCount, eligibleWords, lessonStates, wordLessonCoverage, type EligibleWord } from "./selection.js";
import type { SenseSnapshot } from "./runner.js";

export interface WordLessonDeps {
  now: () => Date;
  newId: () => string;
}

/** The word facts a lesson is written from, frozen with the lesson (the dictionary may change later; the lesson stays as it was written). */
export function senseOf(db: Db, w: EligibleWord): SenseSnapshot {
  const lex = db.prepare("SELECT definition_ru AS d, synonyms_json AS s, irregular_forms_json AS i FROM vocabulary_lexicon WHERE entry_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(w.entryId) as { d: string; s: string; i: string } | undefined;
  const rev = db.prepare("SELECT part_of_speech AS p FROM vocabulary_revisions WHERE entry_id = ? AND part_of_speech <> '' ORDER BY revision DESC LIMIT 1").get(w.entryId) as { p: string } | undefined;
  return {
    translationRu: w.translationRu,
    definitionRu: lex?.d ?? "",
    pos: w.pos !== "unknown" ? w.pos : (rev?.p ?? "unknown"),
    synonyms: lex ? (JSON.parse(lex.s) as string[]) : [],
    surfaceForms: w.surfaceForms,
    irregularForms: lex ? (JSON.parse(lex.i) as string[]) : [],
  };
}

const seedOf = (id: string): number => parseInt(createHash("sha256").update(id).digest("hex").slice(0, 7), 16);

/** the failed lessons with the last reviewer remarks saved in their job (a stage that could not be written has none) */
function failuresOf(db: Db, failedEntries: readonly string[]): WordLessonStudioStatus["failures"] {
  return failedEntries.flatMap((entryId) => {
    const l = db.prepare("SELECT id, lemma, error_code AS code FROM word_lessons WHERE entry_id = ? AND status <> 'ready'").get(entryId) as { id: string; lemma: string; code: string | null } | undefined;
    if (!l) return [];
    const job = db.prepare("SELECT checkpoint_json AS c, error_code AS jobCode FROM jobs WHERE json_extract(payload_json, '$.wordLessonId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(l.id) as { c: string; jobCode: string | null } | undefined;
    let remarks: string[] = [];
    try {
      const notes = (JSON.parse(job?.c ?? "{}") as { notes?: Record<string, string[]> }).notes ?? {};
      remarks = Object.values(notes).flat().slice(-4).map((x) => String(x).slice(0, 300));
    } catch {
      /* no remarks */
    }
    return [{ lemma: l.lemma, code: l.code ?? job?.jobCode ?? null, remarks }];
  });
}

export function studioStatus(db: Db, now: Date): WordLessonStudioStatus {
  const c = wordLessonCoverage(db, now);
  const lv = difficultyLevels(loadSettings(db).values);
  return {
    ready: c.ready,
    eligible: c.eligible,
    waitingTranslation: c.waitingTranslation,
    candidates: c.candidates.length,
    defaultCount: defaultCount(c.candidates.length),
    maxCount: WORD_LESSON_MAX_COUNT,
    generating: c.generating,
    failed: c.failed,
    failures: failuresOf(db, c.retryable),
    disputed: (db.prepare("SELECT COUNT(*) AS n FROM word_lesson_verdicts v WHERE v.verdict = 'disputed'").get() as { n: number }).n,
    difficulty: { min: lv?.[0] ?? "A2", max: lv?.[lv.length - 1] ?? "C2" },
  };
}

const jobFor = (db: Db, deps: WordLessonDeps, lessonId: string, attempt: number) =>
  enqueue(db, deps, { kind: "generation", priority: 3, payload: { wordLessonId: lessonId, attempt }, idempotencyKey: `word-lesson:${lessonId}:${attempt}` });

/**
 * Creates the lesson rows (status `generating`, nothing visible to the learner yet) for the best candidates and queues one job per lesson.
 * Words that already have a lesson, or one being written, are never touched.
 */
export function startGeneration(db: Db, deps: WordLessonDeps, count: number): { created: number } {
  const n = clampCount(count);
  const now = deps.now();
  const coverage = wordLessonCoverage(db, now);
  const chosen = coverage.candidates.slice(0, n);
  if (chosen.length === 0) throw new ApiError(409, "NO_WORDS_TO_PREPARE", "Every word already has a lesson, or is waiting for a translation.");
  const settings = loadSettings(db);
  const pool = loadSkillPool(db, now.toISOString());
  const already = (db.prepare("SELECT COUNT(*) AS n FROM word_lessons").get() as { n: number }).n;
  db.transaction(() => {
    chosen.forEach((w, i) => {
      const id = deps.newId();
      const plan = buildPlan(settings.values, pool, already + i, seedOf(id));
      db.prepare("INSERT INTO word_lessons(id, entry_id, lemma, sense_json, plan_json, status, generation_attempt, settings_revision, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
        id,
        w.entryId,
        w.lemma,
        JSON.stringify(senseOf(db, w)),
        JSON.stringify(plan),
        "generating",
        1,
        settings.revision,
        now.toISOString(),
      );
      jobFor(db, deps, id, 1);
    });
  }).immediate();
  return { created: chosen.length };
}

/** Failed lessons (or ones whose job is gone) get one more try: the attempt number grows so the old failed job is not returned for the key. */
export function retryFailed(db: Db, deps: WordLessonDeps): { queued: number } {
  const states = lessonStates(db);
  const { eligible } = eligibleWords(db);
  const byEntry = new Map(eligible.map((w) => [w.entryId, w]));
  const rows = [...states.failed].flatMap((entryId) => {
    const w = byEntry.get(entryId);
    const r = db.prepare("SELECT id, generation_attempt AS a FROM word_lessons WHERE entry_id = ? AND status <> 'ready'").get(entryId) as { id: string; a: number } | undefined;
    return w && r ? [{ w, ...r }] : [];
  });
  db.transaction(() => {
    for (const r of rows) {
      db.prepare("UPDATE word_lessons SET status = 'generating', generation_attempt = ?, error_code = NULL WHERE id = ? AND status <> 'ready'").run(r.a + 1, r.id);
      jobFor(db, deps, r.id, r.a + 1);
    }
  }).immediate();
  return { queued: rows.length };
}
