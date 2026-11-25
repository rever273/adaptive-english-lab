import { SessionBootstrapSchema } from "@english-lab/contracts";
import type { TypingBookStartResponse, TypingOverview, TypingResult, TypingWordsStartResponse, TypingDrillsStartResponse, TypingKeysStartResponse, TypingKeysResult, TypingKeysCompleteRequest, DictationAnalytics, DictationAnswerResponse, DictationHintResponse, DictationLessonSummary, DictationResult, DictationState } from "@english-lab/contracts";
import { ApiRequestError, csrfState, send } from "./transport";
import { typed, anyOf } from "./response";

export const fetchTypingOverview = () => send("GET", "/api/v1/typing/overview", typed<TypingOverview>());

export const startTypingWords = () => send("POST", "/api/v1/typing/words/start", typed<TypingWordsStartResponse>(), {});

export const typingWordAppearances = (sessionId: string, appearances: Array<{ planIndex: number; order: number }>) => send("POST", `/api/v1/typing/words/${encodeURIComponent(sessionId)}/appearances`, typed<{ ok: true }>(), { appearances });

export const completeTypingWords = (sessionId: string, body: { status: "completed" | "failed"; activeMs: number; charsTyped: number; errors: number; appearances: Array<{ planIndex: number; order: number }>; destroyedPlanIndexes: number[]; wordErrors?: Array<{ planIndex: number; errors: number }>; bestCombo?: number; bestCharStreak?: number; keyStats?: Array<{ pair: string; count: number; totalMs: number; errors: number }> }) => send("POST", `/api/v1/typing/words/${encodeURIComponent(sessionId)}/complete`, typed<TypingResult>(), body);

export const abortTypingWords = (sessionId: string, body: { activeMs?: number; charsTyped?: number; errors?: number }) => send("POST", `/api/v1/typing/words/${encodeURIComponent(sessionId)}/abort`, typed<{ ok: true }>(), body);

export const startTypingDrills = () => send("POST", "/api/v1/typing/drills/start", typed<TypingDrillsStartResponse>(), {});

export const completeTypingDrills = (sessionId: string, body: { status: "completed" | "failed"; activeMs: number; charsTyped: number; errors: number; words: Array<{ planIndex: number; errors: number; completed: boolean; typeMs: number | null }>; bestCombo?: number; bestCharStreak?: number; keyStats?: Array<{ pair: string; count: number; totalMs: number; errors: number }> }) => send("POST", `/api/v1/typing/drills/${encodeURIComponent(sessionId)}/complete`, typed<TypingResult>(), body);
/** Key Builder (keybr.com guided lessons) */
export const startTypingKeys = () => send("POST", "/api/v1/typing/keys/start", typed<TypingKeysStartResponse>(), {});
export const completeTypingKeys = (lessonId: string, body: TypingKeysCompleteRequest) => send("POST", `/api/v1/typing/keys/${encodeURIComponent(lessonId)}/complete`, typed<TypingKeysResult>(), body);
export const abortTypingKeys = (lessonId: string, body: { activeMs?: number; charsTyped?: number; errors?: number }) => send("POST", `/api/v1/typing/keys/${encodeURIComponent(lessonId)}/abort`, typed<{ status: "interrupted" }>(), body);

/** Finger Drills: one word read aloud by a checked Piper voice (WAV), or an error when no voice read it clearly */

export async function fetchDrillSpeech(word: string): Promise<Blob> {
  if (!csrfState.token) csrfState.token = SessionBootstrapSchema.parse(await (await fetch("/api/v1/session", { headers: { Accept: "application/json" } })).json()).csrfToken;
  const res = await fetch("/api/v1/typing/drills/speech", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfState.token ?? "" }, body: JSON.stringify({ word }) });
  if (!res.ok) {
    if (res.status === 403) csrfState.token = null;
    throw new ApiRequestError(`HTTP_${res.status}`, "Could not read this word aloud.", res.status);
  }
  return res.blob();
}

