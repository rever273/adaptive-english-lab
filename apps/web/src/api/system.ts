import { AiModelStatusSchema, CapabilitiesSchema, ErrorEnvelopeSchema, HealthSchema, VoicesResponseSchema } from "@english-lab/contracts";
import type { AiModelStatus, Capabilities, Health, VoiceSettingsUpdate } from "@english-lab/contracts";
import { ApiRequestError, csrfState, send } from "./transport";
import { typed } from "./response";

export const fetchHealth = (): Promise<Health> => send("GET", "/api/v1/health", HealthSchema);

export const fetchAiModel = (): Promise<AiModelStatus> => send("GET", "/api/v1/ai/model", AiModelStatusSchema);

export const loadAiModel = (): Promise<AiModelStatus> => send("POST", "/api/v1/ai/model/load", AiModelStatusSchema, {});

export const unloadAiModel = (): Promise<AiModelStatus> => send("POST", "/api/v1/ai/model/unload", AiModelStatusSchema, {});

export const fetchCapabilities = (): Promise<Capabilities> => send("GET", "/api/v1/capabilities", CapabilitiesSchema);

type SettingsValues = { preloadModelOnStart?: boolean; practiceSoundsEnabled?: boolean; typingSoundsEnabled?: boolean; taskCount: number; weakRatio: number; voiceTarget: 0 | 1 | 2; voiceShare?: number; vocabularyFocus?: boolean; vocabularyTaskCount?: number; vocabularyNewWordsPerSession?: number; vocabularyMatchRounds?: number; reviewNoticeThreshold?: number; difficultyMin?: Level; difficultyMax?: Level; typingWordsPerLevel?: number; typingDrillWordsPerLevel?: number; typingDrillSpeech?: boolean; typingKeysTargetWpm?: number; typingKeysGoalWpm?: number; typingKeysMinAccuracy?: number; typingVocabularyShare?: number; typingSpeedMultiplier?: number; typingBookMinutes?: number; typingBooksShowMistakes?: boolean; typingDictationExercisesPerLesson?: number; typingDictationSource?: "real" | "tts"; typingRecallWords?: number; clozeTaskCount?: number; clozeAutoAdvance?: boolean; clozeHighlightNames?: boolean };

export type Level = "A2" | "B1" | "B2" | "C1" | "C2";

export type SettingsView = { revision: number; values: SettingsValues; defaults: SettingsValues };

export const fetchSettings = () => send("GET", "/api/v1/settings", typed<SettingsView>());

export const savePreloadModel = (on: boolean) => send("POST", "/api/v1/settings", typed<SettingsView>(), { preloadModelOnStart: on });

export const saveSettings = (values: { taskCount: number; weakRatio: number; voiceShare: number; practiceSoundsEnabled?: boolean; typingSoundsEnabled?: boolean; vocabularyFocus?: boolean; vocabularyTaskCount?: number; vocabularyNewWordsPerSession?: number; vocabularyMatchRounds?: number; reviewNoticeThreshold?: number; difficultyMin?: Level; difficultyMax?: Level; typingWordsPerLevel?: number; typingDrillWordsPerLevel?: number; typingDrillSpeech?: boolean; typingKeysTargetWpm?: number; typingKeysGoalWpm?: number; typingKeysMinAccuracy?: number; typingVocabularyShare?: number; typingSpeedMultiplier?: number; typingBookMinutes?: number; typingBooksShowMistakes?: boolean; typingDictationExercisesPerLesson?: number; typingDictationSource?: "real" | "tts"; typingRecallWords?: number; clozeTaskCount?: number; clozeAutoAdvance?: boolean; clozeHighlightNames?: boolean }) => send("POST", "/api/v1/settings", typed<SettingsView>(), values);

export type GroqStatus = { configured: boolean; reachable: boolean; reason?: string; limits: { capturedAt: string; status: number | null; headers: Record<string, string> } | null };

export type DeepLUsage = { available: true; used: number; limit: number } | { available: false; reason: string };

export const fetchDeepLUsage = () => send("GET", "/api/v1/translate/usage", typed<DeepLUsage>());

export const fetchGroqStatus = () => send("GET", "/api/v1/groq-status", typed<GroqStatus>());

export const sttStart = (sessionId: string, tabId: string) => send("POST", "/api/v1/stt/start", typed<{ streamId: string; maxSeconds: number; ready: { device: string } }>(), { sessionId, tabId });

export const sttConfirm = (streamId: string, draftId: string, slotId: string, text: string) => send("POST", `/api/v1/stt/${streamId}/confirm`, typed<{ transcriptId: string; edited: boolean }>(), { draftId, slotId, text });

export const sttStop = (streamId: string) => send("POST", `/api/v1/stt/${streamId}/stop`, typed<{ stopped: boolean }>(), {});

export async function sttAudio(streamId: string, pcm: Int16Array): Promise<{ draftId: string; text: string }> {
  if (!csrfState.token) throw new ApiRequestError("NO_SESSION", "Voice was not started."); // set by the start request that always comes first
  const res = await fetch(`/api/v1/stt/${streamId}/audio`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": csrfState.token ?? "" }, body: new Blob([Uint8Array.from(pcm.buffer instanceof ArrayBuffer ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) : [])]) });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const env = ErrorEnvelopeSchema.safeParse(json);
    throw new ApiRequestError(env.success ? env.data.error.code : `HTTP_${res.status}`, env.success ? env.data.error.message : "Unexpected server response.", res.status);
  }
  return json as { draftId: string; text: string };
}

export async function sendKeepalive(path: string, body: unknown): Promise<void> {
  if (!csrfState.token) return; // no token yet: losing the last seconds is acceptable
  try {
    await fetch(path, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfState.token }, body: JSON.stringify(body) });
  } catch {
    /* best effort */
  }
}

export const fetchVoices = (purpose: "dictation" | "books" | "listening" = "dictation") => send("GET", `/api/v1/voices?purpose=${purpose}`, VoicesResponseSchema);

export const saveVoiceSettings = (key: string, patch: VoiceSettingsUpdate) => send("PATCH", `/api/v1/voices/${encodeURIComponent(key)}/settings`, VoicesResponseSchema, patch);

export const fetchVoiceHistory = (key: string) => send("GET", `/api/v1/voices/${encodeURIComponent(key)}/history`, typed<{ revisions: Array<{ revision: number; source: string; reason: string | null; createdAt: string; priorWeight: number; lengthScale: number; enabled: boolean }> }>());

export interface VoiceSampleStats { speechSeconds: number; wordsPerMinute: number; syllablesPerSecond: number; lengthScale: number }
/** the sample at the saved pace, or at `lengthScale` when given (a change not saved yet), with how fast it really speaks */

export async function fetchVoiceSample(key: string, lengthScale?: number): Promise<{ blob: Blob; stats: VoiceSampleStats | null }> {
  const res = await fetch(`/api/v1/voices/${encodeURIComponent(key)}/sample${lengthScale === undefined ? "" : `?lengthScale=${lengthScale}`}`);
  if (!res.ok) throw new ApiRequestError("AUDIO_UNAVAILABLE", "The sample is not available. Is Piper installed (npm run dictation:setup)?");
  let stats: VoiceSampleStats | null = null;
  try { const h = res.headers.get("X-Sample-Stats"); stats = h ? (JSON.parse(h) as VoiceSampleStats) : null; } catch { stats = null; }
  return { blob: await res.blob(), stats };
}

export type { VoiceInfo, VoiceSettingsUpdate } from "@english-lab/contracts";
