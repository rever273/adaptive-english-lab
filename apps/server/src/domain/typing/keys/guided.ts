/**
 * Key Builder lesson logic, taken from keybr.com (AGPL-3.0, see content/typing/keybr/LICENSE): keybr-result/lib/keystats.ts
 * (smoothed time per key), keybr-lesson/lib/{guided,key,target,learningrate,learningsession,dailygoal}.ts.
 * Everything here is derived from the raw per-lesson rows on every call; nothing derived is stored.
 */
import { polynomialRegression, r2, type Polynomial } from "./regression.js";

/**
 * exponential smoothing of a key's time per lesson (keybr makeFilter(0.1)). keybr starts the filter at the first lesson, so a slow
 * warm-up lesson keeps ~40% of the weight after ten lessons; here the first WARMUP_LESSONS samples are a plain mean (alpha = 1/n)
 * and the filter goes on from it with alpha 0.1.
 */
export const SMOOTHING_ALPHA = 0.1;
export const WARMUP_LESSONS = 10;
/** default: a key counts as reached only with at most 5% wrong presses */
export const DEFAULT_MIN_ACCURACY = 0.95;
/** how fast readiness falls with errors above the limit: 5 points of extra error rate cost a quarter */
const ERROR_PENALTY = 5;
/**
 * A key meets only 10-40 times in a lesson, so one wrong press moves its error rate by several points. A key is held back for
 * accuracy only when its error rate is above the limit beyond chance: the lower Wilson bound at z = 1 (about 84% one-sided) of the
 * press-weighted smoothed rate must be above the limit.
 */
export const ERROR_Z = 1;

/** lower Wilson score bound of a share p observed over n trials */
export function wilsonLower(p: number, n: number, z = ERROR_Z): number {
  if (n <= 0) return 0;
  const z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n));
}
const alphaAt = (n: number): number => Math.max(SMOOTHING_ALPHA, 1 / n);
/** letters open from the start */
export const MIN_KEYS = 6;
/** a key counts as reached only after this many timed lessons with it, so one good lesson with a new key does not open the next one */
export const MIN_KEY_LESSONS = 3;
/** a lesson's per-key mean outside this range says nothing (keybr validateSample: 300 WPM .. 1 WPM) */
export const MIN_KEY_MS = 40;
export const MAX_KEY_MS = 12000;
/** keybr default target: 175 characters per minute = 35 WPM */
export const DEFAULT_TARGET_CPM = 175;
/** keybr default daily goal, minutes */
export const DEFAULT_DAILY_GOAL_MIN = 30;

export const speedToTime = (cpm: number): number => 60000 / cpm;
export const timeToSpeed = (ms: number): number => 60000 / ms;

/** one finished lesson's facts about one key: correct presses, wrong presses, mean ms of the clean presses (0 = none timed) */
export interface KeyLessonRow {
  /** order of the lesson among all Key Builder lessons (0-based); the same for every key of one lesson */
  lessonIndex: number;
  /** lesson end, epoch ms */
  at: number;
  /** how many letters were open in that lesson (more keys = harder, so its errors weigh more); missing = weight 1 */
  openKeys?: number;
  letter: string;
  hits: number;
  misses: number;
  meanMs: number;
}

/**
 * Weight of one lesson's presses in a key's error rate: the lesson's open keys over the most keys open so far. A miss made with
 * 6 keys open says less about typing all 26 than one made with 20 open, so early easy lessons fade by difficulty as well as by age.
 */
export const difficultyWeight = (openKeys: number | undefined, mostOpen: number): number =>
  openKeys && mostOpen > 0 ? Math.min(1, openKeys / mostOpen) : 1;

export interface KeySample {
  index: number;
  at: number;
  hits: number;
  misses: number;
  timeToType: number;
  filteredTimeToType: number;
}

export interface KeyStats {
  letter: string;
  samples: KeySample[];
  /** latest smoothed time per press, ms */
  timeToType: number | null;
  /** best smoothed time ever reached, ms */
  bestTimeToType: number | null;
  /**
   * smoothed share of wrong presses: wrong and all presses are each summed with the weight 0.9 per later lesson with the key times
   * difficultyWeight (open keys then / most open keys now), so a lesson counts by its number of presses (one miss in 15 presses
   * weighs less than in 40), by recency and by how many keys were in play; null before any press
   */
  errorRate: number | null;
  /** the smoothed number of presses behind errorRate (how much evidence it has) */
  errorPresses: number;
  /** the smoothed wrong presses (errorRate = errorMisses / errorPresses) */
  errorMisses: number;
  /** the lower bound of errorRate allowing for chance (wilsonLower): this is what is judged; null before any press */
  errorBound: number | null;
}

