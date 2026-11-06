import type { DictationAnalytics } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { localDateIn } from "../../attempts/canonical.js";
import { dictationAccuracy } from "./check.js";
import { exerciseCoefficient } from "./lessons.js";
import { cpmOf, wpmOf } from "./result.js";
import { classifyAnswer, errorTypeSummary } from "./errorTypes.js";
import type { VoiceListing } from "../../voices/service.js";

export interface DictationAnalyticsInput {
  days: number | null;
  timezone: string;
  now: Date;
  /** the voices in use, for the voice balance table */
  voices?: readonly VoiceListing[];
}

/** a voice is shown only with at least this many exercises */
export const VOICE_MIN_EXERCISES = 20;

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const mean = (xs: number[]): number | null => (xs.length > 0 ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

function dateList(days: number | null, timezone: string, now: Date, minDate: string | null): string[] {
  if (days !== null) return Array.from({ length: days }, (_, k) => localDateIn(timezone, new Date(now.getTime() - (days - 1 - k) * 86_400_000)));
  if (!minDate) return [];
  const out: string[] = [];
  const end = new Date(`${localDateIn(timezone, now)}T00:00:00`);
  for (let d = new Date(`${minDate}T00:00:00`); d <= end; d = new Date(d.getTime() + 86_400_000)) out.push(localDateIn(timezone, d));
  return out;
}

interface ExerciseFacts {
  exerciseId: string;
  voice: string | null;
  source: string;
  correctAt: string;
  wordCount: number;
  firstCorrect: boolean;
  firstWordErrors: number;
  hintLevel: number;
  translationSeen: boolean;
  manualReplays: number;
  chars: number;
  typingMs: number;
  typedChars: number;
  hints: number;
  textEn: string;
  firstAnswer: string;
}

/** Deterministic, from the raw attempts and events. Averages are over exercises, not over lessons; an open lesson counts its exercises by the date of the correct answer. */
export function dictationAnalytics(db: Db, input: DictationAnalyticsInput): DictationAnalytics {
  const { timezone } = input;
  const facts = (
    db
      .prepare(
        `SELECT e.id AS exerciseId, e.voice_name AS voice, e.source AS source, c.created_at AS correctAt, e.word_count AS wordCount,
                c.hint_level AS hintLevel, c.translation_seen AS translationSeen,
                f.correct AS firstCorrect, f.word_errors AS firstWordErrors, length(c.answer_text) AS chars,
                (SELECT COALESCE(SUM(t.typing_ms), 0) FROM typing_dictation_attempts t WHERE t.exercise_id = e.id) AS typingMs,
                (SELECT COALESCE(SUM(length(t.answer_text)), 0) FROM typing_dictation_attempts t WHERE t.exercise_id = e.id) AS typedChars,
                (SELECT COUNT(*) FROM typing_dictation_events h WHERE h.exercise_id = e.id AND h.kind = 'hint') AS hints,
                e.text_en AS textEn, f.answer_text AS firstAnswer,
                (SELECT COUNT(*) FROM typing_dictation_events v WHERE v.exercise_id = e.id AND v.kind = 'play' AND v.source = 'manual') AS manualReplays
           FROM typing_dictation_exercises e
           JOIN typing_dictation_attempts c ON c.exercise_id = e.id AND c.correct = 1
           JOIN typing_dictation_attempts f ON f.exercise_id = e.id AND f.attempt_no = 1
          ORDER BY c.created_at`,
      )
      .all() as Array<Omit<ExerciseFacts, "firstCorrect" | "translationSeen"> & { firstCorrect: number; translationSeen: number }>
  ).map((r) => ({ ...r, firstCorrect: r.firstCorrect === 1, translationSeen: r.translationSeen === 1, date: localDateIn(timezone, new Date(r.correctAt)) }));
  const lessons = (db.prepare("SELECT id, completed_at AS completedAt, active_ms AS activeMs FROM typing_dictation_lessons WHERE status = 'completed' ORDER BY completed_at").all() as Array<{ id: string; completedAt: string; activeMs: number }>).map((l) => ({ ...l, date: localDateIn(timezone, new Date(l.completedAt)) }));

  const minDate = [facts[0]?.date, lessons[0]?.date].filter((d): d is string => !!d).sort()[0] ?? null;
  const dates = dateList(input.days, timezone, input.now, minDate);
  const inWindow = new Set(dates);
  const windowFacts = input.days === null ? facts : facts.filter((f) => inWindow.has(f.date));
  const windowLessons = input.days === null ? lessons : lessons.filter((l) => inWindow.has(l.date));

  const n = windowFacts.length;
  const noHelp = windowFacts.filter((f) => exerciseCoefficient(db, f.exerciseId) === 1).length;
  const hint = { none: 0, level1: 0, level2: 0, level3: 0 };
  for (const f of windowFacts) {
    if (f.hintLevel === 0) hint.none++;
    else if (f.hintLevel === 1) hint.level1++;
    else if (f.hintLevel === 2) hint.level2++;
    else hint.level3++;
  }

  const daily = dates.map((date) => ({
    date,
    lessons: lessons.filter((l) => l.date === date).length,
    exercises: facts.filter((f) => f.date === date).length,
    activeSeconds: Math.round(lessons.filter((l) => l.date === date).reduce((a, l) => a + l.activeMs, 0) / 1000),
  }));

  const series = windowLessons.map((l) => {
    const own = db.prepare("SELECT e.id AS id FROM typing_dictation_exercises e WHERE e.lesson_id = ?").all(l.id) as Array<{ id: string }>;
    const ids = new Set(own.map((o) => o.id));
    const mine = facts.filter((f) => ids.has(f.exerciseId));
    return {
      at: l.completedAt,
      score: Math.round((100 * mine.reduce((a, f) => a + exerciseCoefficient(db, f.exerciseId), 0)) / Math.max(1, mine.length)),
      firstAttemptAccuracy: pct(mine.filter((f) => f.firstCorrect).length, mine.length) ?? 0,
      wpm: wpmOf(mine.reduce((a, f) => a + f.chars, 0), mine.reduce((a, f) => a + f.typingMs, 0)),
      independent: pct(mine.filter((f) => exerciseCoefficient(db, f.exerciseId) === 1).length, mine.length) ?? 0,
      replays: mean(mine.map((f) => f.manualReplays)),
      hints: mean(mine.map((f) => f.hints)),
    };
  });

  const byVoice = new Map<string, ExerciseFactsWithDate[]>();
  for (const f of windowFacts) if (f.source === "tts" && f.voice) byVoice.set(f.voice, [...(byVoice.get(f.voice) ?? []), f]);
  const voices = [...byVoice.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, fs]) => {
      const enough = fs.length >= VOICE_MIN_EXERCISES;
      return {
        name,
        exercises: fs.length,
        enoughData: enough,
        firstAttemptAccuracy: enough ? pct(fs.filter((f) => f.firstCorrect).length, fs.length) : null,
        avgManualReplays: enough ? mean(fs.map((f) => f.manualReplays)) : null,
        hintRate: enough ? pct(fs.filter((f) => f.hintLevel > 0).length, fs.length) : null,
      };
    });

  return {
    window: { days: input.days, timezone },
    summary: {
      lessons: windowLessons.length,
      exercises: n,
      totalActiveMs: windowLessons.reduce((a, l) => a + l.activeMs, 0),
      firstAttemptAccuracy: pct(windowFacts.filter((f) => f.firstCorrect).length, n),
      noHelpRate: pct(noHelp, n),
      avgManualReplays: mean(windowFacts.map((f) => f.manualReplays)),
      dictationAccuracy: n > 0 ? Math.round((windowFacts.reduce((a, f) => a + dictationAccuracy(f.firstWordErrors, f.wordCount), 0) / n) * 1000) / 10 : null,
      translationUsedRate: pct(windowFacts.filter((f) => f.translationSeen).length, n),
      avgWpm: wpmOf(windowFacts.reduce((a, f) => a + f.chars, 0), windowFacts.reduce((a, f) => a + f.typingMs, 0)),
      bestWpm: series.reduce<number | null>((best, p) => (p.wpm !== null && (best === null || p.wpm > best) ? p.wpm : best), null),
      avgCpm: cpmOf(windowFacts.reduce((a, f) => a + f.chars, 0), windowFacts.reduce((a, f) => a + f.typingMs, 0)),
      typingTotalMs: windowFacts.reduce((a, f) => a + f.typingMs, 0),
      totalChars: windowFacts.reduce((a, f) => a + f.typedChars, 0),
      bestScore: series.reduce<number | null>((best, p) => (best === null || p.score > best ? p.score : best), null),
      avgHints: mean(windowFacts.map((f) => f.hints)),
      hintUsage: hint,
    },
    daily,
    series,
    voices,
    // mistakes of the first answers only; an answer that was right the first time has none
    errorTypes: errorTypeSummary(windowFacts.filter((f) => !f.firstCorrect).flatMap((f) => classifyAnswer(f.textEn, f.firstAnswer))),
    voiceBalance: voiceBalance(input.voices ?? []),
  };
}

function voiceBalance(voices: readonly VoiceListing[]): DictationAnalytics["voiceBalance"] {
  return voices.map((v) => ({
    name: v.name,
    ageGroup: v.ageGroup,
    checks: v.checks,
    heardRate: v.heardRate === null ? null : Math.round(v.heardRate * 1000) / 10,
    weight: v.weight.effective,
    share: Math.round(v.share * 1000) / 10,
    flags: v.flags,
    enabled: v.enabled,
  }));
}

type ExerciseFactsWithDate = ExerciseFacts & { date: string };