export const startTypingBook = () => send("POST", "/api/v1/typing/books/start", typed<TypingBookStartResponse>(), {});

export const checkpointTypingBook = (sessionId: string, body: { offset: number; activeMs: number; charsTyped: number; errors: number; charStreak?: { current: number; best: number }; wordObservations?: { errorOffsets: number[] } }) => send("POST", `/api/v1/typing/books/${encodeURIComponent(sessionId)}/checkpoint`, typed<{ ok: true; applied: boolean }>(), body);

export const completeTypingBook = (sessionId: string, body: { offset: number; activeMs: number; charsTyped: number; errors: number; bestCombo?: number; charStreak?: { current: number; best: number }; keyStats?: Array<{ pair: string; count: number; totalMs: number; errors: number }>; wordObservations?: { errorOffsets: number[] } }) => send("POST", `/api/v1/typing/books/${encodeURIComponent(sessionId)}/complete`, typed<TypingResult>(), body);

export const abortTypingBook = (sessionId: string, body: { activeMs?: number; charsTyped?: number; errors?: number }) => send("POST", `/api/v1/typing/books/${encodeURIComponent(sessionId)}/abort`, typed<{ ok: true }>(), body);

export const fetchTypingResult = (sessionId: string) => send("GET", `/api/v1/typing/sessions/${encodeURIComponent(sessionId)}/result`, typed<TypingResult>());

export const fetchTypingRecall = (sessionId: string) => send("GET", `/api/v1/typing/sessions/${encodeURIComponent(sessionId)}/recall`, typed<import("@english-lab/contracts").TypingRecallStartResponse>());

export const saveTypingRecall = (sessionId: string, results: Array<{ entryId: string; correctKeys: number; wrongKeys: number; hints: number; revealed: boolean }>) => send("POST", `/api/v1/typing/sessions/${encodeURIComponent(sessionId)}/recall`, typed<{ points: number; results: Array<{ entryId: string; lemma: string; points: number }> }>(), { results });
/** Books: a sentence read aloud by a Piper voice (made on the spot, kept only in a temporary cache); resolves to the WAV */

export async function fetchBookSpeech(body: { text: string; sessionId: string; paragraph: number } | { text: string }): Promise<Blob> {
  if (!csrfState.token) csrfState.token = SessionBootstrapSchema.parse(await (await fetch("/api/v1/session", { headers: { Accept: "application/json" } })).json()).csrfToken;
  const res = await fetch("sessionId" in body ? "/api/v1/typing/books/speech" : "/api/v1/practice/speech", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfState.token ?? "" }, body: JSON.stringify(body) });
  if (!res.ok) {
    if (res.status === 403) csrfState.token = null;
    const json = (await res.json().catch(() => null)) as { error?: { message?: string }; data?: { error?: { message?: string } } } | null;
    throw new ApiRequestError(`HTTP_${res.status}`, json?.data?.error?.message ?? json?.error?.message ?? "Could not read this sentence aloud.", res.status);
  }
  return res.blob();
}

export const warmBookSpeech = () => send("POST", "/api/v1/typing/books/speech/warm", anyOf<{ ok: boolean }>(), {}).catch(() => undefined);

const DICT = "/api/v1/typing/dictation";

export type RealAuditStatus = { enabled: boolean; running: boolean; checked: number; matched: number; error: string | null; progress: string | null; batch: { total: number; largeDone: number; mediumDone: number; activeModel: string | null; etaSeconds: number | null } | null };
export const fetchRealAudit = () => send("GET", `${DICT}/real-audit`, typed<RealAuditStatus>());
export const setRealAudit = (enabled: boolean) => send("POST", `${DICT}/real-audit`, typed<RealAuditStatus>(), { enabled });

export const createDictationLesson = () => send("POST", `${DICT}/lessons`, typed<DictationLessonSummary>(), {});

