import { spellNumbers } from "@english-lab/contracts";
import type { DictationAsr } from "../typing/dictation/asr.js";
import type { TtsClient } from "../../adapters/tts/piper.js";
import type { SynthesisParams } from "../voices/service.js";
import { checkWav } from "../typing/dictation/quality.js";
import { tokenize, wordDistance } from "../typing/dictation/check.js";

/** interjections and greetings Whisper writes in many ways ("Haha" / "Ha ha" / "Ha-ha", "G'day" / "Good day"): they never decide the check */
const LOOSE = new Set(["ha", "haha", "hahaha", "heh", "hehe", "oh", "ooh", "ah", "aw", "um", "uh", "hmm", "eh", "yeah", "yep", "yup", "nah", "ok", "okay", "g'day", "gday", "good", "day", "mate", "wow", "hey", "hi"]);
const strict = (words: readonly string[]): string[] => words.filter((w) => !LOOSE.has(w.toLowerCase().replace(/[’]/g, "'").replace(/-/g, "")));
/** a long message may differ by one word (a homophone, a name, slang): a stutter in a short one still fails */
const allowedDistance = (n: number): number => (n >= 15 ? 1 : 0) + (n >= 40 ? 1 : 0);

/** Reject inaudible, truncated or recognisably repeated/missing words; Whisper cannot detect every audible stutter. */
export async function checkedConversationSpeech(o: { text: string; params: SynthesisParams; tts: TtsClient; asr: DictationAsr; signal: AbortSignal }): Promise<Buffer> {
  const expected = tokenize(spellNumbers(o.text));
  if (!expected.length) throw new Error("empty_speech");
  let reason = "speech_check_failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await o.tts.synthesize({ text: o.text, ...o.params, signal: o.signal });
    const checked = checkWav(raw, expected.length);
    if (!checked.ok) { reason = checked.code; continue; }
    const heard = await o.asr.transcribe(checked.wav, o.signal);
    const want = strict(expected);
    if (wordDistance(want, strict(tokenize(spellNumbers(heard.text)))) <= allowedDistance(want.length)) return checked.wav;
    reason = "ASR_MISMATCH";
  }
  throw new Error(reason);
}
