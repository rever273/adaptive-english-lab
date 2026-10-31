import {
  AttemptResponseSchema,
  AiModelStatusSchema,
  CapabilitiesSchema,
  CreateSessionResponseSchema,
  CurrentSessionResponseSchema,
  DashboardSchema,
  ErrorEnvelopeSchema,
  FeedbackResponseSchema,
  HealthSchema,
  LeaseResponseSchema,
  RevealResponseSchema,
  SessionBootstrapSchema,
  SessionEventResponseSchema,
  SessionSnapshotSchema,
  SessionSummarySchema,
  type AiModelStatus,
  type Capabilities,
  type Health,
} from "@english-lab/contracts";
import type { ZodType } from "zod";

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 0,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function send<T>(method: "GET" | "POST" | "PATCH", path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    if (!csrfToken) {
      // same-origin bootstrap: sets the HttpOnly cookie and hands out the matching CSRF value
      const boot = await fetch("/api/v1/session", { headers: { Accept: "application/json" } });
      csrfToken = SessionBootstrapSchema.parse(await boot.json()).csrfToken;
    }
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiRequestError("NETWORK", "Cannot reach the local English Lab server.");
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 403) csrfToken = null; // a restarted server issues a new token: fetch it again next time
    const env = ErrorEnvelopeSchema.safeParse(json);
    throw new ApiRequestError(env.success ? env.data.error.code : `HTTP_${res.status}`, env.success ? env.data.error.message : "Unexpected server response.", res.status, env.success ? env.data.error.details : null);
  }
  return schema.parse(json);
}

export const fetchHealth = (): Promise<Health> => send("GET", "/api/v1/health", HealthSchema);
export const fetchAiModel = (): Promise<AiModelStatus> => send("GET", "/api/v1/ai/model", AiModelStatusSchema);
export const loadAiModel = (): Promise<AiModelStatus> => send("POST", "/api/v1/ai/model/load", AiModelStatusSchema, {});
export const unloadAiModel = (): Promise<AiModelStatus> => send("POST", "/api/v1/ai/model/unload", AiModelStatusSchema, {});
export const fetchCapabilities = (): Promise<Capabilities> => send("GET", "/api/v1/capabilities", CapabilitiesSchema);