export const retryDictationLesson = (id: string) => send("POST", `${DICT}/lessons/${encodeURIComponent(id)}/retry`, typed<DictationLessonSummary>(), {});

export const startDictationLesson = (id: string) => send("POST", `${DICT}/lessons/${encodeURIComponent(id)}/start`, typed<DictationState>(), {});

export const fetchDictationResult = (id: string) => send("GET", `${DICT}/lessons/${encodeURIComponent(id)}/result`, typed<DictationResult>());

export const sendDictationPlay = (exerciseId: string, source: "auto" | "manual" | "wrong_answer") => send("POST", `${DICT}/exercises/${encodeURIComponent(exerciseId)}/play`, typed<{ ok: true }>(), { source });

export const setDictationSoundFlag = (exerciseId: string, flagged: boolean) => send("POST", `${DICT}/exercises/${encodeURIComponent(exerciseId)}/sound-flag`, typed<{ flagged: boolean }>(), { flagged });

export const requestDictationHint = (exerciseId: string, typedText: string) => send("POST", `${DICT}/exercises/${encodeURIComponent(exerciseId)}/hint`, typed<DictationHintResponse>(), { typedText });

export const revealDictationAnswer = (exerciseId: string) => send("POST", `${DICT}/exercises/${encodeURIComponent(exerciseId)}/reveal`, typed<DictationHintResponse>(), {});

export type DictationPoolSummary = { ready: number; used: number; audioSeconds: number; minWords: number; maxWords: number; oldest: string | null; newest: string | null; topics: Array<{ topic: string; n: number }>; topicTotal: number; voices: Array<{ name: string; n: number }> };

export const fetchDictationPool = () => send("GET", `${DICT}/pool`, typed<DictationPoolSummary>());

export const prepareDictationTracks = (count: number) => send("POST", `${DICT}/pool`, typed<{ queued: number }>(), { count });

export const openDictationTranslation = (exerciseId: string) => send("POST", `${DICT}/exercises/${encodeURIComponent(exerciseId)}/translation`, typed<{ translationRu: string }>(), {});

export const answerDictation = (exerciseId: string, body: { attemptId: string; text: string; activeMs: number; typingMs?: number; keystrokes?: number; keyTimes?: Array<{ letter: string; ms: number; timed: number }> }) => send("POST", `${DICT}/exercises/${encodeURIComponent(exerciseId)}/answer`, typed<DictationAnswerResponse>(), body);

export const sendDictationTime = (lessonId: string, activeMs: number) => send("POST", `${DICT}/lessons/${encodeURIComponent(lessonId)}/time`, typed<{ ok: true; applied: boolean }>(), { activeMs });

export async function fetchDictationAudio(exerciseId: string): Promise<Blob> {
  const res = await fetch(`${DICT}/exercises/${encodeURIComponent(exerciseId)}/audio`);
  if (!res.ok) throw new ApiRequestError("AUDIO_UNAVAILABLE", "The audio is not available.");
  return res.blob();
}

export const fetchDictationAnalytics = (days: "7" | "30" | "90" | "all") => send("GET", `/api/v1/analytics/typing/dictation?days=${days}&timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, typed<DictationAnalytics>());
/** fetch with keepalive for `pagehide`/`visibilitychange` checkpoints (CSRF requires fetch, not sendBeacon) */

export type { TypingKeysStartResponse, TypingKeysResult, TypingKeyState, TypingKeyToken, TypingKeyboardAnalytics } from "@english-lab/contracts";
export type { TypingAnalytics as TypingAnalyticsData, TypingBookStartResponse, TypingDrillsStartResponse, TypingOverview, TypingResult, TypingWordsStartResponse } from "@english-lab/contracts";

export type { TypingRecallWord, TypingRecallStartResponse } from "@english-lab/contracts";

export type { DictationAnalytics, DictationAnswerResponse, DictationHintResponse, DictationLessonSummary, DictationResult, DictationState } from "@english-lab/contracts";