export function keyStats(letter: string, rows: readonly KeyLessonRow[]): KeyStats {
  const samples: KeySample[] = [];
  let filtered: number | null = null;
  let best: number | null = null;
  let misses = 0;
  let presses = 0;
  const mostOpen = rows.reduce((a, r) => Math.max(a, r.openKeys ?? 0), 0);
  for (const r of [...rows].filter((x) => x.letter === letter).sort((a, b) => a.lessonIndex - b.lessonIndex)) {
    if (r.hits + r.misses > 0) {
      const w = difficultyWeight(r.openKeys, mostOpen);
      misses = (1 - SMOOTHING_ALPHA) * misses + w * r.misses;
      presses = (1 - SMOOTHING_ALPHA) * presses + w * (r.hits + r.misses);
    }
    if (!(r.meanMs >= MIN_KEY_MS && r.meanMs <= MAX_KEY_MS)) continue;
    const a = alphaAt(samples.length + 1);
    filtered = filtered == null ? r.meanMs : a * r.meanMs + (1 - a) * filtered;
    // the best counts from the third sample on, so one lucky first lesson is not the best ever
    if (samples.length + 1 >= Math.min(WARMUP_LESSONS, 3)) best = Math.min(best ?? Infinity, filtered);
    samples.push({ index: r.lessonIndex, at: r.at, hits: r.hits, misses: r.misses, timeToType: r.meanMs, filteredTimeToType: filtered });
  }
  const errorRate = presses > 0 ? misses / presses : null;
  return { letter, samples, timeToType: filtered, bestTimeToType: best ?? filtered, errorRate, errorPresses: presses, errorMisses: misses, errorBound: errorRate == null ? null : wilsonLower(errorRate, presses) };
}

/** target time / key time: 1 or more means the key is at or above the target speed */
export const confidence = (timeToType: number | null, targetCpm: number): number | null => (timeToType == null ? null : speedToTime(targetCpm) / timeToType);

export interface LessonKey {
  letter: string;
  stats: KeyStats;
  confidence: number | null;
  bestConfidence: number | null;
  /** speed (best, or current with recoverKeys) and accuracy together: 1 or more = the key has reached the target */
  readiness: number;
  included: boolean;
  focused: boolean;
}

/**
 * The accuracy gate: the wrong presses of all open keys together (each key's smoothed wrong and all presses summed) must not be above
 * the limit beyond chance (lower Wilson bound). One unlucky key is carried by the others; a keyboard that is sloppy overall is not.
 */
export function overallAccuracy(stats: readonly KeyStats[], minAccuracy: number): { errorRate: number | null; errorBound: number | null; presses: number; reached: boolean } {
  const presses = stats.reduce((a, k) => a + k.errorPresses, 0);
  const misses = stats.reduce((a, k) => a + k.errorMisses, 0);
  if (presses <= 0) return { errorRate: null, errorBound: null, presses: 0, reached: true };
  const errorRate = misses / presses;
  const errorBound = wilsonLower(errorRate, presses);
  return { errorRate, errorBound, presses, reached: errorBound <= 1 - minAccuracy + 1e-9 };
}

/** accuracy part of readiness (pass KeyStats.errorBound): 1 at or below the allowed error rate, falling by a quarter per 5 extra points of errors */
export function accuracyScore(errorRate: number | null, minAccuracy: number): number {
  if (errorRate == null) return 1;
  return Math.min(1.5, 1 - ERROR_PENALTY * (errorRate - (1 - minAccuracy)));
}

export interface GuidedOptions {
  targetCpm: number;
  /** keybr recoverKeys: judge keys by their current speed instead of the best they ever reached */
  recoverKeys?: boolean;
  /** keys opened by earlier lessons stay open even when the target has risen since (the target here follows the learner's speed) */
  alreadyOpen?: ReadonlySet<string>;
  /** a key reaches the target only with at least this accuracy (0..1); missing means DEFAULT_MIN_ACCURACY */
  minAccuracy?: number;
}