type SettingsValues = { preloadModelOnStart?: boolean; taskCount: number; weakRatio: number; voiceTarget: 0 | 1 | 2; voiceShare?: number; vocabularyTaskCount?: number; vocabularyNewWordsPerSession?: number; reviewNoticeThreshold?: number; difficultyMin?: Level; difficultyMax?: Level };
export type Level = "A2" | "B1" | "B2" | "C1";
type SettingsView = { revision: number; values: SettingsValues; defaults: SettingsValues };
export const fetchSettings = () => send("GET", "/api/v1/settings", typed<SettingsView>());
export const savePreloadModel = (on: boolean) => send("POST", "/api/v1/settings", typed<SettingsView>(), { preloadModelOnStart: on });
export const saveSettings = (values: { taskCount: number; weakRatio: number; voiceShare: number; vocabularyTaskCount?: number; vocabularyNewWordsPerSession?: number; reviewNoticeThreshold?: number; difficultyMin?: Level; difficultyMax?: Level }) => send("POST", "/api/v1/settings", typed<SettingsView>(), values);
export const fetchDashboard = () => send("GET", "/api/v1/dashboard", DashboardSchema);
export type SessionCategory = "grammar" | "vocabulary";
export const fetchCurrentSession = (category: SessionCategory = "grammar") => send("GET", `/api/v1/sessions/current?category=${category}`, CurrentSessionResponseSchema);
export const fetchRecentSession = (category: SessionCategory = "grammar") => send("GET", `/api/v1/sessions/recent?category=${category}`, SessionSummarySchema.nullable());
export const fetchSummary = (id: string) => send("GET", `/api/v1/sessions/${id}/summary`, SessionSummarySchema);
export const voiceDone = (id: string) => send("POST", `/api/v1/sessions/${id}/voice-done`, typed<{ released: boolean }>(), {});
export const fetchSession = (id: string) => send("GET", `/api/v1/sessions/${id}`, SessionSnapshotSchema);
export const createSession = (blueprintRevisionId: string) =>
  send("POST", "/api/v1/sessions", CreateSessionResponseSchema, { purpose: "practice", blueprintRevisionId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
export const createCheckSession = (purpose: "diagnostic" | "heldout") =>
  send("POST", "/api/v1/sessions", CreateSessionResponseSchema, { purpose, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
export const takeLease = (sessionId: string, tabId: string) => send("POST", `/api/v1/sessions/${sessionId}/lease`, LeaseResponseSchema, { tabId });
export const revealSlot = (sessionId: string, slotId: string, tabId: string) => send("POST", `/api/v1/sessions/${sessionId}/reveal`, RevealResponseSchema, { slotId, tabId });
export const submitAttempt = (body: { slotId: string; submissionId: string; answer?: string | string[]; idk?: boolean; transcriptId?: string }) =>
  send("POST", "/api/v1/attempts", AttemptResponseSchema, { ...body, inputMode: body.transcriptId ? "voice" : "text" });
export const sendEvent = (sessionId: string, slotId: string, type: "hint" | "reveal_answer" | "skip" | "continue") =>
  send("POST", `/api/v1/sessions/${sessionId}/events`, SessionEventResponseSchema, { slotId, type, clientEventId: crypto.randomUUID() });
export const fetchFeedback = (sessionId: string, slotId: string) => send("GET", `/api/v1/sessions/${sessionId}/slots/${slotId}/feedback`, FeedbackResponseSchema);
export const finishSession = (sessionId: string, mode: "completed" | "ended_early") => send("POST", `/api/v1/sessions/${sessionId}/finish`, SessionSummarySchema, { mode });

// ---- TASK_010/012: Content Studio and AI tasks. Typed on this side; the server validates every request. ----
const typed = <T>(): ZodType<T> => ({ parse: (x: unknown) => x as T }) as unknown as ZodType<T>;

export type ItemStatus = "queued" | "invalid" | "generated" | "ready_for_review" | "approved" | "released" | "flagged" | "rejected";
export interface BatchSummary {
  id: string;
  category: "grammar" | "vocabulary";
  completion: { accepted: number; corrected: number; rejected: number; flagged: number; total: number } | null;
  createdAt: string;
  mode: string;
  purpose: "trial" | "scale";
  requestedCount: number;
  promptVersion: string;
  counts: Record<ItemStatus, number>;
  reviewedItems: number;
  generationDone: boolean;
  resolved: boolean;
}
export interface BatchItem {
  ordinal: number;
  status: ItemStatus;
  plan: { type: string; target_skill: string; topic: string; noMistake?: boolean; lesson?: string; vocabulary?: { lemma: string } };
  revisionId: string | null;
  contentHash: string | null;
  reviews: number;
  jobId: string | null;
  error: unknown;
  advisory: { source: string; flags: Array<{ code: string; label: string; text: string; score: number }> } | null;
}
export interface TrialGate {
  passed: boolean;
  trialBatchId: string | null;
  reason: string;
  promptVersion: string;
}
export interface Coverage {
  targetPerSkill: number;
  skills: Array<{ skill: string; released: number; approvedUnreleased: number; inReview: number; draft: number; flagged: number; rejected: number; deficit: number }>;
  totals: { skills: number; skillsWithDeficit: number; releasedExercises: number };
}
export interface PublicJob {
  id: string;
  kind: string;
  state: string;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryCount: number;
  errorCode: string | null;
  word?: string | null;
  diagnosticCodes?: string[];
  progress: { done: number; total: number } | null;
}
export type GpuInfo =
  | { available: false; reason: string }
  | { available: true; owner: string | null; fencingToken: number; leaseUntil: string | null; activeJob: { id: string; kind: string; runningForMs: number } | null; residentModels: string[]; practiceActive: boolean; reserveMib: number; telemetry: { usedMib: number; totalMib: number; freeMib: number } | "unavailable"; waitingByReason: Record<string, number> };

export const fetchBatches = () => send("GET", "/api/v1/content/batches", typed<{ batches: BatchSummary[]; trialGate: TrialGate }>());
export const fetchBatch = (id: string) => send("GET", `/api/v1/content/batches/${id}`, typed<BatchSummary & { items: BatchItem[]; trialGate: TrialGate }>());
export const createBatchApi = (body: { count: number; mode: "adaptive" | "balanced" | "manual"; trial?: boolean; category?: "grammar" | "vocabulary" }) => send("POST", "/api/v1/content/batches", typed<{ batchId: string; items: number; units: number }>(), body);
export const fetchContentStock = () => send("GET", "/api/v1/content/stock", typed<Record<"grammar" | "vocabulary", { available: number; threshold: number; low: boolean; message?: string; recommended?: number; lesson?: { key: string; label: string; range: string } }>>());
export const fetchCoverage = () => send("GET", "/api/v1/content/coverage", typed<Coverage>());
export const fetchRevisionContent = (id: string) => send("GET", `/api/v1/content/revisions/${id}`, typed<{ revisionId: string; contentHash: string; status: string; content: Record<string, unknown> }>());
export const importReview = (batchId: string, manifest: unknown) => send("POST", `/api/v1/content/batches/${batchId}/review-import`, typed<{ recorded: number; approved: number; flagged: number; rejected: number }>(), manifest);
export const previewRelease = (revisionIds: string[]) => send("POST", "/api/v1/content/releases/preview", typed<{ manifestHash: string; items: unknown[] }>(), { revisionIds });
export const publishReleaseApi = (body: { revisionIds: string[]; reviewer: string; manifestHash: string }) => send("POST", "/api/v1/content/releases", typed<{ released: number; replayed: boolean }>(), body);
export const fetchJobs = (limit = 30) => send("GET", `/api/v1/jobs?limit=${limit}`, typed<{ jobs: PublicJob[]; counts: Record<string, number>; total: number }>());
export interface AiWave { kind: string; open: number; running: number; waiting: number; paused: number; done: number; failed: number; total: number; msPerItem: number | null; waitingReason: string | null }
export interface AiActivity { waves: AiWave[]; active: { kind: string; runningForMs: number } | null; models: string[]; practiceActive: boolean; telemetry: { usedMib: number; totalMib: number } | null }
export const fetchAiActivity = () => send("GET", "/api/v1/ai/activity", typed<AiActivity>());
export const fetchGpu = () => send("GET", "/api/v1/gpu", typed<GpuInfo>());
export const jobAction = (id: string, action: "pause" | "resume" | "retry" | "cancel") => send("POST", `/api/v1/jobs/${id}/actions`, typed<PublicJob>(), { action });

// ---- TASK_011: voice. Raw PCM goes up once and is dropped; only text comes back. ----
export const sttStart = (sessionId: string, tabId: string) => send("POST", "/api/v1/stt/start", typed<{ streamId: string; maxSeconds: number; ready: { device: string } }>(), { sessionId, tabId });
export const sttConfirm = (streamId: string, draftId: string, slotId: string, text: string) => send("POST", `/api/v1/stt/${streamId}/confirm`, typed<{ transcriptId: string; edited: boolean }>(), { draftId, slotId, text });
export const sttStop = (streamId: string) => send("POST", `/api/v1/stt/${streamId}/stop`, typed<{ stopped: boolean }>(), {});
export async function sttAudio(streamId: string, pcm: Int16Array): Promise<{ draftId: string; text: string }> {
  if (!csrfToken) throw new ApiRequestError("NO_SESSION", "Voice was not started."); // set by the start request that always comes first
  const res = await fetch(`/api/v1/stt/${streamId}/audio`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": csrfToken ?? "" }, body: new Blob([Uint8Array.from(pcm.buffer instanceof ArrayBuffer ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) : [])]) });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const env = ErrorEnvelopeSchema.safeParse(json);
    throw new ApiRequestError(env.success ? env.data.error.code : `HTTP_${res.status}`, env.success ? env.data.error.message : "Unexpected server response.", res.status);
  }
  return json as { draftId: string; text: string };
}

// ---- TASK_014: reports, AI-detected findings, exports ----
export interface Ratio { numerator: number; denominator: number; rate: number | null; wilson: { low: number; high: number } | null; lowN: boolean }
export interface ReportData {
  version: string;
  asOf: string;
  timezone: string;
  cohort: { criterionVersion: string; difficulty: string; protocol: string };
  counts: { attempts: number; slots: number };
  metrics: {
    firstAttemptAccuracy: Ratio & { assisted: { attempts: number; correct: number } };
    practiceAccuracy: Ratio & { note: string };
    heldoutAccuracy: Ratio;
    delayedRetention: Ratio;
    errorRecurrence: { skills: number; failuresAfterFirst: number; opportunitiesAfterFirst: number; rate: Ratio };
    idk: Ratio;
    skip: Ratio;
    pending: { slots: number; attempts: number };
    sessionProgress: { sessionId: string | null; closed: number; total: number };
    courseProgress: { completedBlueprints: number; publishedBlueprints: number };
    vocabulary: { available: boolean; words: number; learned: number; bankOccurrences: number; displayedOccurrences: number };
  };
  byDimension: Record<"recognition" | "correction" | "production", Ratio>;
  skills: Array<{ skillId: string; failures: number; opportunities: number; rate: Ratio }>;
  recurring: Array<{ skillId: string; firstFailure: string; lastFailure: string; failuresAfterFirst: number; opportunitiesAfterFirst: number; spanDays: number; contexts: number }>;
  weeklyHeldout: Array<{ week: string; heldout: Ratio }>;
  weeklyFirstTry: Array<{ week: string; firstTry: Ratio }>;
  comparison: { status: "ok" | "insufficient_comparison_data"; mixDiffers: boolean; current: { from: string; to: string; firstTry: Ratio; heldout: Ratio }; previous: { from: string; to: string; firstTry: Ratio; heldout: Ratio } };
  activity: Array<{ date: string; attempts: number }>;
  otherCohorts: Array<{ criterionVersion: string; difficulty: string; protocol: string; attempts: number }>;
  changeMarkers: Array<{ kind: string; id: string; firstDate: string; lastDate: string; attempts: number }>;
}
export interface SavedReportData { id: string; reused: boolean; inputHash: string; createdAt: string; watermarks: Record<string, number>; report: ReportData }
export interface FindingData {
  findingId: string;
  attemptId: string;
  skillId: string;
  findingType: string;
  correction: string | null;
  explanationRu: string;
  confidence: number | null;
  originalStatus: string;
  effectiveStatus: string;
  label: string;
  history: Array<{ sequence: number; verdict: string; reviewer: string; reason: string; at: string }>;
  inputMode: string;
  transcriptEdited: boolean | null;
  contextId: string;
  isLatestAnalysis: boolean;
  provenance: { model: string | null; digest: string | null; runtime: string | null; prompt: string | null };
}
export interface DiscoveryAuditData { enabled: boolean; disabledReason: string | null; version: string; note: string; config: Record<string, number>; skills: Array<{ skillId: string; attempts: number; contexts: number; bonus: number }> }
export const fetchReport = (q: { protocol: string; difficulty: string }) => send("GET", `/api/v1/analytics/report?protocol=${q.protocol}&difficulty=${q.difficulty}`, typed<SavedReportData>());
export const fetchFindings = () => send("GET", "/api/v1/analytics/findings", typed<{ findings: FindingData[]; discovery: DiscoveryAuditData }>());
export const createExport = (q: { protocol: string; difficulty: string }) => send("POST", "/api/v1/exports", typed<{ dir: string; files: Array<{ name: string; bytes: number }> }>(), q);

// ---- TASK_014b: outside reports (separate series) ----
export interface ExternalData {
  id: string;
  source: string;
  assessedAt: string;
  method: string;
  transcriptQuality: string;
  status: string;
  normalized: { assertions: Array<{ source: { section: string; line: number }; kind: string; text: string; percent: number | null }>; limitations: string[]; flags: string[]; truncated: boolean };
  comparability: { reasons: string[] };
}
export const fetchExternal = () => send("GET", "/api/v1/external-assessments", typed<{ series: ExternalData[]; note: string }>());
export const importExternalReport = (b: { format: "md" | "json"; text: string; source: string; assessedAt: string; method: string }) => send("POST", "/api/v1/external-assessments/import", typed<ExternalData & { created: boolean }>(), b);
export const decideExternalReport = (id: string, d: "confirm" | "reject") => send("POST", `/api/v1/external-assessments/${id}/${d}`, typed<ExternalData>(), {});

// ---- TASK_015: vocabulary ----
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
  /** vocabulary-practice tasks on this word that you have answered (first tries) */
  practised: number;
  bank: { occurrences: number; revisions: number };
  displayed: { occurrences: number; slots: number };
  lastSeen: string | null;
}
interface VocabTotals { words: number; learned: number; bankOccurrences: number; displayedOccurrences: number }
const anyOf = <T>() => ({ parse: (x: unknown) => x as T }) as unknown as ZodType<T>;
export const fetchVocabulary = (q = "") => send("GET", `/api/v1/vocabulary${q ? `?q=${encodeURIComponent(q)}` : ""}`, anyOf<{ words: VocabEntry[]; totals: VocabTotals }>());
export const lookupVocabulary = (word: string) => send("GET", `/api/v1/vocabulary/lookup?word=${encodeURIComponent(word)}`, anyOf<{ known: boolean; entry: VocabEntry | null }>());
export const addVocabulary = (word: string, selected?: string, slotId?: string) => send("POST", "/api/v1/vocabulary", anyOf<VocabEntry & { created: boolean }>(), { word, ...(selected ? { selected } : {}), ...(slotId ? { slotId } : {}) });
export const removeVocabulary = (id: string) => send("POST", `/api/v1/vocabulary/${id}/remove`, anyOf<{ removed: true }>(), {});
export const patchVocabulary = (id: string, body: { expectedRevision?: number; translationRu?: string; exampleEn?: string; collocations?: string[]; pos?: string; learned?: boolean }) => send("PATCH", `/api/v1/vocabulary/${id}`, anyOf<VocabEntry>(), body);

// ---- TASK_016: tutor ----
export interface TutorMessage {
  id: string;
  role: "user" | "assistant";
  kind: string;
  source: "user" | "approved_exercise" | "model";
  status: string;
  text: string;
  examples: string[];
  uncertaintyNoteRu: string | null;
  createdAt: string;
}
export interface TutorThread {
  slotId: string; messages: TutorMessage[]; pendingJobs: number;
  /** kinds of AI answers still being written ("explain_ru", "more_examples", "question") */
  pendingKinds?: string[];
}
export interface TutorSlot { slotId: string; sessionId: string; ordinal: number; revisionId: string; type: string; purpose: string; skill: string; prompt: string; outcome: "correct" | "incorrect" | "idk" | "pending" | "skipped" | string; at: string | null }
export const fetchTutorSlots = (filter: "all" | "mistakes" = "all") => send("GET", `/api/v1/tutor/slots?filter=${filter}`, anyOf<{ slots: TutorSlot[] }>());
export const fetchTutorThread = (slotId: string) => send("GET", `/api/v1/tutor/threads/${slotId}`, anyOf<TutorThread>());
export const askTutor = (body: { sessionId: string; slotId: string; kind: "why" | "explain_ru" | "more_examples" | "question"; question?: string }) => send("POST", "/api/v1/tutor", anyOf<{ threadId: string; jobId: string | null; messages: TutorMessage[] }>(), body);
export const fetchAgentTask = (kind: "session" | "exercise" | "batch" | "findings" | "coverage" | "progress" | "lessons" | "vocabulary" | "review", id?: string) => send("GET", `/api/v1/tutor/agent-task?kind=${kind}${id ? `&id=${encodeURIComponent(id)}` : ""}`, anyOf<{ text: string }>());

// ---- Vocabulary Practice, XP tracks, vocabulary coverage and analytics (vocabulary TZ) ----
export interface TrackProgress { track: "grammar" | "vocabulary"; total: number; level: number; withinLevel: number; threshold: number; ruleVersion: string }
export const fetchActivityProgress = () => send("GET", "/api/v1/activity-progress", typed<{ grammar: TrackProgress; vocabulary: TrackProgress }>());
export interface VocabPracticeStatus { taskCount: number; available: number; freshAvailable?: number; repeatsAvailable?: number; repeatStock?: number; wordsWithContexts: number; words: number; learned: number; approvedForWords: number; draftsNotReleased: number; shortage: { available: number; requested: number; message: string } | null; activeSessionId: string | null }
export const fetchVocabPractice = () => send("GET", "/api/v1/vocabulary/practice", typed<VocabPracticeStatus>());
export const createVocabSession = (count?: number) =>
  send("POST", "/api/v1/vocabulary/sessions", CreateSessionResponseSchema, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(count ? { count } : {}) });
export interface VocabCoverageWord { lemma: string; entryId: string; learned: boolean; approved: number; available: number; shown: number; notReleased: number; families: Record<string, number>; streak?: number; recentMisses?: number; dueNow?: boolean; freshLeft?: number }
export const fetchVocabCoverage = () => send("GET", "/api/v1/vocabulary/coverage", typed<{ words: VocabCoverageWord[]; exercisesForOtherWords: number; sessionSize: number; available: number; warning: string | null }>());
export interface Rate { correct: number; total: number; rate: number | null; insufficient: boolean }
export interface VocabAnalytics {
  version: string;
  window: { days: number | null; since: string | null; timezone: string };
  minSample: number;
  weakMinMisses: number;
  xp: TrackProgress;
  overall: Rate & { assisted: number; pending: number; skipped: number };
  families: Record<"recognition" | "guided_recall" | "collocation", Rate & { assisted: number; pending: number }>;
  series: Array<{ date: string; correct: number; total: number; xp: number }>;
  growth: { series: Array<{ date: string; added: number; learned: number }>; learnedNow: number; learnedWithoutDate: number };
  encounters: { uniqueWordsShown: number; displays: number; bankWords: number; bankContexts: number };
  weak: Array<{ lemma: string; entryId: string | null; attempts: number; misses: number; firstSeen: string; lastSeen: string; lastResult: string | null; example: string | null }>;
  words: Array<{ lemma: string; attempts: number; misses: number; lastSeen: string; lastResult: string | null }>;
  retention: Rate;
  repeats?: { count: number; correct: number; miss: number; assisted: number; pending: number };
}
export const fetchVocabAnalytics = (days: "7" | "30" | "90" | "all") =>
  send("GET", `/api/v1/analytics/vocabulary?days=${days}&timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, typed<VocabAnalytics>());
/** components that change XP (a finished task) announce it so the header refreshes at once */
export const announceXp = () => window.dispatchEvent(new Event("el:xp"));
