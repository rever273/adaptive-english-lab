import { describe, expect, it } from "vitest";
import * as api from "../../../apps/web/src/api.js";
import * as system from "../../../apps/web/src/api/system.js";
import * as practice from "../../../apps/web/src/api/practice.js";
import * as vocabulary from "../../../apps/web/src/api/vocabulary.js";
import * as typing from "../../../apps/web/src/api/typing.js";
import * as analytics from "../../../apps/web/src/api/analytics.js";
import * as content from "../../../apps/web/src/api/content.js";
import * as tutor from "../../../apps/web/src/api/tutor.js";
import * as conversation from "../../../apps/web/src/api/conversation.js";
import { ApiRequestError } from "../../../apps/web/src/api/transport.js";

// Frozen public runtime surface from before the domain extraction. Private adapters stay private.
const previousExports = `
ApiRequestError abortTypingBook abortTypingWords addExpression addThought addVocabulary announceXp answerCloze
answerDictation askTutor checkpointTypingBook completeClozeSession completeTypingBook completeTypingDrills
completeTypingWords completeWordLessonRun conversationDelete conversationHeartbeat conversationHome
conversationMessage conversationPause conversationRead conversationResume conversationRetry conversationSpeech
conversationStart conversationSttStart createAgentBatchApi createBatchApi createCheckSession
createDictationLesson createExport createSession createThoughtBatchApi createVocabSession decideExternalReport
disputeWordLessonAttempt editExpression excludeClozeItem fetchActivityProgress fetchAgentTask fetchAiActivity
fetchAiModel fetchBatch fetchBatches fetchBookSpeech fetchCapabilities fetchClozeAnalysis fetchClozeAnalytics
fetchClozeOverview fetchClozeSession fetchContentStock fetchConversationAnalytics fetchCoverage
fetchCurrentSession fetchDashboard fetchDeepLUsage fetchDictationAnalytics fetchDictationAudio
fetchDictationPool fetchDictationResult fetchDrillSpeech fetchExpressions fetchExternal fetchFeedback
fetchFindings fetchGpu fetchGrammarTrends fetchGroqStatus fetchHealth fetchJobs fetchJourney
fetchJourneyDailyTotals fetchMatchWords fetchPracticeActivity fetchRecentSession fetchReport
fetchRevisionContent fetchSession fetchSettings fetchStudioBatches fetchSummary fetchThoughts fetchTutorSlots
fetchTutorThread fetchTypingAnalytics fetchTypingOverview fetchTypingRecall fetchTypingResult
fetchVocabAnalytics fetchVocabCoverage fetchVocabPractice fetchVocabulary fetchVocabularySpeech
fetchVocabularySpeechCredits fetchVoiceHistory fetchVoiceSample fetchVoices fetchWordLessonRun
fetchWordLessonStudio fetchWordLessons finishSession generateWordLessons giveUpWordLessonCheck
importExternalReport importReview jobAction loadAiModel lookupVocabulary markClozeShown matchVocabulary
openDictationTranslation patchVocabulary prepareDictationTracks previewRelease publishReleaseApi
recordClozeActivity recordPracticeActivity recordTypingInterval recordWordLessonActivity removeExpression
removeVocabulary requestClozeAnalysis requestDictationHint retryDictationLesson retryExpression
retryWordLessons revealDictationAnswer revealSlot saveJourneySettings saveMatchResults savePreloadModel
saveSettings saveTypingRecall saveVoiceSettings sendDictationPlay sendDictationTime sendEvent sendKeepalive
sendWordLessonAttempt sendWordLessonEvent setDictationSoundFlag setVocabularySpeech startClozeSession
startDictationLesson startTypingBook startTypingDrills startTypingWords startWordLessonRun sttAudio sttConfirm
sttStart sttStop submitAttempt takeLease translateSentence typingWordAppearances unloadAiModel
vocabularySpeech vocabularyTextSpeech vocabularyWordSpeech voiceDone warmBookSpeech wordLessonSttStart
`.trim().split(/\s+/).sort();

describe("public API facade compatibility", () => {
  it("preserves every public runtime export without exposing internal adapters", () => {
    expect(Object.keys(api).sort()).toEqual(previousExports);
  });
  it("re-exports the original domain functions and the one transport error class", () => {
    expect(api.ApiRequestError).toBe(ApiRequestError);
    expect(api.fetchSettings).toBe(system.fetchSettings);
    expect(api.fetchSession).toBe(practice.fetchSession);
    expect(api.vocabularySpeech).toBe(vocabulary.vocabularySpeech);
    expect(api.fetchBookSpeech).toBe(typing.fetchBookSpeech);
    expect(api.fetchJourney).toBe(analytics.fetchJourney);
    expect(api.fetchContentStock).toBe(content.fetchContentStock);
    expect(api.fetchTutorThread).toBe(tutor.fetchTutorThread);
    expect(api.conversationSpeech).toBe(conversation.conversationSpeech);
  });
});
