import { spellNumbers } from "@english-lab/contracts";
import type { DictationAsr } from "../typing/dictation/asr.js";
import type { TtsClient } from "../../adapters/tts/piper.js";
import type { SynthesisParams } from "../voices/service.js";
import { checkWav } from "../typing/dictation/quality.js";
import { tokenize, wordDistance } from "../typing/dictation/check.js";

/** Reject inaudible, truncated or recognisably repeated/missing words; Whisper cannot detect every audible stutter. */
export async function checkedConversationSpeech(o: { text: string; params: SynthesisParams; tts: TtsClient; asr: DictationAsr; signal: AbortSignal }): Promise<Buffer> {
  const expected = tokenize(spellNumbers(o.text));
  if (!expected.length) throw new Error("empty_speech");
  let reason = "speech_check_failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await o.tts.synthesize({ text: o.text, ...o.params, signal: o.signal });
    const checked = checkWav(raw, expected.length);
    if (!checked.ok) { reason = checked.code; continue; }
    const heard = await o.asr.transcribe(checked.wav, o.signal);
    if (wordDistance(expected, tokenize(spellNumbers(heard.text))) === 0) return checked.wav;
    reason = "ASR_MISMATCH";
  }
  throw new Error(reason);
}
