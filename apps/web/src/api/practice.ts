import { AttemptResponseSchema, CreateSessionResponseSchema, CurrentSessionResponseSchema, DashboardSchema, FeedbackResponseSchema, LeaseResponseSchema, RevealResponseSchema, SessionEventResponseSchema, SessionSnapshotSchema, SessionSummarySchema } from "@english-lab/contracts";
import type { ClozeAnalysisView, ClozeAnswerResult, ClozeOverview, ClozeSessionView, ClozeSummary } from "@english-lab/contracts";
import { send } from "./transport";
import { typed } from "./response";

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

export const recordPracticeActivity = (sessionId: string, body: { id: string; tabId: string; startMs: number; endMs: number }) => send("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/activity`, typed<{ recorded: boolean }>(), { id: body.id, tabId: body.tabId, startMs: body.startMs, endMs: body.endMs });

export const takeLease = (sessionId: string, tabId: string) => send("POST", `/api/v1/sessions/${sessionId}/lease`, LeaseResponseSchema, { tabId });

export const revealSlot = (sessionId: string, slotId: string, tabId: string) => send("POST", `/api/v1/sessions/${sessionId}/reveal`, RevealResponseSchema, { slotId, tabId });

export const submitAttempt = (body: { slotId: string; submissionId: string; answer?: string | string[]; idk?: boolean; transcriptId?: string }) =>
  send("POST", "/api/v1/attempts", AttemptResponseSchema, { ...body, inputMode: body.transcriptId ? "voice" : "text" });

export const sendEvent = (sessionId: string, slotId: string, type: "hint" | "vocabulary_translation" | "vocabulary_letters" | "reveal_answer" | "skip" | "continue", letterIndex?: number) =>
  send("POST", `/api/v1/sessions/${sessionId}/events`, SessionEventResponseSchema, { slotId, type, clientEventId: crypto.randomUUID(), ...(letterIndex !== undefined ? { letterIndex } : {}) });

export const fetchFeedback = (sessionId: string, slotId: string) => send("GET", `/api/v1/sessions/${sessionId}/slots/${slotId}/feedback`, FeedbackResponseSchema);

export const finishSession = (sessionId: string, mode: "completed" | "ended_early") => send("POST", `/api/v1/sessions/${sessionId}/finish`, SessionSummarySchema, { mode });

export const fetchClozeOverview = () => send("GET", "/api/v1/grammar-cloze/overview", typed<ClozeOverview>());

export const startClozeSession = (tabId: string) => send("POST", "/api/v1/grammar-cloze/sessions", typed<{ resumed: boolean; session: ClozeSessionView }>(), { tabId });

export const fetchClozeSession = (id: string) => send("GET", `/api/v1/grammar-cloze/sessions/${encodeURIComponent(id)}`, typed<ClozeSessionView>());

export const markClozeShown = (id: string, position: number) => send("POST", `/api/v1/grammar-cloze/sessions/${encodeURIComponent(id)}/shown`, typed<{ ok: boolean }>(), { position });

export const answerCloze = (id: string, body: { id: string; position: number; chosen: string; responseMs?: number }) => send("POST", `/api/v1/grammar-cloze/sessions/${encodeURIComponent(id)}/answers`, typed<ClozeAnswerResult>(), body);

export const excludeClozeItem = (itemId: string, body: { sessionId?: string; reason?: string }) => send("POST", `/api/v1/grammar-cloze/items/${encodeURIComponent(itemId)}/exclude`, typed<{ excluded: boolean }>(), body);

export const completeClozeSession = (id: string) => send("POST", `/api/v1/grammar-cloze/sessions/${encodeURIComponent(id)}/complete`, typed<ClozeSummary>(), {});

export const recordClozeActivity = (id: string, body: { id: string; tabId: string; startMs: number; endMs: number }) => send("POST", `/api/v1/grammar-cloze/sessions/${encodeURIComponent(id)}/activity`, typed<{ recorded: boolean }>(), body);

export const requestClozeAnalysis = (itemId: string, body: { sessionId: string; position: number }) => send("POST", `/api/v1/grammar-cloze/items/${encodeURIComponent(itemId)}/analysis`, typed<ClozeAnalysisView>(), body);

export const fetchClozeAnalysis = (id: string) => send("GET", `/api/v1/grammar-cloze/analyses/${encodeURIComponent(id)}`, typed<ClozeAnalysisView>());

export type { ClozeOverview, ClozeSessionView, ClozeSummary, ClozeAnswerResult, ClozeSlotView, ClozeStageView, ClozeAnalysisView } from "@english-lab/contracts";
