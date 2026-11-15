// Public API facade. Domain modules share the single transport and CSRF state.

export { ApiRequestError } from "./api/transport";

export {
  fetchHealth,
  fetchAiModel,
  loadAiModel,
  unloadAiModel,
  fetchCapabilities,
  fetchSettings,
  savePreloadModel,
  saveSettings,
  fetchDeepLUsage,
  fetchGroqStatus,
  sttStart,
  sttConfirm,
  sttStop,
  sttAudio,
  sendKeepalive,
  fetchVoices,
  saveVoiceSettings,
  fetchVoiceHistory,
  fetchVoiceSample
} from "./api/system";

export type {
  Level,
  GroqStatus,
  DeepLUsage,
  VoiceSampleStats,
  VoiceInfo,
  VoiceSettingsUpdate
} from "./api/system";

export {
  fetchDashboard,
  fetchCurrentSession,
  fetchRecentSession,
  fetchSummary,
  voiceDone,
  fetchSession,
  createSession,
  createCheckSession,
  recordPracticeActivity,
  takeLease,
  revealSlot,
  submitAttempt,
  sendEvent,
  fetchFeedback,
  finishSession,
  fetchClozeOverview,
  startClozeSession,
  fetchClozeSession,
  markClozeShown,
  answerCloze,
  excludeClozeItem,
  completeClozeSession,
  recordClozeActivity,
  requestClozeAnalysis,
  fetchClozeAnalysis
} from "./api/practice";

export type {
  SessionCategory,
  ClozeOverview,
  ClozeSessionView,
  ClozeSummary,
  ClozeAnswerResult,
  ClozeSlotView,
  ClozeStageView,
  ClozeAnalysisView
} from "./api/practice";

export {
  fetchVocabularySpeech,
  fetchVocabularySpeechCredits,
  setVocabularySpeech,
  vocabularySpeech,
  vocabularyTextSpeech,
  fetchMatchWords,
  saveMatchResults,
  vocabularyWordSpeech,
  fetchVocabulary,
  lookupVocabulary,
  translateSentence,
  matchVocabulary,
  addVocabulary,
  removeVocabulary,
  patchVocabulary,
  fetchExpressions,
  addExpression,
  editExpression,
  retryExpression,
  removeExpression,
  fetchVocabPractice,
  createVocabSession,
  fetchVocabCoverage,
  fetchWordLessons,
  fetchWordLessonStudio,
  generateWordLessons,
  retryWordLessons,
  startWordLessonRun,
  fetchWordLessonRun,
  sendWordLessonEvent,
  sendWordLessonAttempt,
  disputeWordLessonAttempt,
  giveUpWordLessonCheck,
  completeWordLessonRun,
  recordWordLessonActivity,
  wordLessonSttStart
} from "./api/vocabulary";

export type {
  VocabularySpeechStatus,
  VocabularySpeechCredits,
  MatchWord,
  VocabEntry,
  WordBankMatch,
  ExpressionView,
  VocabPracticeStatus,
  VocabCoverageWord,
  WordLessonListResponse,
  WordLessonRunState,
  WordLessonStudioStatus
} from "./api/vocabulary";

export {
  fetchTypingOverview,
  startTypingWords,
  typingWordAppearances,
  completeTypingWords,
  abortTypingWords,
  startTypingDrills,
  completeTypingDrills,
  startTypingKeys,
  completeTypingKeys,
  abortTypingKeys,
  fetchDrillSpeech,
  startTypingBook,
  checkpointTypingBook,
  completeTypingBook,
  abortTypingBook,
  fetchTypingResult,
  fetchTypingRecall,
  saveTypingRecall,
  fetchBookSpeech,
  warmBookSpeech,
  createDictationLesson,
  retryDictationLesson,
  startDictationLesson,
  fetchDictationResult,
  sendDictationPlay,
  setDictationSoundFlag,
  requestDictationHint,
  revealDictationAnswer,
  fetchDictationPool,
  prepareDictationTracks,
  fetchRealAudit,
  setRealAudit,
  openDictationTranslation,
  answerDictation,
  sendDictationTime,
  fetchDictationAudio,
  fetchDictationAnalytics
} from "./api/typing";

export type {
  DictationPoolSummary,
  TypingAnalyticsData,
  TypingBookStartResponse,
  TypingDrillsStartResponse,
  TypingKeysStartResponse,
  TypingKeysResult,
  TypingKeyState,
  TypingKeyToken,
  TypingKeyboardAnalytics,
  TypingOverview,
  TypingResult,
  TypingWordsStartResponse,
  TypingRecallWord,
  TypingRecallStartResponse,
  DictationAnalytics,
  DictationAnswerResponse,
  DictationHintResponse,
  DictationLessonSummary,
  DictationResult,
  DictationState
} from "./api/typing";

export {
  fetchReport,
  fetchFindings,
  createExport,
  fetchExternal,
  importExternalReport,
  decideExternalReport,
  fetchPracticeActivity,
  fetchActivityProgress,
  fetchTypingAnalytics,
  fetchVocabAnalytics,
  announceXp,
  fetchJourney,
  fetchConversationAnalytics,
  fetchJourneyDailyTotals,
  saveJourneySettings,
  recordTypingInterval,
  fetchClozeAnalytics,
  fetchGrammarTrends
} from "./api/analytics";

export type {
  Ratio,
  ReportData,
  SavedReportData,
  FindingData,
  DiscoveryAuditData,
  ExternalData,
  TrackProgress,
  Rate,
  VocabAnalytics,
  JourneyMode,
  JourneyData,
  ConversationAnalyticsData,
  ClozeWindow,
  ClozeAnalyticsData,
  GrammarTrendsData
} from "./api/analytics";

export {
  fetchStudioBatches,
  fetchBatches,
  fetchBatch,
  createBatchApi,
  createAgentBatchApi,
  fetchContentStock,
  fetchCoverage,
  fetchRevisionContent,
  importReview,
  previewRelease,
  publishReleaseApi,
  fetchJobs,
  fetchAiActivity,
  fetchGpu,
  jobAction,
  fetchThoughts,
  addThought,
  createThoughtBatchApi
} from "./api/content";

export type {
  ItemStatus,
  BatchSummary,
  BatchItem,
  TrialGate,
  Coverage,
  PublicJob,
  GpuInfo,
  StudioBatchSummary,
  AiWave,
  AiActivity,
  ThoughtItem
} from "./api/content";

export {
  fetchTutorSlots,
  fetchTutorThread,
  askTutor,
  fetchAgentTask
} from "./api/tutor";

export type {
  TutorMessage,
  TutorThread,
  TutorSlot
} from "./api/tutor";

export {
  conversationHome,
  conversationStart,
  conversationStartLesson,
  conversationNextTopic,
  conversationRead,
  conversationResume,
  conversationPause,
  conversationHeartbeat,
  conversationMessage,
  conversationSttStart,
  conversationDelete,
  conversationRetry,
  conversationSpeech
} from "./api/conversation";

export type {
  ConversationState,
  ConversationHome,
  LessonTargetView
} from "./api/conversation";
