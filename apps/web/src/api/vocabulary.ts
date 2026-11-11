import { CreateSessionResponseSchema, ErrorEnvelopeSchema, SessionBootstrapSchema } from "@english-lab/contracts";
import type { WordLessonEventKind, WordLessonListResponse, WordLessonRunState, WordLessonStudioStatus } from "@english-lab/contracts";
import { ApiRequestError, csrfState, send } from "./transport";
import { typed, anyOf } from "./response";

export type VocabularySpeechStatus = { enabled: boolean; configured: boolean; requests: number; blockedUntil: string | null };

export const fetchVocabularySpeech = () => send("GET", "/api/v1/vocabulary-speech", typed<VocabularySpeechStatus>());

export type VocabularySpeechCredits = { available: boolean; reason?: string; used?: number; limit?: number; remaining?: number; resetsAt?: string | null; tier?: string | null; appCharacters30d: number };

export const fetchVocabularySpeechCredits = () => send("GET", "/api/v1/vocabulary-speech/credits", typed<VocabularySpeechCredits>());

export const setVocabularySpeech = (enabled: boolean) => send("POST", "/api/v1/vocabulary-speech/settings", typed<VocabularySpeechStatus>(), { enabled });

async function speechRequest(path: string, signal?: AbortSignal): Promise<Blob | null> {
  if (!csrfState.token) {
    const boot = await fetch("/api/v1/session", { signal });
    csrfState.token = SessionBootstrapSchema.parse(await boot.json()).csrfToken;
  }
  const res = await fetch(path, { method: "POST", headers: { "X-CSRF-Token": csrfState.token }, signal });
  if (!res.ok) {
    if (res.status === 403) csrfState.token = null;
    const error = ErrorEnvelopeSchema.safeParse(await res.json().catch(() => null));
    throw new ApiRequestError(error.success ? error.data.error.code : `HTTP_${res.status}`, error.success ? error.data.error.message : "Unable to play pronunciation.", res.status);
  }
  return res.status === 204 ? null : res.blob();
}

export const vocabularySpeech = (sessionId: string, slotId: string, signal: AbortSignal) => speechRequest(`/api/v1/vocabulary-speech/${encodeURIComponent(sessionId)}/${encodeURIComponent(slotId)}`, signal);
/** the word panel's pronounce button: any English word or short phrase, saved or not (ElevenLabs only when the file is not stored yet) */

export async function vocabularyTextSpeech(text: string): Promise<Blob | null> {
  if (!csrfState.token) {
    const boot = await fetch("/api/v1/session");
    csrfState.token = SessionBootstrapSchema.parse(await boot.json()).csrfToken;
  }
  const res = await fetch("/api/v1/vocabulary-speech/text", { method: "POST", headers: { "X-CSRF-Token": csrfState.token, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) {
    if (res.status === 403) csrfState.token = null;
    const error = ErrorEnvelopeSchema.safeParse(await res.json().catch(() => null));
    throw new ApiRequestError(error.success ? error.data.error.code : `HTTP_${res.status}`, error.success ? error.data.error.message : "Unable to play pronunciation.", res.status);
  }
  return res.status === 204 ? null : res.blob();
}

export type MatchWord = { id: string; en: string; ru: string };
/** the words of a finished vocabulary session for the matching game (read-only, not evidence) */

export const fetchMatchWords = (sessionId: string) => send("GET", `/api/v1/vocabulary-sessions/${encodeURIComponent(sessionId)}/match-words`, typed<{ words: MatchWord[] }>());
/** the raw result of a played matching game (not Mastery evidence); sent once, a repeat changes nothing */

export const saveMatchResults = (sessionId: string, mode: "once" | "rush", results: Array<{ lemma: string; matched: number; wrong: number }>) =>
  send("POST", `/api/v1/vocabulary-sessions/${encodeURIComponent(sessionId)}/match-results`, typed<{ saved: boolean }>(), { mode, results });

export const vocabularyWordSpeech = (id: string) => speechRequest(`/api/v1/vocabulary-speech/word/${encodeURIComponent(id)}`);

type Src = "user" | "ai_draft" | null;

export interface VocabEntry {
  id: string;
  lemma: string;
  pos: string;
  learned: boolean;
  userRevision: number;
  surfaceForms: string[];
  translation: { text: string; source: Src };
  example: { text: string; source: Src };
  collocations: { items: string[]; source: Src };
  draftPredatesEdit: boolean;
  aiPending: boolean;
  aiError?: string | null;
  aiExampleOmitted?: boolean;
  posSource: Src | "entry";
  /** AI draft CEFR level (A1..C2) of the word in the sense it was met, or null (D64) */
  level: string | null;
  /** reference facts from the word job (D69), or null until it has run */
  lexicon: { transcription: string; definitionRu: string; synonyms: string[]; irregularForms: string[]; frequency: number | null } | null;
  /** vocabulary-practice tasks on this word that you have answered (first tries) */
  practised: number;
  bank: { occurrences: number; revisions: number };
  displayed: { occurrences: number; slots: number };
  lastSeen: string | null;
  createdAt: string;
}

interface VocabTotals { words: number; learned: number; bankOccurrences: number; displayedOccurrences: number }

export const fetchVocabulary = (q = "", options?: { limit?: number; notLearned?: boolean }) => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.notLearned) params.set("learned", "false");
  return send("GET", `/api/v1/vocabulary${params.size ? `?${params}` : ""}`, anyOf<{ words: VocabEntry[]; total: number; totals: VocabTotals }>());
};

