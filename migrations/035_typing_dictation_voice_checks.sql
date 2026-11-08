-- Migration 035 (TASK_028 follow-up, D115): how each Piper voice does when the speech check (Whisper) listens to it. New table only.
-- One row per voiced attempt: `ok` (heard back exactly) or a failure (`asr_mismatch`, `wav_invalid`, `wav_length`). The share of sentences each voice gets is derived from
-- these rows (a voice that is often misheard gets fewer), softened so no voice disappears. Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE typing_dictation_voice_checks (
  id         TEXT PRIMARY KEY NOT NULL,
  voice_id   INTEGER NOT NULL CHECK (voice_id BETWEEN 0 AND 9),
  outcome    TEXT NOT NULL CHECK (outcome IN ('ok','asr_mismatch','wav_invalid','wav_length')),
  created_at TEXT NOT NULL
);
CREATE INDEX typing_dictation_voice_checks_voice ON typing_dictation_voice_checks(voice_id, created_at);
CREATE TRIGGER typing_dictation_voice_checks_no_update BEFORE UPDATE ON typing_dictation_voice_checks BEGIN SELECT RAISE(ABORT, 'typing_dictation_voice_checks is append-only'); END;
CREATE TRIGGER typing_dictation_voice_checks_no_delete BEFORE DELETE ON typing_dictation_voice_checks BEGIN SELECT RAISE(ABORT, 'typing_dictation_voice_checks is append-only'); END;
