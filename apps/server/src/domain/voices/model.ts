import type { TtsClient } from "../../adapters/tts/piper.js";

/** the installed voice model, for the evaluations that belong to it (nothing when Piper is not installed) */
export const modelShaOpt = (tts: Pick<TtsClient, "available">): { modelSha?: string } => {
  const t = tts.available();
  return t.ok ? { modelSha: t.modelSha256 } : {};
};
