import { SessionBootstrapSchema } from "@english-lab/contracts";
import { ApiRequestError, csrfState, send } from "./transport";
import { typed } from "./response";

export type ConversationState = { session: { id: string; topic: string; status: string; activeMs: number; answerCount: number }; messages: Array<{ id: string; role: "user" | "assistant"; text: string; analysisStatus: string | null; analysis: string | null }>; vocabulary: string[]; jobs: Array<{ id: string; state: string; errorCode: string | null; action: string; messageId: string | null }> };

export type ConversationHome = { topics: string[]; topicGroups: Record<string, string>; latest: { id: string; topic: string; updatedAt: string } | null; statistics: { conversations: number; answers: number; activeMs: number } };

export const conversationHome = () => send("GET", "/api/v1/conversations", typed<ConversationHome>());

export const conversationStart = (topic: string, tabId: string) => send("POST", "/api/v1/conversations", typed<ConversationState>(), { topic, tabId });

export const conversationRead = (id: string) => send("GET", `/api/v1/conversations/${encodeURIComponent(id)}`, typed<ConversationState>());

export const conversationResume = (id: string, tabId: string) => send("POST", `/api/v1/conversations/${encodeURIComponent(id)}/resume`, typed<ConversationState>(), { tabId });

export const conversationPause = (id: string, tabId: string) => send("POST", `/api/v1/conversations/${encodeURIComponent(id)}/pause`, typed<{ ok: boolean }>(), { tabId });

export const conversationHeartbeat = (id: string, tabId: string) => send("POST", `/api/v1/conversations/${encodeURIComponent(id)}/heartbeat`, typed<{ ok: boolean }>(), { tabId });

export const conversationMessage = (id: string, tabId: string, messageId: string, text: string) => send("POST", `/api/v1/conversations/${encodeURIComponent(id)}/messages`, typed<ConversationState>(), { tabId, messageId, text });

export const conversationSttStart = (id: string, tabId: string) => send("POST", `/api/v1/conversations/${encodeURIComponent(id)}/stt/start`, typed<{ streamId: string; maxSeconds: number; ready: { device: string } }>(), { tabId });

export const conversationDelete = (id: string) => send("POST", `/api/v1/conversations/${encodeURIComponent(id)}/delete-history`, typed<{ ok: boolean }>(), {});

export const conversationRetry = (id: string, jobId: string) => send("POST", `/api/v1/conversations/${encodeURIComponent(id)}/retry`, typed<{ ok: boolean }>(), { jobId });

export async function conversationSpeech(id: string, messageId: string): Promise<Blob> {
  if (!csrfState.token) csrfState.token = SessionBootstrapSchema.parse(await (await fetch("/api/v1/session", { headers: { Accept: "application/json" } })).json()).csrfToken;
  const res = await fetch(`/api/v1/conversations/${encodeURIComponent(id)}/speech`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfState.token ?? "" }, body: JSON.stringify({ messageId }) });
  if (!res.ok) { if (res.status === 403) csrfState.token = null; throw new ApiRequestError("SPEECH_UNAVAILABLE", "Voice playback is unavailable.", res.status); }
  return res.blob();
}
