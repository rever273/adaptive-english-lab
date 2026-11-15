import { useEffect, useRef, useState } from "react";
import type { FeedbackResponse } from "@english-lab/contracts";
import * as api from "../../api";
import { SpeakButton, isSpeakableSentence } from "../../components/SpeakButton";
import { Kbd } from "../../components/hotkeys";
import { firstTranslation } from "../../format";
import skillLabels from "../../skillLabels.json";
import { DetailDiff, VocabWhy } from "./FeedbackDetails";
import { Markdown } from "../Tutor";

/**
 * "Explain with AI": the tutor's step-by-step Russian explanation of THIS answer (what is wrong, the right pattern, new examples). It is the
 * same one-per-task "Explain in Russian" answer as in the Tutor page, written by the local model in the background and shown as a draft.
 */
function AiExplain({ sessionId, slotId, correct }: { sessionId: string; slotId: string; correct: boolean }) {
  const [state, setState] = useState<"idle" | "waiting" | "done" | "failed">("idle");
  const [reply, setReply] = useState<api.TutorMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setState("idle"); setReply(null); setError(null); }, [slotId]);
  const found = (messages: api.TutorMessage[]) => messages.find(m => m.role === "assistant" && m.kind === "explain_ru" && m.source === "model") ?? null;
  const run = async () => {
    if (state === "waiting") return;
    setState("waiting"); setError(null);
    try {
      const first = await api.askTutor({ sessionId, slotId, kind: "explain_ru" });
      let hit = found(first.messages);
      for (let i = 0; !hit && i < 60 && alive.current; i++) {
        await new Promise(r => setTimeout(r, 2500));
        if (!alive.current) return;
        const thread = await api.fetchTutorThread(slotId);
        hit = found(thread.messages);
        if (!hit && thread.pendingJobs === 0 && i >= 2) break; // nothing is being written any more: the job failed
      }
      if (!alive.current) return;
      if (hit) { setReply(hit); setState("done"); } else { setError("The local model could not write an explanation now. Try again in a moment."); setState("failed"); }
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof api.ApiRequestError ? e.message : "Could not ask the AI. Please try again."); setState("failed");
    }
  };
  return (
    <div className="ai-explain" data-testid="ai-explain">
      {state !== "done" && (
        <button type="button" className="btn has-kbd" onClick={() => void run()} disabled={state === "waiting"} aria-busy={state === "waiting"} data-testid="ai-explain-button" title={correct ? "The local AI explains the rule behind this answer in Russian, with examples" : "The local AI explains in Russian why your answer is wrong, with examples"}>
          <i className={`pi ${state === "waiting" ? "pi-spin pi-spinner" : "pi-sparkles"}`} aria-hidden="true" /> {state === "waiting" ? "The AI is thinking…" : correct ? "Explain the rule with AI" : "Explain with AI"}
        </button>
      )}
      {error && <p role="alert" className="small">{error}</p>}
      {reply && (
        <div className="tutor-reply tutor-reply-ai" data-testid="ai-explain-text">
          <p className="small tutor-reply-head"><i className="pi pi-sparkles" aria-hidden="true" /> Local AI — a draft, not checked</p>
          <div lang="ru" className="ru"><Markdown text={reply.text} /></div>
          {reply.examples.length > 0 && <ul className="small">{reply.examples.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          {reply.uncertaintyNoteRu && <p lang="ru" className="ru small muted">{reply.uncertaintyNoteRu}</p>}
        </div>
      )}
    </div>
  );
}

/** the first occurrence of `needle` in `text` coloured (case-insensitive); the text as it is when it does not occur */
function Marked({ text, needle, cls = "hl" }: { text: string; needle: string | null; cls?: string }) {
  const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (!needle || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className={cls}>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/** vocabulary feedback: the word and its Russian on their own line, then the finished sentence (word coloured) and its Russian translation */
function VocabSentence({ v }: { v: NonNullable<FeedbackResponse["vocabulary"]> }) {
  return (
    <div className="vocab-sentence" data-testid="vocab-sentence">
      <p className="vocab-word" data-testid="vocab-word">
        <i className="pi pi-bookmark-fill" aria-hidden="true" /> <strong>{v.lemma}</strong> <span className="muted small">{v.partOfSpeech}</span> — {v.translationRu ? <span lang="ru" className={`vt${v.translationSource === "ai_draft" ? " ai-text" : ""}`} title={v.translationSource === "ai_draft" ? "Written by the local AI" : undefined}>{firstTranslation(v.translationRu)}</span> : <span className="muted">no translation yet</span>}
      </p>
      {v.sentence && (
        <p className="vocab-line feedback-sentence">
          {isSpeakableSentence(v.sentence.before + v.sentence.filled + v.sentence.after) && <SpeakButton text={v.sentence.before + v.sentence.filled + v.sentence.after} />}
          <span><Marked text={v.sentence.before} needle={v.sentence.form} cls="hl hl-soft" />
          <mark className="hl">{v.sentence.filled}</mark>
          <Marked text={v.sentence.after} needle={v.sentence.form} cls="hl hl-soft" /></span>
        </p>
      )}
      {v.sentenceRu && (
        <p lang="ru" className="ru vocab-line vocab-line-ru">
          <Marked text={v.sentenceRu} needle={v.wordRu} />
        </p>
      )}
    </div>
  );
}

/** The flag is an explicit dictionary choice, separate from the answer and its score. */
function MarkWordLearned({ lemma }: { lemma: string }) {
  const [entry, setEntry] = useState<api.VocabEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEntry(null); setLoading(true); setError(null);
    void api.fetchVocabulary(lemma).then(({ words }) => {
      const matches = words.filter(w => w.lemma.trim().toLocaleLowerCase() === lemma.trim().toLocaleLowerCase());
      if (!cancelled) {
        if (matches.length === 1) setEntry(matches[0]!);
        else setError(matches.length ? "More than one dictionary entry matches this word. Update it in Vocabulary." : "This word is no longer in your dictionary.");
      }
    }).catch(() => { if (!cancelled) setError("Could not load the dictionary entry."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [lemma]);
  const toggle = async (learned: boolean) => {
    if (!entry) return;
    setSaving(true); setError(null);
    try { setEntry(await api.patchVocabulary(entry.id, { learned })); }
    catch { setError("Could not update the dictionary. Please try again."); }
    finally { setSaving(false); }
  };
  return <div className="small" data-testid="mark-word-learned">
    <label><input type="checkbox" checked={entry?.learned ?? false} disabled={loading || saving || !entry} onChange={e => void toggle(e.target.checked)} /> Mark this word as learned</label>
    {entry && <span className="muted"> ? Your choice; this increases its review interval.</span>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

const SKILL_LABELS = skillLabels as Record<string, { en: string; ru: string }>;

export function FeedbackPanel({ feedback, sessionId = null, skill = null, busy, onTryAgain, onContinue, autoAdvance = false, onStay }: { feedback: FeedbackResponse; sessionId?: string | null; skill?: string | null; busy: boolean; onTryAgain: () => void; onContinue: () => void; autoAdvance?: boolean; onStay?: () => void }) {
  const incorrect = feedback.verdict === "incorrect" || feedback.verdict === "idk";
  const kind = feedback.state === "pending" && feedback.aiChecked && !incorrect && feedback.verdict !== "correct" ? "pending" : feedback.state === "pending" && !feedback.aiChecked ? "pending" : feedback.detail || feedback.partial ? "detail" : feedback.verdict === "correct" ? "ok" : incorrect ? "again" : "info";
  return (
    <div className={`feedback feedback-${kind}`} data-testid="feedback" data-state={feedback.state} data-verdict={feedback.verdict ?? ""} aria-live="polite">
      <p className="feedback-title">
        <i className={`pi ${feedback.state === "closed" ? "pi-save" : feedback.state === "pending" && !feedback.aiChecked ? "pi-hourglass" : feedback.partial ? "pi-exclamation-circle" : feedback.verdict === "correct" ? "pi-check-circle" : feedback.verdict === "idk" ? "pi-info-circle" : feedback.verdict === "incorrect" ? "pi-times-circle" : "pi-info-circle"}`} aria-hidden="true" />{" "}
        {feedback.state === "closed" ? "Saved" : feedback.aiChecked ? `${feedback.verdict === "correct" ? "Correct" : "Incorrect"} (checked by AI)` : feedback.unresolved ? "Could not be checked automatically" : feedback.state === "pending" ? "Saved — AI review later" : feedback.detail ? "Right construction — check the detail" : feedback.partial ? "Partly correct" : feedback.verdict === "correct" ? "Correct" : feedback.verdict === "idk" ? "No problem" : feedback.verdict === "incorrect" ? "Not this time" : feedback.state === "skipped" ? "Skipped" : "Answer"}
      </p>
      {feedback.detail ? <DetailDiff d={feedback.detail} /> : feedback.aiChecked && feedback.aiReview ? <p lang="ru" className="ru" data-testid="ai-reason">{feedback.aiReview.explanation_ru}</p> : (() => { const m = feedback.message.replace(/^(Correct|Not this time)\.\s*/, ""); return m ? <p>{m}</p> : null; })()}
      {feedback.correct && (
        <div className="feedback-answer" data-testid="correct-answer">
          {feedback.correct.noMistake && <p>This sentence is correct: <strong>No mistake</strong>.</p>}
          {feedback.correct.options && <p>Correct: <strong>{feedback.correct.options.join(" / ")}</strong></p>}
          {feedback.correct.segments && <p>The mistake: <strong>{feedback.correct.segments.join(" / ")}</strong></p>}
          {feedback.correct.fixes && feedback.correct.fixes.length > 0 ? <p>Right answer: <strong>{feedback.correct.fixes.join(" / ")}</strong></p> : feedback.correct.corrections && feedback.correct.corrections.length > 0 && <p>Right answer: <strong>{feedback.correct.corrections.join(" / ")}</strong></p>}
          {feedback.correct.answers && (
            <p>
              Approved examples: <strong>{feedback.correct.answers.join(" · ")}</strong>
            </p>
          )}
        </div>
      )}
      {feedback.explanation_ru && <p lang="ru" className="ru">{feedback.explanation_ru}</p>}
      {skill && SKILL_LABELS[skill] && <p className="format-tag skill-tag" data-testid="skill-tag"><i className="pi pi-graduation-cap" aria-hidden="true" /> {SKILL_LABELS[skill]!.en} <span lang="ru">({SKILL_LABELS[skill]!.ru})</span></p>}
      {feedback.vocabulary && <VocabSentence v={feedback.vocabulary} />}
      {feedback.vocabulary && <VocabWhy v={feedback.vocabulary} />}
      {feedback.vocabulary && feedback.verdict === "correct" && <MarkWordLearned key={`${feedback.slotId}:${feedback.vocabulary.lemma}`} lemma={feedback.vocabulary.lemma} />}
      {autoAdvance && <p className="muted small" data-testid="auto-advance">Next exercise in a moment. <button type="button" className="link" onClick={onStay} data-testid="stay">Stay here</button> (Esc)</p>}
      {(incorrect || feedback.verdict === "correct") && sessionId && !feedback.vocabulary && feedback.state !== "closed" && <AiExplain key={feedback.slotId} sessionId={sessionId} slotId={feedback.slotId} correct={!incorrect} />}
      <div className="actions">
        {incorrect && (
          <button className="btn has-kbd" disabled={busy} onClick={onTryAgain}>
            <Kbd k="T" />
            <i className="pi pi-replay" aria-hidden="true" /> Try again
          </button>
        )}
        <button className="btn btn-primary has-kbd" disabled={busy} onClick={onContinue} data-testid="continue" autoFocus>
          <Kbd k="Enter" />
          Continue <i className="pi pi-arrow-right" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