/**
 * keybr GuidedLesson.update: letters open in frequency order; the first MIN_KEYS are open from the start, every key that was ever
 * at the target stays open, and the next letter opens only when every open key has reached the target in at least MIN_KEY_LESSONS lessons. Focus combines speed and
 * smoothed accuracy, with speed weighted more heavily. Unlike keybr, the next letter also needs the open keys' wrong presses taken together to be within the
 * limit (overallAccuracy); a single key's accuracy does not hold it back.
 */
export function lessonKeys(lettersByFrequency: readonly string[], rows: readonly KeyLessonRow[], opts: GuidedOptions): LessonKey[] {
  const keys: LessonKey[] = lettersByFrequency.map((letter) => {
    const stats = keyStats(letter, rows);
    const conf = confidence(stats.timeToType, opts.targetCpm);
    const best = confidence(stats.bestTimeToType, opts.targetCpm);
    const raw = opts.recoverKeys ? (conf ?? 0) : (best ?? 0);
    // below MIN_KEY_LESSONS lessons the key is never counted as reached, however fast it was
    const speed = stats.samples.length < MIN_KEY_LESSONS ? Math.min(raw, 0.99) : raw;
    // a key's own readiness is its speed: a few wrong presses on a rarely met key say little (10-40 presses a lesson); accuracy is judged over all open keys together
    return { letter, stats, confidence: conf, bestConfidence: best, readiness: speed, included: false, focused: false };
  });
  const accuracyOk = (open: readonly LessonKey[]): boolean => overallAccuracy(open.map((k) => k.stats), opts.minAccuracy ?? DEFAULT_MIN_ACCURACY).reached;
  const judged = (k: LessonKey): number => k.readiness;
  for (const key of keys) {
    const included = keys.filter((k) => k.included);
    if (included.length < MIN_KEYS || opts.alreadyOpen?.has(key.letter) || judged(key) >= 1 || (included.every((k) => judged(k) >= 1) && accuracyOk(included))) key.included = true;
  }
  const open = keys.filter((k) => k.included);
  // Focus is separate from the opening gate: 80% best speed against target, 20% smoothed accuracy.
  // Cap speed at the target so exceptional speed cannot hide poor accuracy; unknown accuracy is neutral.
  const focusScore = (k: LessonKey): number => 0.8 * Math.min(1, judged(k)) + 0.2 * (1 - (k.stats.errorRate ?? 0));
  const needsPractice = open.some((k) => judged(k) < 1) || !accuracyOk(open);
  const weakest = needsPractice ? [...open].sort((a, b) => focusScore(a) - focusScore(b))[0] : undefined;
  if (weakest) weakest.focused = true;
  return keys;
}

export interface LearningRate {
  /** fit quality (r²), at least 0.5 */
  certainty: number;
  /** CPM gained per lesson at the latest lesson */
  cpmPerLesson: number;
  /** lessons until the target is predicted, null when not within 50 */
  remainingLessons: number | null;
}

/** keybr learningsession.ts: the latest run of lessons without an hour's break (or a slowdown after 5+ lessons) */
function latestSession(samples: readonly KeySample[]): KeySample[] {
  for (let i = samples.length - 1; i > 0; i--) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b.at - a.at > 3600000) return samples.slice(i);
    if (b.filteredTimeToType > a.filteredTimeToType && samples.length - i + 1 >= 5) return samples.slice(i);
  }
  return samples.slice(0);
}

/** keybr LearningRate: a polynomial fit of the key's speed over its last 30 lessons; null when there is too little data or the fit is poor */
export function learningRate(samples: readonly KeySample[], targetCpm: number): LearningRate | null {
  let recent = samples.slice(-30);
  if (recent.length < 5) return null;
  const session = latestSession(recent);
  if (session.length >= 5) recent = session;
  const xs = recent.map((s) => s.index + 1);
  const ys = recent.map((s) => timeToSpeed(s.filteredTimeToType));
  const degree = recent.length > 20 ? 3 : recent.length > 10 ? 2 : 1;
  const model: Polynomial = polynomialRegression(xs, ys, degree);
  const certainty = r2(xs, ys, model);
  if (!(certainty >= 0.5)) return null;
  const last = xs[xs.length - 1]!;
  let remainingLessons: number | null = null;
  for (let i = 1; i <= 50; i++) {
    if (model.eval(last + i) >= targetCpm) {
      remainingLessons = i;
      break;
    }
  }
  return { certainty, cpmPerLesson: model.derivative().eval(last), remainingLessons };
}

