import type { VoiceSettingsUpdate } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";

export type VoicePurpose = "dictation" | "books" | "listening";
export const ALL_PURPOSES: readonly VoicePurpose[] = ["dictation", "books", "listening"];

/** One Piper speaker with its current settings revision. `id` is the speaker id Piper is given; `key` identifies the voice in the database. */
export interface Voice {
  key: string;
  id: number;
  name: string;
  gender: "male" | "female";
  ageGroup: "adult" | "mature" | "elderly";
  impression: string | null;
  enabled: boolean;
  purposes: VoicePurpose[];
  avoidGroups: string[];
  lengthScale: number;
  noiseScale: number | null;
  noiseWScale: number | null;
  maxSpeedUp: number;
  priorWeight: number;
  revision: number;
  source: "seed" | "user" | "evaluation";
}

interface Row {
  key: string;
  speaker_id: number;
  name: string;
  gender: "male" | "female";
  revision: number;
  enabled: number;
  prior_weight: number;
  length_scale: number;
  noise_scale: number | null;
  noise_w_scale: number | null;
  max_speed_up: number;
  age_group: Voice["ageGroup"];
  avoid_groups_json: string;
  purposes_json: string;
  impression: string | null;
  source: Voice["source"];
}

const CURRENT = `SELECT v.key, v.speaker_id, v.name, v.gender, s.revision, s.enabled, s.prior_weight, s.length_scale, s.noise_scale, s.noise_w_scale, s.max_speed_up, s.age_group, s.avoid_groups_json, s.purposes_json, s.impression, s.source
  FROM tts_voices v JOIN tts_voice_settings s ON s.voice_key = v.key AND s.revision = (SELECT MAX(revision) FROM tts_voice_settings WHERE voice_key = v.key)`;

const toVoice = (r: Row): Voice => ({
  key: r.key,
  id: r.speaker_id,
  name: r.name,
  gender: r.gender,
  ageGroup: r.age_group,
  impression: r.impression,
  enabled: r.enabled === 1,
  purposes: (JSON.parse(r.purposes_json) as string[]).filter((p): p is VoicePurpose => (ALL_PURPOSES as readonly string[]).includes(p)),
  avoidGroups: JSON.parse(r.avoid_groups_json) as string[],
  lengthScale: r.length_scale,
  noiseScale: r.noise_scale,
  noiseWScale: r.noise_w_scale,
  maxSpeedUp: r.max_speed_up,
  priorWeight: r.prior_weight,
  revision: r.revision,
  source: r.source,
});

/** every voice with its current settings, by speaker id */
export const loadVoices = (db: Db): Voice[] => (db.prepare(`${CURRENT} ORDER BY v.speaker_id`).all() as Row[]).map(toVoice);

export const voiceByKey = (db: Db, key: string): Voice | null => {
  const r = db.prepare(`${CURRENT} WHERE v.key = ?`).get(key) as Row | undefined;
  return r ? toVoice(r) : null;
};

export const voiceBySpeaker = (db: Db, speakerId: number): Voice | null => {
  const r = db.prepare(`${CURRENT} WHERE v.speaker_id = ?`).get(speakerId) as Row | undefined;
  return r ? toVoice(r) : null;
};

/** A new settings revision: the current one with the changes applied. Older revisions stay. */
export function saveVoiceSettings(db: Db, deps: { now: () => Date; newId: () => string }, key: string, patch: VoiceSettingsUpdate, source: "user" | "evaluation", reason?: string): Voice {
  return db
    .transaction((): Voice => {
      const cur = voiceByKey(db, key);
      if (!cur) throw new ApiError(404, "VOICE_NOT_FOUND", "There is no such voice");
      const next = {
        enabled: patch.enabled ?? cur.enabled,
        priorWeight: patch.priorWeight ?? cur.priorWeight,
        lengthScale: patch.lengthScale ?? cur.lengthScale,
        noiseScale: patch.noiseScale === undefined ? cur.noiseScale : patch.noiseScale,
        noiseWScale: patch.noiseWScale === undefined ? cur.noiseWScale : patch.noiseWScale,
        maxSpeedUp: patch.maxSpeedUp ?? cur.maxSpeedUp,
        ageGroup: patch.ageGroup ?? cur.ageGroup,
        avoidGroups: patch.avoidGroups ?? cur.avoidGroups,
        purposes: patch.purposes ?? cur.purposes,
        impression: patch.impression === undefined ? cur.impression : patch.impression,
      };
      db.prepare(
        `INSERT INTO tts_voice_settings(id, voice_key, revision, enabled, prior_weight, length_scale, noise_scale, noise_w_scale, max_speed_up, age_group, avoid_groups_json, purposes_json, impression, source, reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(deps.newId(), key, cur.revision + 1, next.enabled ? 1 : 0, next.priorWeight, next.lengthScale, next.noiseScale, next.noiseWScale, next.maxSpeedUp, next.ageGroup, JSON.stringify(next.avoidGroups), JSON.stringify(next.purposes), next.impression, source, reason ?? null, deps.now().toISOString());
      return voiceByKey(db, key)!;
    })
    .immediate();
}

export interface VoiceRevision {
  revision: number;
  source: string;
  reason: string | null;
  createdAt: string;
  priorWeight: number;
  lengthScale: number;
  enabled: boolean;
}

/** the settings revisions of a voice, newest first */
export const voiceHistory = (db: Db, key: string): VoiceRevision[] =>
  (db.prepare("SELECT revision, source, reason, created_at AS createdAt, prior_weight AS priorWeight, length_scale AS lengthScale, enabled FROM tts_voice_settings WHERE voice_key = ? ORDER BY revision DESC").all(key) as Array<Omit<VoiceRevision, "enabled"> & { enabled: number }>).map((r) => ({ ...r, enabled: r.enabled === 1 }));