export type WordBankMatch = { lemma: string; translationRu: string; partOfSpeech: string; form?: "past" | "participle" };

export const lookupVocabulary = (word: string) => send("GET", `/api/v1/vocabulary/lookup?word=${encodeURIComponent(word)}`, anyOf<{ known: boolean; entry: VocabEntry | null; wordBank: WordBankMatch[] }>());

export const translateSentence = (text: string) => send("POST", "/api/v1/translate", anyOf<{ text: string }>(), { text });

export const matchVocabulary = (words: string[]) => send("POST", "/api/v1/vocabulary/match", anyOf<{ matches: Array<{ word: string; lemma: string; translationRu: string }> }>(), { words });

export const addVocabulary = (word: string, selected?: string, slotId?: string) => send("POST", "/api/v1/vocabulary", anyOf<VocabEntry & { created: boolean }>(), { word, ...(selected ? { selected } : {}), ...(slotId ? { slotId } : {}) });

export const removeVocabulary = (id: string) => send("POST", `/api/v1/vocabulary/${id}/remove`, anyOf<{ removed: true }>(), {});

export const patchVocabulary = (id: string, body: { expectedRevision?: number; translationRu?: string; exampleEn?: string; collocations?: string[]; pos?: string; learned?: boolean }) => send("PATCH", `/api/v1/vocabulary/${id}`, anyOf<VocabEntry>(), body);

export interface ExpressionView { id: string; phrase: string; translationRu: string; exampleEn: string; descriptionRu: string; source: "model" | "user" | null; state: "ready" | "generating" | "failed"; createdAt: string; inSentences: number; shown: number }

export const fetchExpressions = () => send("GET", "/api/v1/vocabulary/expressions", typed<{ expressions: ExpressionView[] }>());

export const addExpression = (phrase: string) => send("POST", "/api/v1/vocabulary/expressions", typed<ExpressionView & { created: boolean }>(), { phrase });

export const editExpression = (id: string, body: { translationRu?: string; exampleEn?: string; descriptionRu?: string }) => send("POST", `/api/v1/vocabulary/expressions/${encodeURIComponent(id)}/edit`, typed<ExpressionView>(), body);

export const retryExpression = (id: string) => send("POST", `/api/v1/vocabulary/expressions/${encodeURIComponent(id)}/retry`, typed<ExpressionView>(), {});

export const removeExpression = (id: string) => send("POST", `/api/v1/vocabulary/expressions/${encodeURIComponent(id)}/remove`, typed<{ removed: true }>(), {});

