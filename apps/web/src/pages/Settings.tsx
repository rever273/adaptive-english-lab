import { JourneySettings } from "./Journey";
import { NumberInput } from "../components/NumberInput";
import { useEffect, useState } from "react";
import { vocabularyFocusEnabled, type AiModelStatus } from "@english-lab/contracts";
import * as api from "../api";
import { modelErrorText } from "../components/AiModelNotice";
import { VoicesSettings } from "../components/VoicesSettings";

type Values = { preloadModelOnStart?: boolean; practiceSoundsEnabled?: boolean; typingSoundsEnabled?: boolean; taskCount: number; weakRatio: number; voiceTarget: 0 | 1 | 2; voiceShare?: number; vocabularyFocus?: boolean; vocabularyTaskCount?: number; vocabularyNewWordsPerSession?: number; vocabularyMatchRounds?: number; reviewNoticeThreshold?: number; difficultyMin?: api.Level; difficultyMax?: api.Level; typingWordsPerLevel?: number; typingDrillWordsPerLevel?: number; typingDrillSpeech?: boolean; typingKeysTargetWpm?: number; typingKeysGoalWpm?: number; typingKeysMinAccuracy?: number; typingVocabularyShare?: number; typingSpeedMultiplier?: number; typingBookMinutes?: number; typingBooksShowMistakes?: boolean; typingDictationExercisesPerLesson?: number; typingDictationSource?: "real" | "tts"; typingRecallWords?: number; clozeTaskCount?: number; clozeAutoAdvance?: boolean; clozeHighlightNames?: boolean; contextLoopCards?: number; contextLoopChecks?: number; vtScreeningBatch?: number; vtProbeShare?: number; vtNewPerSession?: number; vtLearningCards?: number; vtChecksPerSession?: number; vtFirstCheckDays?: number; vtRetention?: number; vtSpeakWord?: boolean; vtSpeakSentence?: boolean; vtMinLength?: number; vtSkipTopRanks?: number };
type Draft = { taskCount: number; weakRatio: number; voiceShare: number; practiceSoundsEnabled: boolean; typingSoundsEnabled: boolean; vocabularyFocus: boolean; vocabularyTaskCount: number; vocabularyNewWordsPerSession: number; vocabularyMatchRounds: number; reviewNoticeThreshold: number; difficultyMin: api.Level; difficultyMax: api.Level; typingWordsPerLevel: number; typingDrillWordsPerLevel: number; typingDrillSpeech: boolean; typingKeysTargetWpm: number; typingKeysGoalWpm: number; typingKeysMinAccuracy: number; typingVocabularyShare: number; typingSpeedMultiplier: number; typingBookMinutes: number; typingBooksShowMistakes: boolean; typingDictationExercisesPerLesson: number; typingDictationSource: "real" | "tts"; typingRecallWords: number; clozeTaskCount: number; clozeAutoAdvance: boolean; clozeHighlightNames: boolean; contextLoopCards: number; contextLoopChecks: number; vtScreeningBatch: number; vtProbeShare: number; vtNewPerSession: number; vtLearningCards: number; vtChecksPerSession: number; vtFirstCheckDays: number; vtRetention: number; vtSpeakWord: boolean; vtSpeakSentence: boolean; vtMinLength: number; vtSkipTopRanks: number };
const LEVELS: api.Level[] = ["A2", "B1", "B2", "C1", "C2"];

