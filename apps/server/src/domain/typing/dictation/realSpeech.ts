import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spellNumbers } from "@english-lab/contracts";
import { tokenize, wordDistance } from "./check.js";

export interface RealSpeechConfig { catalogPath: string; audioDir: string }
export interface RealClip {
  file: string; sentenceId: string; text: string; translationRu: string; sha256: string; audioMs: number;
  status: "validated";
  validation: { source: string; textReview: string; translationReview: string; asrModels: string[]; asrTexts: string[]; humanAudioReview: boolean };
}

/** Reviewed catalogue plus source sentences independently checked by both speech models. */
export function loadRealClips(config: RealSpeechConfig): RealClip[] {
  let clips: unknown = [];
  try { clips = (JSON.parse(readFileSync(config.catalogPath, "utf8")) as { clips?: unknown }).clips; } catch { /* catalogue may not exist yet */ }
  const rawClips: unknown[] = Array.isArray(clips) ? [...clips] : [];
  const auto = path.join(path.dirname(config.catalogPath), "auto");
  try {
    const metadata = JSON.parse(readFileSync(path.join(auto, "source-metadata.json"), "utf8")) as Record<string, { sentence_id: string; text: string; audio_ms: number }>;
    const folder = path.join(auto, "batches");
    for (const file of readdirSync(folder).filter((name) => /^batch-.*\.json$/.test(name)).sort()) {
      try {
        const batch = JSON.parse(readFileSync(path.join(folder, file), "utf8")) as { asr_checks_completed?: boolean; clips?: Array<{ file: string; sentence_id: string; text: string; sha256: string; checks?: Record<string, { text?: string; matches?: boolean }> }> };
        if (!batch.asr_checks_completed || !Array.isArray(batch.clips)) continue;
        for (const c of batch.clips) {
          const source = metadata[c.file];
          const large = c.checks?.["large-v3"], medium = c.checks?.medium;
          if (!source || source.sentence_id !== c.sentence_id || source.text !== c.text || large?.matches !== true || medium?.matches !== true) continue;
          rawClips.push({ file: c.file, sentenceId: c.sentence_id, text: c.text, translationRu: "", sha256: c.sha256, audioMs: source.audio_ms, status: "validated", validation: { source: "mozilla-common-voice-v24-au", textReview: "source-asr", translationReview: "unavailable", asrModels: ["faster-whisper-large-v3", "faster-whisper-medium"], asrTexts: [large.text, medium.text], humanAudioReview: false } });
        }
      } catch { /* incomplete or damaged batches are not used */ }
    }
  } catch { /* no automatically checked candidates yet */ }
  return rawClips.filter((raw: unknown): raw is RealClip => {
    if (!raw || typeof raw !== "object") return false;
    const c = raw as RealClip;
    if (c.status !== "validated" || typeof c.file !== "string" || path.basename(c.file) !== c.file || !/^common_voice_en_\d+\.mp3$/.test(c.file)) return false;
    if (typeof c.text !== "string" || typeof c.translationRu !== "string" || typeof c.sentenceId !== "string" || !c.sentenceId || !/^[a-f0-9]{64}$/.test(c.sha256)) return false;
    const words = c.text.trim().split(/\s+/);
    if (words.length < 5 || words.length > 16 || !Number.isFinite(c.audioMs) || c.audioMs < 2000 || c.audioMs > 12000) return false;
    const v = c.validation;
    if (!v || v.source !== "mozilla-common-voice-v24-au" || !((v.textReview === "agent" && v.translationReview === "agent" && !!c.translationRu.trim()) || (v.textReview === "source-asr" && v.translationReview === "unavailable" && c.translationRu === "")) || !Array.isArray(v.asrModels) || v.asrModels.length !== 2 || !Array.isArray(v.asrTexts) || v.asrTexts.length !== 2) return false;
    if (v.asrModels[0] !== "faster-whisper-large-v3" || v.asrModels[1] !== "faster-whisper-medium") return false;
    if (!v.asrTexts.every((t) => typeof t === "string" && wordDistance(tokenize(c.text), tokenize(spellNumbers(t))) === 0)) return false;
    try { const file = path.join(config.audioDir, c.file); return existsSync(file) && createHash("sha256").update(readFileSync(file)).digest("hex") === c.sha256; } catch { return false; }
  });
}
