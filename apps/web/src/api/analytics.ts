import type { ClozeStageView, TypingAnalytics as TypingAnalyticsData } from "@english-lab/contracts";
import { send } from "./transport";
import { typed, anyOf } from "./response";
import type { SettingsView } from "./system";

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

export const fetchPracticeActivity = () => send("GET", "/api/v1/journey/practice-activity", anyOf<{ days: Array<{ date: string; grammar: number; vocabulary: number }>; grammarResults: Array<{ date: string; correct: number; scored: number; skills: number }> }>());

export interface TrackProgress { track: "grammar" | "vocabulary" | "typing" | "conversation"; total: number; level: number; withinLevel: number; threshold: number; ruleVersion: string; levelRule?: string }

export const fetchActivityProgress = () => send("GET", "/api/v1/activity-progress", typed<{ grammar: TrackProgress; vocabulary: TrackProgress; typing: TrackProgress; conversation: TrackProgress }>());

export const fetchTypingAnalytics = (mode: "words" | "books" | "drills", days: "7" | "30" | "90" | "all") => send("GET", `/api/v1/analytics/typing?mode=${mode}&days=${days}&timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, typed<TypingAnalyticsData>());

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
  encounters: { uniqueWordsShown: number; displays: number; bankWords: number; bankContexts: number; typedInBooks: { words: number; occurrences: number } };
  weak: Array<{ lemma: string; entryId: string | null; attempts: number; misses: number; firstSeen: string; lastSeen: string; lastResult: string | null; example: string | null }>;
  words: Array<{ lemma: string; attempts: number; misses: number; lastSeen: string; lastResult: string | null }>;
  retention: Rate;
  repeats?: { count: number; correct: number; miss: number; assisted: number; pending: number };
}

export const fetchVocabAnalytics = (days: "7" | "30" | "90" | "all") =>
  send("GET", `/api/v1/analytics/vocabulary?days=${days}&timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, typed<VocabAnalytics>());
/** components that change XP (a finished task) announce it so the header refreshes at once */

export const announceXp = () => window.dispatchEvent(new Event("el:xp"));

export type JourneyMode = "grammar" | "vocabulary" | "words" | "books" | "dictation" | "wordLesson" | "grammarCloze" | "conversation";

export type JourneyData = { version: string; timezone: string; today: string; totals: Record<JourneyMode, number>; todayMs: Record<JourneyMode, number>; activeDays: number; journeyHours: {b2:number;c1:number;c2:number}; dailyMinutes: Record<JourneyMode,number>; dailyOrder: JourneyMode[]; bookMinutes:number };

export const fetchJourney = () => send("GET", "/api/v1/journey", typed<JourneyData>());

export type ConversationAnalyticsData = { conversations:number; answers:number; activeMs:number; sentences:number; availableAnswers:number; good:number; suggestions:number; unclassified:number; deletedSessions:number; series:Array<{startedAt:string;answers:number;activeMs:number;good:number;suggestions:number}>; sessions:Array<{topic:string;startedAt:string;updatedAt:string;activeMs:number;answers:number;historyDeleted:number}> };

export const fetchConversationAnalytics = (days: "7" | "30" | "90" | "all") => send("GET", `/api/v1/analytics/conversation?days=${days}`, typed<ConversationAnalyticsData>());

export const fetchJourneyDailyTotals = () => send("GET", "/api/v1/journey/daily-totals", typed<{ days: Array<{ date: string; ms: number }> }>());

export const saveJourneySettings = (body: { journeyHours?: JourneyData["journeyHours"]; dailyMinutes?: JourneyData["dailyMinutes"]; dailyOrder?: JourneyMode[] }) => send("POST", "/api/v1/settings", typed<SettingsView>(), body);

export const recordTypingInterval = (body: {id:string;sessionId:string;mode:"words"|"books"|"dictation";startMs:number;endMs:number}) => send("POST", "/api/v1/journey/typing-interval", typed<{recorded:boolean}>(), body);

export type ClozeWindow = { from: string; to: string; answered: number; correct: number };

export type ClozeAnalyticsData = {
  totals: { sessions: number; answered: number; correct: number; incorrect: number; excluded: number; activeMs: number };
  byDay: Array<{ day: string; answered: number; correct: number; activeMs: number; medianMs: number | null }>;
  weekly: Array<{ week: string; answered: number; correct: number }>;
  comparison: { current: ClozeWindow; previous: ClozeWindow };
  progress: Array<{ day: string; processed: number; percent: number }>;
  ruleSeries: { bucket: "day" | "week"; labels: string[]; series: Array<{ ruleKey: string; name: string; answered: number; accuracy: Array<number | null>; counts: number[] }> };
  byRule: Array<{ ruleKey: string; name: string; exact: boolean; answered: number; correct: number; accuracy: number }>;
  responseMs: { median: number | null; p75: number | null };
  stages: ClozeStageView[];
};

export const fetchClozeAnalytics = (days: "7" | "30" | "90" | "all") => send("GET", `/api/v1/grammar-cloze/analytics?days=${days}`, typed<ClozeAnalyticsData>());

export type GrammarTrendsData = {
  byDay: Array<{ date: string; scored: number; correct: number; medianMs: number | null }>;
  skillSeries: { bucket: "day" | "week"; labels: string[]; series: Array<{ skillId: string; name: string; answered: number; accuracy: Array<number | null>; counts: number[] }> };
};

export const fetchGrammarTrends = (days: "7" | "30" | "90" | "all") => send("GET", `/api/v1/analytics/grammar-trends?days=${days}`, typed<GrammarTrendsData>());
