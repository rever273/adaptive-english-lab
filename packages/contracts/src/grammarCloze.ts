/** Grammar Cloze / Sentence Survival (TASK_032): shapes shared by the server and the web app. */
export type ClozeSlotState = "pending" | "correct" | "incorrect" | "excluded";

export interface ClozeStageView {
  stage: number;
  title: string;
  status: "not_started" | "in_progress" | "done" | "locked";
  /** exercises in the pool, without those the learner excluded before answering */
  total: number;
  /** exercises answered in this stage (never more than total) */
  processed: number;
  /** processed / total as text with two decimals, e.g. "12.40" */
  percent: string;
  rulesPresent: number;
  rulesTouched: number;
  rulesCompleted: number;
  excluded: number;
  /** wrong answers of this stage that wait for the next one */
  carriedToNext: number;
  /** a Start/Continue button may be enabled (false for every stage but 1 in TASK_032) */
  ready: boolean;
}

export interface ClozeOverview {
  /** false until `npm run cloze:import` has loaded exercises */
  available: boolean;
  stages: ClozeStageView[];
  activeSession: { id: string; levelNo: number; answered: number; planned: number } | null;
  nextLevelNo: number;
  taskCount: number;
}

export interface ClozeSlotView {
  position: number;
  itemId: string;
  gappedText: string;
  options: string[];
  /** readable name of the rule being tested, or "General Grammar" */
  ruleName: string;
  exact: boolean;
  sourceTopic: string;
  state: ClozeSlotState;
  /** the learner excluded this sentence (also after answering it: the answer stays in the history) */
  excluded: boolean;
  /** only after the answer or the exclusion */
  chosen?: string;
  correct?: string;
}

export interface ClozeSessionView {
  id: string;
  levelNo: number;
  stage: number;
  status: "active" | "completed";
  planned: number;
  answered: number;
  excluded: number;
  slots: ClozeSlotView[];
  nextPosition: number | null;
}

export interface ClozeAnswerResult {
  correct: boolean;
  correctText: string;
  chosenText: string;
}

export interface ClozeSummary {
  levelNo: number;
  stage: number;
  answered: number;
  correct: number;
  incorrect: number;
  excluded: number;
  /** correct / answered, 0..1; null when nothing was answered */
  accuracy: number | null;
  activeMs: number;
  byRule: Array<{ ruleKey: string; name: string; correct: number; incorrect: number }>;
  carriedToNext: number;
  stageProgress: ClozeStageView;
}

export interface ClozeAnalysisOption {
  text: string;
  fits: "yes" | "no" | "maybe";
  why_ru: string;
}
export interface ClozeAnalysisResult {
  verdict: "key_ok" | "several_correct" | "key_wrong" | "ambiguous" | "broken";
  options: ClozeAnalysisOption[];
  rule_en: string;
  explanation_ru: string;
  caution_ru: string;
}
export interface ClozeAnalysisView {
  id: string;
  status: "pending" | "done" | "failed";
  result: ClozeAnalysisResult | null;
  errorCode: string | null;
}
