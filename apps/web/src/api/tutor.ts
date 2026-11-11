import { send } from "./transport";
import { anyOf } from "./response";

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
