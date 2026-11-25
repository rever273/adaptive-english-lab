import type { VtAnalytics, VtOverview, VtSessionState, VtTyping, VtWordFilter, VtWordRow } from "@english-lab/contracts";
import { send } from "./transport";
import { typed } from "./response";

const base = "/api/v1/typing/vocab";
const session = (id: string, tail: string) => `${base}/sessions/${encodeURIComponent(id)}/${tail}`;

export const fetchVocabTypingOverview = () => send("GET", `${base}/overview`, typed<VtOverview>());
export const startVocabScreening = (tabId: string) => send("POST", `${base}/screening/start`, typed<{ sessionId: string; resumed: boolean; state: VtSessionState }>(), { tabId });
export const startVocabLearning = (tabId: string) => send("POST", `${base}/learning/start`, typed<{ sessionId: string; resumed: boolean; state: VtSessionState }>(), { tabId });
export const fetchVocabSession = (id: string) => send("GET", `${base}/sessions/${encodeURIComponent(id)}`, typed<VtSessionState>());
export type VocabEventBody =
  | { clientEventId: string; tabId: string; kind: "screen_known" | "screen_unknown" | "screen_archived"; lemma: string; typing: VtTyping }
  | { clientEventId: string; tabId: string; kind: "learn_exposure" | "learn_learned"; cardIndex: number; typing: VtTyping };
export const sendVocabEvent = (id: string, body: VocabEventBody) => send("POST", session(id, "events"), typed<VtSessionState>(), body);
export const sendVocabReview = (id: string, body: { clientEventId: string; tabId: string; cardIndex: number; text: string | null }) => send("POST", session(id, "reviews"), typed<VtSessionState>(), body);
export const flagVocabSentence = (id: string, body: { clientEventId: string; tabId: string; cardIndex: number }) => send("POST", session(id, "flag"), typed<VtSessionState>(), body);
export const completeVocabSession = (id: string, body: { tabId: string; keyStats?: Array<{ pair: string; count: number; totalMs: number; errors: number }> }) => send("POST", session(id, "complete"), typed<VtSessionState>(), body);
export const recordVocabActivity = (id: string, body: { id: string; tabId: string; startMs: number; endMs: number }) => send("POST", session(id, "activity"), typed<{ recorded: boolean }>(), body);
export const fetchVocabTypingAnalytics = (days: number) => send("GET", `${base}/analytics?days=${days}`, typed<VtAnalytics>());
export const fetchVocabWords = (q: { state?: VtWordFilter; q?: string; limit?: number; offset?: number }) =>
  send("GET", `${base}/words?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`, typed<{ total: number; words: VtWordRow[] }>());
export const restoreVocabWord = (lemma: string) => send("POST", `${base}/words/${encodeURIComponent(lemma)}/restore`, typed<VtOverview>(), {});
export type { VtAnalytics, VtOverview, VtSessionState, VtWordRow, VtWordFilter } from "@english-lab/contracts";