export interface VocabPracticeStatus { wordQueue?: { due: number; newWords: number; recent: number }; taskCount: number; available: number; freshAvailable?: number; repeatsAvailable?: number; repeatStock?: number; wordsWithContexts: number; words: number; learned: number; approvedForWords: number; draftsNotReleased: number; shortage: { available: number; requested: number; message: string } | null; activeSessionId: string | null }

export const fetchVocabPractice = () => send("GET", "/api/v1/vocabulary/practice", typed<VocabPracticeStatus>());

export const createVocabSession = (count?: number) =>
  send("POST", "/api/v1/vocabulary/sessions", CreateSessionResponseSchema, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(count ? { count } : {}) });

export interface VocabCoverageWord { lemma: string; entryId: string; learned: boolean; approved: number; available: number; shown: number; notReleased: number; families: Record<string, number>; streak?: number; recentMisses?: number; dueNow?: boolean; freshLeft?: number }

export const fetchVocabCoverage = () => send("GET", "/api/v1/vocabulary/coverage", typed<{ words: VocabCoverageWord[]; exercisesForOtherWords: number; sessionSize: number; available: number; warning: string | null }>());

export const fetchWordLessons = () => send("GET", "/api/v1/word-lessons", typed<WordLessonListResponse>());

export const fetchWordLessonStudio = () => send("GET", "/api/v1/word-lessons/studio", typed<WordLessonStudioStatus>());

export const generateWordLessons = (count: number) => send("POST", "/api/v1/word-lessons/generate", typed<{ created: number; status: WordLessonStudioStatus }>(), { count });

export const retryWordLessons = () => send("POST", "/api/v1/word-lessons/retry-failed", typed<{ queued: number; status: WordLessonStudioStatus }>(), {});

export const startWordLessonRun = (lessonId: string, tabId: string) => send("POST", `/api/v1/word-lessons/${encodeURIComponent(lessonId)}/runs`, typed<{ runId: string; resumed: boolean; state: WordLessonRunState }>(), { tabId });

export const fetchWordLessonRun = (runId: string) => send("GET", `/api/v1/word-lesson-runs/${encodeURIComponent(runId)}`, typed<WordLessonRunState>());

const lessonRun = (runId: string, tail: string) => `/api/v1/word-lesson-runs/${encodeURIComponent(runId)}/${tail}`;

export const sendWordLessonEvent = (runId: string, itemKey: string, kind: WordLessonEventKind) => send("POST", lessonRun(runId, "events"), typed<WordLessonRunState>(), { id: crypto.randomUUID(), itemKey, kind });

export const sendWordLessonAttempt = (runId: string, body: { id: string; itemKey: string; text: string; input: "text" | "voice"; streamId?: string; draftId?: string }) => send("POST", lessonRun(runId, "attempts"), typed<WordLessonRunState>(), body);

export const disputeWordLessonAttempt = (runId: string, attemptId: string, reason?: string) => send("POST", lessonRun(runId, `attempts/${encodeURIComponent(attemptId)}/dispute`), typed<WordLessonRunState>(), reason ? { reason } : {});

export const giveUpWordLessonCheck = (runId: string, attemptId: string) => send("POST", lessonRun(runId, `attempts/${encodeURIComponent(attemptId)}/give-up`), typed<WordLessonRunState>(), {});

export const completeWordLessonRun = (runId: string) => send("POST", lessonRun(runId, "complete"), typed<WordLessonRunState>(), {});

export const recordWordLessonActivity = (runId: string, body: { id: string; tabId: string; startMs: number; endMs: number }) => send("POST", lessonRun(runId, "activity"), typed<{ recorded: boolean }>(), body);
/** same shape as `sttStart`, so the voice hook can open a lesson run's stream (a stable module-level function) */

export const wordLessonSttStart = (runId: string, tabId: string) => send("POST", lessonRun(runId, "stt/start"), typed<{ streamId: string; maxSeconds: number; ready: { device: string } }>(), { tabId });

export type { WordLessonListResponse, WordLessonRunState, WordLessonStudioStatus } from "@english-lab/contracts";
