import { send } from "./transport";
import { typed } from "./response";

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
  phase?: string | null;
  progress: { done: number; total: number } | null;
}

export type GpuInfo =
  | { available: false; reason: string }
  | { available: true; owner: string | null; fencingToken: number; leaseUntil: string | null; activeJob: { id: string; kind: string; runningForMs: number } | null; residentModels: string[]; practiceActive: boolean; reserveMib: number; telemetry: { usedMib: number; totalMib: number; freeMib: number } | "unavailable"; waitingByReason: Record<string, number> };

export type StudioBatchSummary = Pick<BatchSummary, "id" | "createdAt" | "category" | "requestedCount" | "completion"> & { counts: BatchSummary["counts"] | null };

export const fetchStudioBatches = () => send("GET", "/api/v1/content/batch-summaries", typed<{ batches: StudioBatchSummary[] }>());

export const fetchBatches = () => send("GET", "/api/v1/content/batches", typed<{ batches: BatchSummary[]; trialGate: TrialGate }>());

export const fetchBatch = (id: string) => send("GET", `/api/v1/content/batches/${id}`, typed<BatchSummary & { items: BatchItem[]; trialGate: TrialGate }>());

export const createBatchApi = (body: { count: number; mode: "adaptive" | "balanced" | "manual"; trial?: boolean; category?: "grammar" | "vocabulary" }) => send("POST", "/api/v1/content/batches", typed<{ batchId: string; items: number; units: number }>(), body);

export const createAgentBatchApi = (body: { count: number; mode: "adaptive" | "balanced" | "manual"; trial?: boolean; category?: "grammar" | "vocabulary" }) => send("POST", "/api/v1/content/batches/agent", typed<{ batchId: string; items: number; units: number }>(), body);

export const fetchContentStock = () => send("GET", "/api/v1/content/stock", typed<Record<"grammar" | "vocabulary", { available: number; threshold: number; low: boolean; message?: string; recommended?: number; plan?: { words: number; deficit: number; recommended: number; targetPerWord: number }; course?: { lessons: number; sessions: number; first: string | null; last: string | null; deficit: number; recommended: number; sessionsPerLesson: number }; lesson?: { key: string; label: string; range: string } }>>());

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

export interface ThoughtItem { id: string; textRu: string; createdAt: string; status: "pending" | "needs_skills" | "ok" | "ambiguous" | "no_skill" | "failed"; englishDraft: string | null }

export const fetchThoughts = () => send("GET", "/api/v1/thoughts", typed<{ thoughts: ThoughtItem[]; readyForBatch: number; needSkills: number }>());

export const addThought = (text: string) => send("POST", "/api/v1/thoughts", typed<{ thought: ThoughtItem; created: boolean }>(), { text });

export const createThoughtBatchApi = () => send("POST", "/api/v1/thoughts/batch", typed<{ batchId: string; items: number; thoughts: number }>(), {});
