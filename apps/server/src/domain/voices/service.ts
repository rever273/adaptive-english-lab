import { randomUUID } from "node:crypto";
import type { VoiceSettingsUpdate } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { isSoundFlagged } from "./flags.js";
import { loadVoices, saveVoiceSettings, voiceBySpeaker, voiceByKey, voiceHistory, type Voice, type VoicePurpose, type VoiceRevision } from "./catalog.js";
import { alternativeVoice, pickVoice, planVoiceList, type Weighted } from "./select.js";
import { variedLengthScale } from "./speed.js";
import { computeWeights, VOICE_WEIGHTS_VERSION, type VoiceWeight } from "./weights.js";

export type VoiceOutcome = "ok" | "asr_mismatch" | "wav_invalid" | "wav_length";

export interface VoiceListing extends Voice {
  weight: VoiceWeight;
  /** the part of this purpose's sentences the voice is expected to get, 0-1 */
  share: number;
  checks: number;
  heardRate: number | null;
  flags: number;
}

export interface SynthesisParams {
  speakerId: number;
  lengthScale: number;
  noiseScale?: number;
  noiseWScale?: number;
}

interface Opts {
  purpose: VoicePurpose;
  /** the installed voice model: an evaluation of another model does not count */
  modelSha?: string;
}

/**
 * The one place that hands out Piper voices (D122). Audio Dictation, Books and every later feature that reads a sentence aloud ask here with their
 * purpose; the catalogue, the settings revisions and the evidence all live in the database. Methods take the database so the service itself holds nothing.
 */
export class VoiceService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: { now?: () => Date; newId?: () => string } = {}) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  private weighted(db: Db, o: Opts): Weighted[] {
    const voices = loadVoices(db);
    const { weights } = computeWeights(db, voices, o.purpose, o.modelSha ? { modelSha: o.modelSha } : {});
    return voices.map((voice) => ({ voice, weight: weights.get(voice.key)!.effective }));
  }

  /** every voice with its weights, evidence and expected share for one purpose */
  list(db: Db, o: Opts): VoiceListing[] {
    const voices = loadVoices(db);
    const { weights, evidence } = computeWeights(db, voices, o.purpose, o.modelSha ? { modelSha: o.modelSha } : {});
    const total = voices.reduce((a, v) => a + weights.get(v.key)!.effective, 0);
    return voices.map((v) => {
      const w = weights.get(v.key)!;
      const ev = evidence.get(v.key)!;
      return { ...v, weight: w, share: total > 0 ? Math.round((w.effective / total) * 1000) / 1000 : 0, checks: ev.checks, heardRate: ev.heardRate, flags: ev.flags };
    });
  }

  /** the voices of one speaker id, whatever their state (for stored exercises) */
  bySpeaker(db: Db, speakerId: number): Voice | null {
    return voiceBySpeaker(db, speakerId);
  }

  byKey(db: Db, key: string): Voice | null {
    return voiceByKey(db, key);
  }

  history(db: Db, key: string): VoiceRevision[] {
    return voiceHistory(db, key);
  }

  /** the voices that can be used for the purpose now */
  active(db: Db, o: Opts): Voice[] {
    return this.weighted(db, o).filter((c) => c.weight > 0).map((c) => c.voice);
  }

  /** one voice by weight; null when no voice is on for the purpose */
  pick(db: Db, o: Opts & { seed: string | number; topicGroup?: string; exclude?: string[]; previousKey?: string }): Voice | null {
    return pickVoice(this.weighted(db, o), o);
  }

  /** one voice per sentence of a plan (D85, D124) */
  plan(db: Db, o: Opts & { count: number; seed: string | number; groups?: ReadonlyArray<string | undefined> }): Voice[] {
    return planVoiceList(this.weighted(db, o), o.count, o.seed, o.groups);
  }

  /** a second voice for a sentence the voices in `failed` could not say clearly */
  alternative(db: Db, o: Opts & { failed: string[]; topicGroup?: string; seed: string | number }): Voice | null {
    const candidates = this.weighted(db, o);
    // nothing else on for this purpose: any other voice that is on at all beats giving up
    return alternativeVoice(candidates, o) ?? alternativeVoice(candidates.map((c) => ({ ...c, weight: c.voice.enabled && c.voice.purposes.includes(o.purpose) ? 0.01 : 0 })), o);
  }

  /** the weights a plan was made with, by voice name (written into the lesson plan) */
  snapshot(db: Db, o: Opts): { version: number; weights: Record<string, number> } {
    return { version: VOICE_WEIGHTS_VERSION, weights: Object.fromEntries(this.weighted(db, o).map((c) => [c.voice.name, c.weight])) };
  }

  /** what Piper is given for a voice: its pace with the sentence's own small variation (the stored length_scale is the one really used) */
  synthesisParams(v: Voice, speedSeed?: string): SynthesisParams {
    return {
      speakerId: v.id,
      lengthScale: speedSeed === undefined ? v.lengthScale : variedLengthScale(v.lengthScale, speedSeed, v.maxSpeedUp),
      ...(v.noiseScale !== null ? { noiseScale: v.noiseScale } : {}),
      ...(v.noiseWScale !== null ? { noiseWScale: v.noiseWScale } : {}),
    };
  }

  /** every voiced attempt of a sentence, for the live statistics (inside the caller's transaction) */
  recordChecks(db: Db, at: string, outcomes: Array<{ key: string; purpose: VoicePurpose; outcome: VoiceOutcome; attemptGroup: string; heardText?: string }>): void {
    const put = db.prepare("INSERT INTO tts_voice_checks(id, voice_key, purpose, attempt_group, outcome, heard_text, created_at) VALUES (?,?,?,?,?,?,?)");
    for (const o of outcomes) put.run(this.newId(), o.key, o.purpose, o.attemptGroup, o.outcome, o.heardText?.slice(0, 300) ?? null, at);
  }

  /** sets the mark of a voiced exercise; a repeated request for the state it already has writes nothing */
  setFlag(db: Db, o: { exerciseId: string; flagged: boolean }): { flagged: boolean } {
    return db
      .transaction(() => {
        const ex = db.prepare("SELECT source, voice_id AS voiceId FROM typing_dictation_exercises WHERE id = ?").get(o.exerciseId) as { source: string; voiceId: number | null } | undefined;
        if (!ex) throw new ApiError(404, "DICTATION_EXERCISE_NOT_FOUND", "That sentence does not exist");
        if (ex.source !== "tts" || ex.voiceId === null) throw new ApiError(409, "SOUND_FLAG_NOT_APPLICABLE", "Only a sentence read by a synthetic voice can be marked");
        const voice = voiceBySpeaker(db, ex.voiceId);
        if (!voice) throw new ApiError(409, "SOUND_FLAG_NOT_APPLICABLE", "This sentence has no known voice");
        if (isSoundFlagged(db, o.exerciseId) === o.flagged) return { flagged: o.flagged };
        db.prepare("INSERT INTO tts_voice_flags(id, voice_key, purpose, exercise_id, action, created_at) VALUES (?,?,?,?,?,?)").run(this.newId(), voice.key, "dictation", o.exerciseId, o.flagged ? "flag" : "unflag", this.now().toISOString());
        return { flagged: o.flagged };
      })
      .immediate();
  }

  /** a new settings revision made by the learner */
  updateSettings(db: Db, key: string, patch: VoiceSettingsUpdate): Voice {
    return saveVoiceSettings(db, { now: this.now, newId: this.newId }, key, patch, "user");
  }
}