/** lessons whose raw error rate stands for a key's usual accuracy */
export const RECENT_ERROR_LESSONS = 10;
/** how far ahead an outlook looks */
const OUTLOOK_LESSONS = 50;

export interface AccuracyOutlook {
  /** raw share of wrong presses of the key over its last RECENT_ERROR_LESSONS lessons */
  recentErrorRate: number | null;
  /** lessons until the key passes the accuracy check if none of them has a mistake on it (0 = passes now) */
  cleanLessons: number | null;
  /** the same at the key's recent error rate; null when it would not pass within OUTLOOK_LESSONS lessons at that rate */
  usualLessons: number | null;
}

/**
 * How many more lessons the accuracy part of readiness needs: the same smoothing as keyStats, run forward with the key's recent
 * presses per lesson and an assumed error rate. Derived on read, an explanation only; it never decides anything.
 */
export function accuracyOutlook(letter: string, rows: readonly KeyLessonRow[], minAccuracy: number): AccuracyOutlook {
  const own = rows.filter((r) => r.letter === letter && r.hits + r.misses > 0).sort((a, b) => a.lessonIndex - b.lessonIndex);
  const st = keyStats(letter, rows);
  if (own.length === 0 || st.errorRate == null) return { recentErrorRate: null, cleanLessons: null, usualLessons: null };
  const recent = own.slice(-RECENT_ERROR_LESSONS);
  const presses = recent.reduce((a, r) => a + r.hits + r.misses, 0);
  const recentErrorRate = recent.reduce((a, r) => a + r.misses, 0) / presses;
  const perLesson = presses / recent.length;
  const limit = 1 - minAccuracy + 1e-9;
  const lessonsAt = (rate: number): number | null => {
    let m = st.errorMisses;
    let p = st.errorPresses;
    for (let i = 0; i <= OUTLOOK_LESSONS; i++) {
      if (wilsonLower(m / p, p) <= limit) return i;
      m = (1 - SMOOTHING_ALPHA) * m + rate * perLesson;
      p = (1 - SMOOTHING_ALPHA) * p + perLesson;
    }
    return null;
  };
  return { recentErrorRate, cleanLessons: lessonsAt(0), usualLessons: lessonsAt(recentErrorRate) };
}

export interface GoalForecast {
  /** CPM gained per lesson by the linear trend of recent lessons */
  cpmPerLesson: number;
  /** lessons until the trend reaches the goal; null when the trend is flat or falling */
  lessonsToGoal: number | null;
  /** the same in hours of typing, from the mean active time of recent lessons */
  hoursToGoal: number | null;
}

/**
 * Long-range forecast to the learner's goal (an addition to keybr, whose forecast looks only 50 lessons ahead per key): a straight
 * line through the speed of the last FORECAST_LESSONS lessons. A cubic fit is fine for the next few lessons but wild far ahead.
 */
export const FORECAST_LESSONS = 50;
export function goalForecast(lessons: ReadonlyArray<{ cpm: number; activeMs: number }>, goalCpm: number): GoalForecast | null {
  const recent = lessons.slice(-FORECAST_LESSONS);
  if (recent.length < 10) return null;
  const xs = recent.map((_, i) => i + 1);
  const model = polynomialRegression(xs, recent.map((l) => l.cpm), 1);
  const slope = model.derivative().eval(0);
  const now = model.eval(xs.length);
  const meanMs = recent.reduce((a, l) => a + l.activeMs, 0) / recent.length;
  if (now >= goalCpm) return { cpmPerLesson: Math.round(slope * 100) / 100, lessonsToGoal: 0, hoursToGoal: 0 };
  if (!(slope > 0)) return { cpmPerLesson: Math.round(slope * 100) / 100, lessonsToGoal: null, hoursToGoal: null };
  const lessonsToGoal = Math.ceil((goalCpm - now) / slope);
  return { cpmPerLesson: Math.round(slope * 100) / 100, lessonsToGoal, hoursToGoal: Math.round(((lessonsToGoal * meanMs) / 3600000) * 10) / 10 };
}

/** keybr dailygoal.ts: share of the daily goal reached by today's typing time (can exceed 1) */
export const dailyGoalProgress = (todayMs: number, goalMinutes: number): number => (goalMinutes > 0 ? todayMs / 60000 / goalMinutes : 0);
