import type { Db } from "../../db/open.js";
import type { Voice, VoicePurpose } from "./catalog.js";

/**
 * effective weight of a voice = prior (the learner's own starting weight) x offline (the last `voices:evaluate` run) x live (the speech
 * check of real sentences) x flags ("Sounds bad" marks). Only the prior is the learner's to set; checks multiply it within limits.
 * Bump the version whenever a formula changes: it is written into every lesson plan.
 */
export const VOICE_WEIGHTS_VERSION = 1;

export interface VoiceWeight {
  prior: number;
  offline: number;
  live: number;
  flags: number;
  effective: number;
  version: number;
}

export interface VoiceEvidence {
  checks: number;
  heardRate: number | null;
  flags: number;
  exercises: number;
  okWeight: number;
  totalWeight: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;

const LIVE_PRIOR_N = 10;
const LIVE_PRIOR_PASS = 0.85;
const LIVE_WINDOW = 600;
/** the part of a failure that counts against a voice when every voice tried on that sentence failed (the sentence is probably to blame) */
export const SHARED_FAILURE_WEIGHT = 0.5;

/** D118 with D127: (heard-back rate / 0.85)^2 with a prior of 10 checks, clamped to 0.4-1.25 */
export function liveFactor(okWeight: number, totalWeight: number): number {
  const pass = (okWeight + LIVE_PRIOR_PASS * LIVE_PRIOR_N) / (totalWeight + LIVE_PRIOR_N);
  return clamp(round((pass / LIVE_PRIOR_PASS) ** 2, 2), 0.4, 1.25);
}

/** 1 mark in 10 sentences gives 0.7, never below 0.5 */
export function flagsFactor(flagged: number, exercises: number): number {
  return clamp(round(1 - 3 * (flagged / Math.max(10, exercises)), 3), 0.5, 1);
}

export function offlineFactor(exactRate: number, mos: number | null, medianMos: number | null): number {
  const base = (exactRate / 0.9) ** 2;
  const naturalness = mos !== null && medianMos !== null && medianMos > 0 ? (mos / medianMos) ** 1.5 : 1;
  return clamp(round(base * naturalness, 3), 0.6, 1.2);
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** per voice: exact rate and median MOS at the voice's own pace, from the newest complete evaluation run (of the installed model when it is known) */
function offlineScores(db: Db, modelSha: string | undefined): Map<string, { exactRate: number; mos: number | null }> {
  const run = db
    .prepare(`SELECT id FROM tts_voice_eval_runs WHERE status = 'complete' ${modelSha ? "AND tts_model_sha256 = ?" : ""} ORDER BY finished_at DESC, rowid DESC LIMIT 1`)
    .get(...(modelSha ? [modelSha] : [])) as { id: string } | undefined;
  const out = new Map<string, { exactRate: number; mos: number | null }>();
  if (!run) return out;
  const clips = db
    .prepare("SELECT voice_key AS k, word_errors AS e, json_extract(metrics_json, '$.mos') AS mos FROM tts_voice_eval_clips WHERE run_id = ? AND noise_w_scale IS NULL AND json_extract(metrics_json, '$.factor') = 1")
    .all(run.id) as Array<{ k: string; e: number | null; mos: number | null }>;
  const by = new Map<string, Array<{ e: number | null; mos: number | null }>>();
  for (const c of clips) by.set(c.k, [...(by.get(c.k) ?? []), c]);
  for (const [k, list] of by) {
    const scored = list.filter((c) => c.e !== null);
    if (scored.length === 0) continue;
    out.set(k, { exactRate: scored.filter((c) => c.e === 0).length / scored.length, mos: median(list.map((c) => c.mos).filter((m): m is number => typeof m === "number")) });
  }
  return out;
}

/** the evidence behind the live and flag factors, per voice key */
export function voiceEvidence(db: Db, voices: readonly Voice[]): Map<string, VoiceEvidence> {
  const rows = db
    .prepare(
      `SELECT c.voice_key AS k, c.outcome AS outcome, (SELECT COUNT(*) FROM tts_voice_checks g WHERE g.attempt_group = c.attempt_group AND g.outcome = 'ok') AS groupOk
         FROM (SELECT voice_key, outcome, attempt_group FROM tts_voice_checks ORDER BY created_at DESC, rowid DESC LIMIT ${LIVE_WINDOW}) c`,
    )
    .all() as Array<{ k: string; outcome: string; groupOk: number }>;
  const live = new Map<string, { n: number; ok: number; okWeight: number; totalWeight: number }>();
  for (const r of rows) {
    const e = live.get(r.k) ?? { n: 0, ok: 0, okWeight: 0, totalWeight: 0 };
    const ok = r.outcome === "ok";
    e.n++;
    if (ok) e.ok++;
    // D127: nobody was heard on that sentence, so a failure counts for half
    const w = ok ? 1 : r.outcome === "asr_mismatch" && r.groupOk === 0 ? SHARED_FAILURE_WEIGHT : 1; // a broken file is the voice's own fault
    e.totalWeight += w;
    if (ok) e.okWeight += w;
    live.set(r.k, e);
  }
  const flagSql = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN (SELECT action FROM tts_voice_flags f WHERE f.exercise_id = e.id ORDER BY f.created_at DESC, f.rowid DESC LIMIT 1) = 'flag' THEN 1 ELSE 0 END), 0) AS flagged
       FROM (SELECT id FROM typing_dictation_exercises WHERE source = 'tts' AND voice_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200) e`,
  );
  return new Map(
    voices.map((v) => {
      const l = live.get(v.key);
      const f = flagSql.get(v.id) as { n: number; flagged: number };
      return [v.key, { checks: l?.n ?? 0, heardRate: l && l.n > 0 ? round(l.ok / l.n, 3) : null, flags: f.flagged, exercises: f.n, okWeight: l?.okWeight ?? 0, totalWeight: l?.totalWeight ?? 0 }];
    }),
  );
}

/** the weights of every voice for one purpose (a voice that is off, or not meant for the purpose, has weight 0) */
export function computeWeights(db: Db, voices: readonly Voice[], purpose: VoicePurpose, opts: { modelSha?: string } = {}): { weights: Map<string, VoiceWeight>; evidence: Map<string, VoiceEvidence> } {
  const evidence = voiceEvidence(db, voices);
  const scores = offlineScores(db, opts.modelSha);
  const medianMos = median([...scores.values()].map((s) => s.mos).filter((m): m is number => m !== null));
  const weights = new Map(
    voices.map((v) => {
      const ev = evidence.get(v.key)!;
      const s = scores.get(v.key);
      const offline = s ? offlineFactor(s.exactRate, s.mos, medianMos) : 1;
      const live = liveFactor(ev.okWeight, ev.totalWeight);
      const flags = flagsFactor(ev.flags, ev.exercises);
      const allowed = v.enabled && v.purposes.includes(purpose);
      return [v.key, { prior: v.priorWeight, offline, live, flags, effective: allowed ? round(v.priorWeight * offline * live * flags, 3) : 0, version: VOICE_WEIGHTS_VERSION }] as const;
    }),
  );
  return { weights, evidence };
}
