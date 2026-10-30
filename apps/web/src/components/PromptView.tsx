import type { RevealResponse } from "@english-lab/contracts";
import { useEffect, useId, useState } from "react";
import type { VoiceController } from "../voice";

interface Props {
  reveal: RevealResponse;
  busy: boolean;
  hint: string | null;
  onSubmit: (answer: string | string[], voiceDraftId?: string) => void;
  /** voice input for the short written formats; absent = typing only */
  voice?: VoiceController;
  onIdk: () => void;
  onSkip: () => void;
  onHint: () => void;
  onShowAnswer: () => void;
  /** after an answer: the prompt stays visible (read-only) above the feedback */
  locked?: boolean;
  /** diagnostic block or held-out check: no hints, no shown answers */
  checkMode?: boolean;
}

const INSTRUCTION: Record<string, string> = {
  choose_form: "Choose the correct form.",
  choose_missing_fragment: "Choose the missing word.",
  detect_error: "Find the part with a mistake, or choose No mistake.",
  guided_short_answer: "Write one short sentence.",
  russian_to_english_short: "Write the idea in natural English.",
  context_reading: "Read the text, then answer.",
};

/** Renders one prompt (all six formats) and the answer controls. No keyboard shortcut steals Space/Enter while typing. */
export function PromptView({ reveal, busy, hint, voice, onSubmit, onIdk, onSkip, onHint, onShowAnswer, locked = false, checkMode = false }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [noMistake, setNoMistake] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const groupId = useId();
  // a finished recording fills the text box ONCE; from then on the learner owns the text and may edit it freely
  const vs = voice?.state;
  useEffect(() => {
    if (vs?.phase === "draft") {
      setText(vs.text);
      setDraftId(vs.draftId);
    }
  }, [vs]);
  const p = reveal.prompt;

  const toggle = (id: string, multiple: boolean) => setSelected((cur) => (multiple ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));
  const canSubmit = p.kind === "short" ? text.trim().length > 0 : p.kind === "segments" ? noMistake || selected.length > 0 : selected.length > 0;

  function submit() {
    if (!canSubmit || busy) return;
    if (p.kind === "short") onSubmit(text, draftId ?? undefined);
    else if (p.kind === "segments") onSubmit(noMistake ? [p.noMistakeId] : selected);
    else onSubmit(selected);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-label="Exercise"
    >
      <p className="instruction">{INSTRUCTION[reveal.format] ?? p.prompt_en}</p>

      {p.kind === "choice" && (
        <fieldset className="options">
          <legend className="prompt" data-testid="prompt">{p.prompt_en}</legend>
          {p.options.map((o) => (
            <label key={o.id} className="option">
              <input type={p.multiple ? "checkbox" : "radio"} name={groupId} value={o.id} checked={selected.includes(o.id)} disabled={locked} onChange={() => toggle(o.id, p.multiple)} />
              <span>{o.text}</span>
            </label>
          ))}
        </fieldset>
      )}

      {p.kind === "segments" && (
        <fieldset className="options">
          <legend className="visually-hidden">Choose the part of the sentence that contains a mistake</legend>
          <p className="prompt sentence" data-testid="prompt">
            {p.segments.map((s) => (
              <button
                key={s.id}
                type="button"
                data-segment-id={s.id}
                className={`segment${selected.includes(s.id) ? " segment-on" : ""}`}
                aria-pressed={selected.includes(s.id)}
                disabled={locked}
                onClick={() => {
                  setNoMistake(false);
                  toggle(s.id, false);
                }}
              >
                {s.text}
              </button>
            ))}
          </p>
          <button
            type="button"
            className={`btn${noMistake ? " btn-on" : ""}`}
            aria-pressed={noMistake}
            disabled={locked}
            data-testid="no-mistake"
            onClick={() => {
              setSelected([]);
              setNoMistake((v) => !v);
            }}
          >
            No mistake
          </button>
          <p className="muted small">“No mistake” says the sentence is correct. It is not the same as “I don’t know”.</p>
        </fieldset>
      )}

      {p.kind === "short" && (
        <div className="short">
          <p lang="ru" className="ru cue" data-testid="prompt">{p.cue_ru}</p>
          <label htmlFor={`${groupId}-t`} className="visually-hidden">Your answer</label>
          <textarea id={`${groupId}-t`} rows={3} maxLength={2000} value={text} readOnly={locked} onChange={(e) => setText(e.target.value)} placeholder="Type your answer" data-testid="answer-text" />
          {voice && !locked && <VoiceBar voice={voice} busy={busy} hasDraft={draftId !== null} />}
        </div>
      )}

      {p.kind === "reading" && (
        <div className="reading">
          <div className="passage" data-testid="passage">
            {p.paragraphs.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
          <fieldset className="options">
            <legend className="prompt" data-testid="prompt">{p.question.prompt}</legend>
            {p.question.options.map((o) => (
              <label key={o.id} className="option">
                <input type="radio" name={groupId} value={o.id} checked={selected.includes(o.id)} disabled={locked} onChange={() => toggle(o.id, false)} />
                <span>{o.text}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {hint && (
        <p className="hint" lang="ru" data-testid="hint" role="status">
          Hint: {hint}
        </p>
      )}

      {!locked && (
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmit || busy} data-testid="submit">
          Submit
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onIdk} data-testid="idk">
          I don’t know
        </button>
        {!checkMode && (
          <button type="button" className="btn" disabled={busy || reveal.hintsAvailable === 0} onClick={onHint} data-testid="hint-btn">
            Hint
          </button>
        )}
        {!checkMode && (
          <button type="button" className="btn" disabled={busy} onClick={onShowAnswer} data-testid="show-answer">
            Show answer &amp; continue
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={onSkip} data-testid="skip">
          Skip
        </button>
      </div>
      )}
    </form>
  );
}

function VoiceBar({ voice, busy, hasDraft }: { voice: VoiceController; busy: boolean; hasDraft: boolean }) {
  const s = voice.state;
  return (
    <div className="voice" data-testid="voice">
      {(s.phase === "idle" || s.phase === "draft" || s.phase === "unavailable") && (
        <button type="button" className="btn" disabled={busy} onClick={() => void voice.record()} data-testid="record">
          {hasDraft ? "Record again" : "Speak instead"}
        </button>
      )}
      {s.phase === "preparing" && <span role="status" className="muted">Getting speech ready (a few seconds the first time)…</span>}
      {s.phase === "recording" && (
        <>
          <button type="button" className="btn btn-primary" onClick={() => void voice.stopRecording()} data-testid="stop-record">Stop</button>
          <span role="status" className="muted"> Listening… {Math.floor(s.seconds)} s</span>
        </>
      )}
      {s.phase === "transcribing" && <span role="status" className="muted">Writing down what you said…</span>}
      {s.phase === "draft" && <p className="muted small" data-testid="voice-draft-note">This is what I heard. Read it and fix anything that is wrong before you submit. No recording is kept.</p>}
      {s.phase === "unavailable" && <p className="notice notice-warn" role="status" data-testid="voice-unavailable">{s.message}</p>}
    </div>
  );
}
