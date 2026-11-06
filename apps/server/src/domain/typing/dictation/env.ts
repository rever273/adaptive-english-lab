import path from "node:path";
import { PiperClient } from "../../../adapters/tts/piper.js";
import type { AppConfig } from "../../../config.js";
import { chooseDictationAsr } from "./asr.js";
import { VoiceService } from "../../voices/service.js";
import { loadDictationContent, type DictationEnv } from "./lessons.js";

/** The real Piper process, the Groq / local large-v3 check and the voice service and the topics file; one instance is shared by the routes and the generation runner. */
export function createDictationEnv(config: AppConfig, groqKey?: string): DictationEnv {
  const content = loadDictationContent(config.projectRoot);
  return {
    tts: new PiperClient({ python: config.piperPython, modelDir: config.piperModelDir }),
    asr: chooseDictationAsr({ ...(groqKey ? { groqKey } : {}), script: path.join(config.projectRoot, "workers", "dictation_asr", "check.py") }),
    voices: new VoiceService(),
    topics: content.topics,
    audioDir: path.join(config.dataRoot, "typing-dictation-audio"),
  };
}
