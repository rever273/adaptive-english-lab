import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";

export interface ModelVersionInput {
  tag: string;
  digest: string;
  runtime: string;
  runtimeVersion: string;
  parameters: Record<string, unknown>;
}

/** Idempotent registration of a model identity (tag + digest + runtime version). */
export function upsertModelVersion(db: Db, newId: () => string, m: ModelVersionInput): string {
  db.prepare("INSERT OR IGNORE INTO model_versions(id, tag, digest, runtime, runtime_version, parameters_json) VALUES (?,?,?,?,?,?)").run(
    newId(),
    m.tag,
    m.digest,
    m.runtime,
    m.runtimeVersion,
    JSON.stringify(m.parameters),
  );
  return (db.prepare("SELECT id FROM model_versions WHERE tag = ? AND digest = ? AND runtime_version = ?").get(m.tag, m.digest, m.runtimeVersion) as { id: string }).id;
}

export interface TranscriptInput {
  sessionId: string;
  slotId: string;
  asrText: string;
  submittedText: string;
  sttModelId: string;
  newId: () => string;
  now: () => Date;
}

/**
 * Text only (AGENTS §8): the ASR draft and the text the user confirmed are separate fields; `edited` records a difference.
 * Nothing here receives or stores audio. The STT endpoints that call this arrive with TASK_011.
 */
export function createTranscript(db: Db, t: TranscriptInput): string {
  const slot = db.prepare("SELECT id FROM session_slots WHERE id = ? AND session_id = ?").get(t.slotId, t.sessionId);
  if (!slot) throw new ApiError(404, "SLOT_NOT_FOUND", "Slot does not belong to this session");
  const id = t.newId();
  db.prepare("INSERT INTO transcripts(id, session_id, slot_id, asr_text, submitted_text, edited, stt_model_id, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
    id,
    t.sessionId,
    t.slotId,
    t.asrText,
    t.submittedText,
    t.asrText === t.submittedText ? 0 : 1,
    t.sttModelId,
    t.now().toISOString(),
  );
  return id;
}