/** docs/04 §7: only the settings the allocator reads today. A change is a new settings revision and applies to the next session. */
export function Settings() {
  const [saved, setSaved] = useState<{ revision: number; values: Values; defaults: Values } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .fetchSettings()
      .then((s) => {
        setSaved(s);
        setDraft(pick(s.values));
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  }, []);

  // every change is saved at once (a short pause lets a typed number settle first); there is no Save button
  useEffect(() => {
    if (!draft || !saved || JSON.stringify(draft) === JSON.stringify(pick(saved.values))) return;
    const timer = window.setTimeout(() => {
      setBusy(true);
      api.saveSettings(draft)
        .then((s) => { setSaved(s); setDraft(pick(s.values)); setMsg("Saved. Practice sounds apply immediately; session settings apply when you start the next session."); })
        .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, saved]);

  if (!draft || !saved) return <section className="card">{msg ?? "Loading settings…"}</section>;

  return (
    <section aria-labelledby="settings-h" className="settings-page">
      <h2 id="settings-h">Settings</h2>
      <JourneySettings />
      <div className="settings-grid">
        <div className="card settings-card">
          <h3>Practice</h3>
          <label className="check"><input type="checkbox" checked={draft.practiceSoundsEnabled} onChange={(e) => setDraft({ ...draft, practiceSoundsEnabled: e.target.checked })} data-testid="set-practice-sounds" /> Play answer and completion sounds</label>
          <span className="muted small">Applies to grammar and vocabulary practice after saving. Vocabulary pronunciation is controlled separately.</span>
          <div className="settings-fields">
            <label>
              Exercises per session
              <NumberInput min={5} max={30} value={draft.taskCount} onChange={(value) => setDraft((d) => d && ({ ...d, taskCount: value }))} data-testid="set-task-count" />
              <span className="muted small">5–30, default {saved.defaults.taskCount}. No daily limit.</span>
            </label>
          </div>
          <div className="settings-fields">
            <label>
              Grammar Cloze exercises per session
              <NumberInput min={5} max={50} value={draft.clozeTaskCount} onChange={(value) => setDraft((d) => d && ({ ...d, clozeTaskCount: value }))} data-testid="set-cloze-task-count" />
              <span className="muted small">5–50, default 15. Sentences in one Grammar Cloze session (L01, L02, …); applies to the next session. The classic practice length above is separate.</span>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={draft.clozeAutoAdvance} onChange={(e) => setDraft({ ...draft, clozeAutoAdvance: e.target.checked })} data-testid="set-cloze-auto-advance" /> Grammar Cloze: go to the next sentence by itself after a correct answer</label>
          <label className="check"><input type="checkbox" checked={draft.clozeHighlightNames} onChange={(e) => setDraft({ ...draft, clozeHighlightNames: e.target.checked })} data-testid="set-cloze-names" /> Grammar Cloze: show names of people and places in a different colour</label>
          <label>
            Weak skills share: {Math.round(draft.weakRatio * 100)}%
            <input type="range" min={0} max={100} step={5} value={Math.round(draft.weakRatio * 100)} onChange={(e) => setDraft({ ...draft, weakRatio: Number(e.target.value) / 100 })} data-testid="set-weak-ratio" />
            <span className="muted small">The rest explores new skills. Default {Math.round(saved.defaults.weakRatio * 100)}%.</span>
          </label>
          <label>
            Voice tasks: {Math.round(draft.voiceShare * 100)}% ≈ {voiceCount(draft)} of {draft.taskCount} tasks
            <input type="range" min={0} max={100} step={5} value={Math.round(draft.voiceShare * 100)} onChange={(e) => setDraft({ ...draft, voiceShare: Number(e.target.value) / 100 })} data-testid="set-voice" aria-valuetext={`${Math.round(draft.voiceShare * 100)}%, about ${voiceCount(draft)} tasks`} />
            <span className="muted small">
              Only tasks where you write a sentence can be spoken, so a session may have fewer. You can always type or skip instead. Default {Math.round(pick(saved.defaults).voiceShare * 100)}% (≈ {voiceCount(pick(saved.defaults))} of {saved.defaults.taskCount}).
            </span>
          </label>
        </div>

        <div className="card settings-card">
          <h3>Vocabulary</h3>
          <div className="vocabulary-focus-setting">
            <label className="check">
              <input type="checkbox" checked={draft.vocabularyFocus} onChange={(e) => {
                const checked = e.target.checked;
                setDraft((d) => d && ({ ...d, vocabularyFocus: checked }));
              }} />
              <span>Focus practice (6 exercises, about 3 words)</span>
            </label>
          </div>
          <div className="settings-fields">
            {!draft.vocabularyFocus && <>
              <label>
                Exercises per session
                <NumberInput min={5} max={10} value={draft.vocabularyTaskCount} onChange={(value) => setDraft((d) => d && ({ ...d, vocabularyTaskCount: value }))} />
                <span className="muted small">5–10, default 8. Applies to the next vocabulary session.</span>
              </label>
              <label>
                New words per session
                <NumberInput min={1} max={10} value={draft.vocabularyNewWordsPerSession} onChange={(value) => setDraft((d) => d && ({ ...d, vocabularyNewWordsPerSession: value }))} data-testid="set-vocab-new-words" />
                <span className="muted small">1–10, default 4. Missed and due words come first; this is a target for words you have never practised, exceeded only if the session cannot otherwise be filled.</span>
              </label>
            </>}
            <label>
              Matching game repeats
              <NumberInput min={1} max={10} value={draft.vocabularyMatchRounds} onChange={(value) => setDraft((d) => d && ({ ...d, vocabularyMatchRounds: value }))} data-testid="set-vocab-match-rounds" />
              <span className="muted small">1–10, default 3. The matching game after a vocabulary practice has two modes; in the second one every word has to be matched this many times. Applies to the next game.</span>
            </label>
            <label>
              Context Loop cards
              <NumberInput min={10} max={40} value={draft.contextLoopCards} onChange={(value) => setDraft((d) => d && ({ ...d, contextLoopCards: value }))} data-testid="set-context-loop-cards" />
              <span className="muted small">10–40, default 20. The most cards in one Context Loop session; it ends earlier when every word is done. Applies to the next session.</span>
            </label>
            <label>
              Context Loop quick checks
              <NumberInput min={0} max={3} value={draft.contextLoopChecks} onChange={(value) => setDraft((d) => d && ({ ...d, contextLoopChecks: value }))} data-testid="set-context-loop-checks" />
              <span className="muted small">0–3, default 2. Words you recalled on an earlier day may come back once per session as a gap to type or say. 0 turns the checks off.</span>
            </label>
          </div>
        </div>

        <div className="card settings-card settings-card-wide">
          <h3>Typing Practice</h3>
          <div className="typing-settings-grid">
          <section className="typing-settings-group" aria-labelledby="typing-settings-words">
          <h4 id="typing-settings-words">Words: Meteor Rain</h4>
          <div className="settings-fields">
            <label>
              Words per level
              <NumberInput min={10} max={100} value={draft.typingWordsPerLevel} onChange={(value) => setDraft((d) => d && ({ ...d, typingWordsPerLevel: value }))} data-testid="set-typing-words" />
              <span className="muted small">10–100, default 30. The exact number of meteor words in a Words level; it does not grow automatically.</span>
            </label>
            <label>
              Personal vocabulary share: {Math.round(draft.typingVocabularyShare * 100)}%
              <input type="range" min={0} max={100} step={5} value={Math.round(draft.typingVocabularyShare * 100)} onChange={(e) => setDraft({ ...draft, typingVocabularyShare: Number(e.target.value) / 100 })} data-testid="set-typing-vocab-share" />
              <span className="muted small">Share of Words targets taken from your saved vocabulary. Default 30%.</span>
            </label>
            <label>
              Memory check words after a Words level
              <NumberInput min={0} max={3} value={draft.typingRecallWords} onChange={(value) => setDraft((d) => d && ({ ...d, typingRecallWords: value }))} data-testid="set-typing-recall-words" />
              <span className="muted small">0–3, default 2. After a won level, this many of your saved words appear as stars with their translation and a sentence to guess them from. 0 turns the check off.</span>
            </label>
          </div>
          </section>
          <section className="typing-settings-group" aria-labelledby="typing-settings-drills">
          <h4 id="typing-settings-drills">Words: Finger Drills and Key Builder</h4>
          <h5>Finger Drills</h5>
          <div className="settings-fields">
            <label>
              Drill words per level
              <NumberInput min={20} max={200} value={draft.typingDrillWordsPerLevel} onChange={(value) => setDraft((d) => d && ({ ...d, typingDrillWordsPerLevel: value }))} data-testid="set-typing-drill-words" />
              <span className="muted small">20–200, default 60. Words typed in one Finger Drills level, repeats included.</span>
            </label>
            <label className="check"><input type="checkbox" checked={draft.typingDrillSpeech} onChange={(e) => setDraft({ ...draft, typingDrillSpeech: e.target.checked })} data-testid="set-typing-drill-speech" /> Say every tenth word aloud (Piper)</label>
          </div>
          <h5>Key Builder</h5>
          <div className="settings-fields">
            <label>
              Target speed (WPM)
              <NumberInput min={15} max={150} value={draft.typingKeysTargetWpm} onChange={(value) => setDraft((d) => d && ({ ...d, typingKeysTargetWpm: value }))} data-testid="set-typing-keys-target" />
              <span className="small">= {Math.round(draft.typingKeysTargetWpm * 5)} CPM</span>
              <span className="muted small">15–150, default 40 (keybr's default is 35). The next letter opens when every open key has reached this speed on its own. It does not change by itself: raise it in steps of about 5 when the letters come easily.</span>
            </label>
            <label>
              Goal speed (WPM)
              <NumberInput min={20} max={150} value={draft.typingKeysGoalWpm} onChange={(value) => setDraft((d) => d && ({ ...d, typingKeysGoalWpm: value }))} data-testid="set-typing-keys-goal" />
              <span className="small">= {Math.round(draft.typingKeysGoalWpm * 5)} CPM</span>
              <span className="muted small">20–150, default 55. Your long-range aim: the forecast shows how many lessons and hours remain to it. It does not decide when letters open.</span>
            </label>
            <label>
              Key accuracy (%)
              <NumberInput min={80} max={100} value={draft.typingKeysMinAccuracy} onChange={(value) => setDraft((d) => d && ({ ...d, typingKeysMinAccuracy: value }))} data-testid="set-typing-keys-accuracy" />
              <span className="muted small">80–100, default 95. The next letter opens only when all open keys together are at least this accurate; the key with the most mistakes is then practised.</span>
            </label>
          </div>
          </section>
          <section className="typing-settings-group" aria-labelledby="typing-settings-books">
          <h4 id="typing-settings-books">Books</h4>
          <div className="settings-fields">
            <label>
              Book session duration (minutes)
              <NumberInput min={1} max={30} value={draft.typingBookMinutes} onChange={(value) => setDraft((d) => d && ({ ...d, typingBookMinutes: value }))} data-testid="set-typing-book-minutes" />
              <span className="muted small">1–30, default 5. Target duration of one Books level; the actual length rounds to a paragraph boundary.</span>
            </label>
            <label className="check"><input type="checkbox" checked={draft.typingBooksShowMistakes} onChange={(e) => setDraft({ ...draft, typingBooksShowMistakes: e.target.checked })} data-testid="set-typing-books-mistakes" /> Show wrong letters in Books (untick: a wrong key is only counted, nothing appears to delete)</label>
          </div>
          </section>
          <section className="typing-settings-group" aria-labelledby="typing-settings-dictation">
          <h4 id="typing-settings-dictation">Audio Dictation</h4>
          <div className="settings-fields">
            <label className="check"><input type="checkbox" checked={draft.typingDictationSource === "real"} onChange={(e) => setDraft({ ...draft, typingDictationSource: e.target.checked ? "real" : "tts" })} data-testid="set-dictation-real" /> Audio Dictation: use real Australian voices</label>
            <span className="muted small">Turn off to use synthesised Piper voices. Applies to the next lesson.</span>
            <label>
              Dictation exercises per lesson
              <NumberInput min={5} max={20} value={draft.typingDictationExercisesPerLesson} onChange={(value) => setDraft((d) => d && ({ ...d, typingDictationExercisesPerLesson: value }))} data-testid="set-typing-dictation-count" />
              <span className="muted small">5–20, default 10. A lesson already generated keeps its size. Synthetic mode uses Piper en_AU-librivox-medium (CC BY 4.0).</span>
            </label>
          </div>
          </section>
          <section className="typing-settings-group" aria-labelledby="typing-settings-vocab">
          <h4 id="typing-settings-vocab">Vocabulary</h4>
          <div className="settings-fields">
            <label>
              Shortest word (letters)
              <NumberInput min={2} max={5} value={draft.vtMinLength} onChange={(value) => setDraft((d) => d && ({ ...d, vtMinLength: value }))} data-testid="set-vt-min-length" />
              <span className="muted small">2–5, default 3. Shorter words are left out of Screening and Learning.</span>
            </label>
            <label>
              Skip the most frequent words
              <NumberInput min={0} max={1000} value={draft.vtSkipTopRanks} onChange={(value) => setDraft((d) => d && ({ ...d, vtSkipTopRanks: value }))} data-testid="set-vt-skip-top" />
              <span className="muted small">0–1000, default 300. The very commonest words are not practised and count as known in the vocabulary estimate.</span>
            </label>
            <label>
              Screening words per batch
              <NumberInput min={10} max={40} value={draft.vtScreeningBatch} onChange={(value) => setDraft((d) => d && ({ ...d, vtScreeningBatch: value }))} data-testid="set-vt-batch" />
              <span className="muted small">10–40, default 20. Words shown in one Screening batch.</span>
            </label>
            <label>
              Probe words: {Math.round(draft.vtProbeShare * 100)}%
              <input type="range" min={0} max={50} step={5} value={Math.round(draft.vtProbeShare * 100)} onChange={(e) => setDraft({ ...draft, vtProbeShare: Number(e.target.value) / 100 })} data-testid="set-vt-probe" />
              <span className="muted small">Share of each batch drawn at random from rarer words so the vocabulary estimate is not biased towards frequent words. 0–50%, default 25%. They look like any other card.</span>
            </label>
            <label>
              New words per Learning session
              <NumberInput min={0} max={10} value={draft.vtNewPerSession} onChange={(value) => setDraft((d) => d && ({ ...d, vtNewPerSession: value }))} data-testid="set-vt-new" />
              <span className="muted small">0–10, default 5. Checks use up the session first, so fewer new words may be introduced.</span>
            </label>
            <label>
              Cards per Learning session
              <NumberInput min={10} max={40} value={draft.vtLearningCards} onChange={(value) => setDraft((d) => d && ({ ...d, vtLearningCards: value }))} data-testid="set-vt-cards" />
              <span className="muted small">10–40, default 20. The most cards in one session; it ends earlier when every word is done.</span>
            </label>
            <label>
              Checks per Learning session
              <NumberInput min={0} max={15} value={draft.vtChecksPerSession} onChange={(value) => setDraft((d) => d && ({ ...d, vtChecksPerSession: value }))} data-testid="set-vt-checks" />
              <span className="muted small">0–15, default 5. Missing-word checks of words you marked Learned.</span>
            </label>
            <label>
              First check after (days)
              <NumberInput min={1} max={7} value={draft.vtFirstCheckDays} onChange={(value) => setDraft((d) => d && ({ ...d, vtFirstCheckDays: value }))} data-testid="set-vt-first-check" />
              <span className="muted small">1–7, default 1 learning day after you press Learned (also after a failed check).</span>
            </label>
            <label>
              Target retention: {Math.round(draft.vtRetention * 100)}%
              <input type="range" min={80} max={97} step={1} value={Math.round(draft.vtRetention * 100)} onChange={(e) => setDraft({ ...draft, vtRetention: Number(e.target.value) / 100 })} data-testid="set-vt-retention" />
              <span className="muted small">How likely you should still recall a word when its next check comes (FSRS). 80–97%, default 90%. Higher means more frequent checks.</span>
            </label>
            <label className="check"><input type="checkbox" checked={draft.vtSpeakWord} onChange={(e) => setDraft({ ...draft, vtSpeakWord: e.target.checked })} data-testid="set-vt-speak-word" /> Say the word when a card appears</label>
            <label className="check"><input type="checkbox" checked={draft.vtSpeakSentence} onChange={(e) => setDraft({ ...draft, vtSpeakSentence: e.target.checked })} data-testid="set-vt-speak-sentence" /> Read the sentence out loud after you type it</label>
          </div>
          </section>
          <section className="typing-settings-group" aria-labelledby="typing-settings-sound">
          <h4 id="typing-settings-sound">Sound and speed</h4>
          <div className="settings-fields">
          <label className="check"><input type="checkbox" checked={draft.typingSoundsEnabled} onChange={(e) => setDraft({ ...draft, typingSoundsEnabled: e.target.checked })} data-testid="set-typing-sounds" /> Play Typing game sounds</label>
            <label>
              Speed multiplier: {Math.round(draft.typingSpeedMultiplier * 1000) / 10}%
              <input type="range" min={50} max={200} step={2.5} value={Math.round(draft.typingSpeedMultiplier * 1000) / 10} onChange={(e) => setDraft({ ...draft, typingSpeedMultiplier: Math.round(Number(e.target.value) * 10) / 1000 })} data-testid="set-typing-speed" />
              <span className="muted small">50–200%, default 105%. Makes the game slightly harder than your current comfortable speed.</span>
            </label>
          </div>
          </section>
          </div>
        </div>
      </div>

      <div className="card settings-card">
        <h3>Difficulty and review</h3>
        <label>
          Sentence difficulty (CEFR)
          <span className="level-range">
            <select value={draft.difficultyMin} aria-label="Lowest level" data-testid="set-level-min" onChange={(e) => { const min = e.target.value as api.Level; setDraft({ ...draft, difficultyMin: min, difficultyMax: LEVELS.indexOf(draft.difficultyMax) < LEVELS.indexOf(min) ? min : draft.difficultyMax }); }}>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            {" to "}
            <select value={draft.difficultyMax} aria-label="Highest level" data-testid="set-level-max" onChange={(e) => { const max = e.target.value as api.Level; setDraft({ ...draft, difficultyMax: max, difficultyMin: LEVELS.indexOf(draft.difficultyMin) > LEVELS.indexOf(max) ? max : draft.difficultyMin }); }}>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </span>
          <span className="muted small">Default B1 to C1. Practice only draws approved exercises of these levels (if there are not enough, the lesson shows the usual shortage message instead of easier ones), and new AI-written exercises are requested at these levels. Applies to the next session or batch.</span>
        </label>
        <label>
          Answers to collect before the review notice
          <NumberInput min={1} max={50} value={draft.reviewNoticeThreshold} onChange={(value) => setDraft((d) => d && ({ ...d, reviewNoticeThreshold: value }))} data-testid="set-review-threshold" />
          <span className="muted small">1–50, default 5. Answers the local AI could not check wait in a queue; once this many have collected, Practice shows one notice with a task for your coding agent.</span>
        </label>
      </div>

      <div className="settings-grid">
        <VocabularySpeechSettings />
        <ModelSection preload={saved.values.preloadModelOnStart ?? true} />
        <StatusSection />
      </div>
      <VoicesSettings />

      <div className="card settings-bar">
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => setDraft(pick(saved.defaults))}>
            Restore defaults
          </button>
          <span className="muted small">Settings revision {saved.revision}. Changes are saved automatically and never change past answers or statistics. The cards below apply at once.</span>
        </div>
        {msg && (
          <p className="notice notice-info small" role="status">
            {msg}
          </p>
        )}
      </div>

    </section>
  );
}

/** Where the app talks to outside services: ElevenLabs credits (pronunciation) and Groq (speech recognition). */
function StatusSection() {
  const [credits, setCredits] = useState<api.VocabularySpeechCredits | null>(null);
  const [groq, setGroq] = useState<api.GroqStatus | null>(null);
  const [deepl, setDeepL] = useState<api.DeepLUsage | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [requests, setRequests] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const load = () => {
    setChecking(true);
    void Promise.all([
      api.fetchVocabularySpeech().then((s) => { setConfigured(s.configured); setRequests(s.requests); return s.configured ? api.fetchVocabularySpeechCredits().then(setCredits) : setCredits(null); }).catch(() => setCredits({ available: false, reason: "Unable to load the credits.", appCharacters30d: 0 })),
      api.fetchDeepLUsage().then(setDeepL).catch(() => setDeepL({ available: false, reason: "Unable to load DeepL usage." })),
      api.fetchGroqStatus().then(setGroq).catch(() => setGroq({ configured: false, reachable: false, reason: "Unable to load the Groq status.", limits: null })),
    ]).finally(() => setChecking(false));
  };
  useEffect(load, []);
  return <div className="card settings-card" data-testid="service-status">
    <h3>Voice and translation info</h3>
    <h4>ElevenLabs (pronunciation)</h4>
    {configured === false && <p className="muted small">Not configured: add an ElevenLabs API key and voice ID.</p>}
    {credits?.available && credits.limit !== undefined && credits.used !== undefined
      ? <>
        <p className="small" data-testid="eleven-credits">Credits: <strong>{credits.used.toLocaleString()} / {credits.limit.toLocaleString()}</strong> characters used ({credits.remaining?.toLocaleString()} left - {credits.limit > 0 ? Math.round((credits.used / credits.limit) * 100) : 0}%)</p>
        <p className="small" data-testid="eleven-credits">Credits: {credits.resetsAt ? `Resets ${new Date(credits.resetsAt).toLocaleDateString()}` : ""}{credits.tier ? ` · plan: ${credits.tier}` : ""}.</p>

        <progress max={credits.limit} value={credits.used} aria-label="ElevenLabs credits used" />
      </>
      : credits && <p className="muted small">Credits unavailable: {credits.reason}</p>}
    {credits && <p className="muted small">Sent by this app in the last 30 days: {credits.appCharacters30d.toLocaleString()} characters.</p>}
    {requests !== null && <p className="muted small">Requests in the last 24 hours: {requests}. Cached recordings need no request.</p>}
    <h4>DeepL (translation)</h4>
    {deepl?.available ? <>
      <p className="small" data-testid="deepl-usage">Characters: <strong>{deepl.used.toLocaleString("en-AU")} / {deepl.limit.toLocaleString("en-AU")}</strong> used{deepl.limit > 0 ? ` - ${Math.round(deepl.used / deepl.limit * 100)}%` : ""}</p>
      {deepl.limit > 0 && <progress max={deepl.limit} value={deepl.used} aria-label="DeepL characters used" />}
      <p className="muted small">Usage reported by DeepL for the account; updates may take a few minutes.</p>
    </> : deepl && <p className="muted small" data-testid="deepl-usage">{deepl.reason}</p>}
    <h4>Groq (speech recognition)</h4>
    {groq && (!groq.configured
      ? <p className="muted small" data-testid="groq-status">{groq.reason}</p>
      : <p className="small" data-testid="groq-status">{groq.reachable ? "Key accepted, Groq is reachable." : `Not available: ${groq.reason}`}</p>)}
    {groq?.configured && (groq.limits
      ? <>
        <p className="muted small">Limits reported with the latest transcription ({new Date(groq.limits.capturedAt).toLocaleString()}, HTTP {groq.limits.status}):</p>
        <ul className="muted small">{Object.entries(groq.limits.headers).map(([k, v]) => <li key={k}>{k.replace(/^x-ratelimit-/, "").replace(/-/g, " ")}: {v}</li>)}</ul>
      </>
      : <p className="muted small">Groq reports no credit balance. Remaining limits appear here after the first voice answer since the app started.</p>)}
    <button type="button" className="btn" disabled={checking} onClick={load}>{checking ? "Checking…" : "Refresh status"}</button>
  </div>;
}

function VocabularySpeechSettings() {
  const [status, setStatus] = useState<api.VocabularySpeechStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.fetchVocabularySpeech().then(setStatus).catch(() => setError("Unable to load pronunciation settings.")); }, []);
  const toggle = async (enabled: boolean) => {
    try { setStatus(await api.setVocabularySpeech(enabled)); setError(null); }
    catch { setError("Unable to save pronunciation settings."); }
  };
  return <div className="card settings-card">
    <h3>Vocabulary pronunciation</h3>
    {status && <>
      <label className="check"><input type="checkbox" checked={status.enabled} onChange={(e) => void toggle(e.target.checked)} /> Automatically pronounce revealed answers in Vocabulary Practice</label>
            {!status.configured && <p className="muted small">Add an ElevenLabs API key and voice ID to enable pronunciation.</p>}
      {status.blockedUntil && <p className="muted small">ElevenLabs rate limit: paused until {new Date(status.blockedUntil).toLocaleString()}.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

/** older settings revisions hold a fixed voice count; it is shown as the share of the task count it was */
const pick = (v: Values): Draft => ({ taskCount: v.taskCount, weakRatio: v.weakRatio, voiceShare: v.voiceShare ?? Math.round((v.voiceTarget / v.taskCount) * 20) / 20, practiceSoundsEnabled: v.practiceSoundsEnabled ?? true, typingSoundsEnabled: v.typingSoundsEnabled ?? true, vocabularyFocus: vocabularyFocusEnabled(v), vocabularyTaskCount: v.vocabularyTaskCount ?? 8, vocabularyNewWordsPerSession: v.vocabularyNewWordsPerSession ?? 4, vocabularyMatchRounds: v.vocabularyMatchRounds ?? 3, reviewNoticeThreshold: v.reviewNoticeThreshold ?? 5, difficultyMin: v.difficultyMin ?? (v.difficultyMax ? "A2" : "B1"), difficultyMax: v.difficultyMax ?? "C1", typingWordsPerLevel: v.typingWordsPerLevel ?? 30, typingDrillWordsPerLevel: v.typingDrillWordsPerLevel ?? 60, typingDrillSpeech: v.typingDrillSpeech ?? false, typingKeysTargetWpm: v.typingKeysTargetWpm ?? 40, typingKeysGoalWpm: v.typingKeysGoalWpm ?? 55, typingKeysMinAccuracy: v.typingKeysMinAccuracy ?? 95, typingVocabularyShare: v.typingVocabularyShare ?? 0.3, typingSpeedMultiplier: v.typingSpeedMultiplier ?? 1.05, typingBookMinutes: v.typingBookMinutes ?? 5, typingBooksShowMistakes: v.typingBooksShowMistakes ?? true, typingDictationExercisesPerLesson: v.typingDictationExercisesPerLesson ?? 10, typingDictationSource: v.typingDictationSource ?? "real", typingRecallWords: v.typingRecallWords ?? 2, clozeTaskCount: v.clozeTaskCount ?? 15, clozeAutoAdvance: v.clozeAutoAdvance ?? true, clozeHighlightNames: v.clozeHighlightNames ?? true, contextLoopCards: v.contextLoopCards ?? 20, contextLoopChecks: v.contextLoopChecks ?? 2, vtScreeningBatch: v.vtScreeningBatch ?? 20, vtProbeShare: v.vtProbeShare ?? 0.25, vtNewPerSession: v.vtNewPerSession ?? 5, vtLearningCards: v.vtLearningCards ?? 20, vtChecksPerSession: v.vtChecksPerSession ?? 5, vtFirstCheckDays: v.vtFirstCheckDays ?? 1, vtRetention: v.vtRetention ?? 0.9, vtSpeakWord: v.vtSpeakWord ?? true, vtSpeakSentence: v.vtSpeakSentence ?? true, vtMinLength: v.vtMinLength ?? 3, vtSkipTopRanks: v.vtSkipTopRanks ?? 300 });
const voiceCount = (d: Draft): number => Math.round(d.voiceShare * d.taskCount);

const BUSY_TEXT: Record<string, string> = {
  job_running: "an AI task is running",
  practice_active: "speech recognition is using the graphics card",
  loading: "the model is loading",
  unloading: "the model is unloading",
};

/** D67: the one local model. One button (Load / Unload, no confirmation); the toggle is saved at once and does not need the Save button. */
function ModelSection({ preload }: { preload: boolean }) {
  const [st, setSt] = useState<AiModelStatus | null>(null);
  const [on, setOn] = useState(preload);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let off = false;
    let timer: number | undefined;
    const tick = async () => {
      const next = await api.fetchAiModel().catch(() => null);
      if (off) return;
      if (next) setSt(next);
      timer = window.setTimeout(() => void tick(), next && (next.state === "loading" || next.state === "unloading") ? 1500 : 5000);
    };
    void tick();
    return () => {
      off = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const act = async (f: () => Promise<AiModelStatus>) => {
    setPending(true);
    setErr(null);
    try {
      setSt(await f());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  const toggle = async (v: boolean) => {
    setOn(v);
    try {
      await api.savePreloadModel(v);
    } catch (e) {
      setOn(!v);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const loaded = st?.state === "ready";
  const transition = st?.state === "loading" || st?.state === "unloading";
  // unloading needs the model free of a running task; loading needs the card free of local speech recognition
  const reason = st === null ? "checking the model" : transition ? BUSY_TEXT[st.state]! : loaded ? (st.busy === "job_running" ? BUSY_TEXT.job_running! : null) : st.busy === "practice_active" ? BUSY_TEXT.practice_active! : null;
  const line =
    st === null ? "Checking the AI model..." :
    st.state === "ready" ? `${st.model} is loaded${st.vramBytes ? ` (${(st.vramBytes / 1024 ** 3).toFixed(1)} GB of graphics memory)` : ""}.` :
    st.state === "loading" ? `Loading ${st.model} - the first load takes about 40 seconds.` :
    st.state === "unloading" ? `Unloading ${st.model}...` :
    st.state === "error" ? `${st.model}: problem - ${modelErrorText(st.error)}.` :
    `${st.model} is not loaded.`;
  return (
    <div className="card settings-card" data-testid="model-section">
      <h3>AI model</h3>
      <p role="status" data-testid="model-status">{line}</p>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} data-testid="set-preload-model" /> Load the model when the app starts and when I start practising
      </label>
      <span className="muted small">The first load takes about 40 seconds; a loaded model keeps answer checks and word look-ups instant. It is unloaded when the app stops.</span>
      <div className="actions">
        <button className="btn" disabled={pending || reason !== null} onClick={() => void act(loaded ? api.unloadAiModel : api.loadAiModel)} data-testid="model-toggle">
          {loaded ? "Unload model" : "Load model now"}
        </button>
        {reason && <span className="muted small">Unavailable: {reason}.</span>}
      </div>
      {err && <p className="notice notice-warn small" role="status">{err}</p>}
    </div>
  );
}
