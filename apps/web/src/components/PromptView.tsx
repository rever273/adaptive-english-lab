import type { RevealResponse } from "@english-lab/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { SpeakButton, isSpeakableSentence } from "./SpeakButton";
import type { VoiceController } from "../voice";
import { Kbd, isPressable, isTextField, useKeys } from "./hotkeys";

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
  /** vocabulary practice: word-centred labels, and a typed gap is one line under its sentence */
  vocabulary?: boolean;
  translation?: string | null;
  onTranslation?: () => void;
  letters?: Array<string | null> | null;
  onLetter?: (index: number) => void;
}

/** vocabulary practice: each family has one format (see content/packs/vocab-starter) */
export const VOCAB_LOOK: Record<string, { icon: string; label: string; instruction: string }> = {
  choose_missing_fragment: { icon: "pi-bookmark", label: "Word in context", instruction: "Choose the word that fits this sentence best." },
  guided_short_answer: { icon: "pi-pencil", label: "Recall the word", instruction: "Type the missing word." },
  choose_form: { icon: "pi-link", label: "Collocation", instruction: "Choose the word that naturally goes with the others." },
};

const INSTRUCTION: Record<string, string> = {
  choose_form: "Choose the correct form.",
  choose_missing_fragment: "Choose the missing word.",
  detect_error: "Find the part with a mistake, or choose No mistake.",
  guided_short_answer: "Write one short sentence.",
  russian_to_english_short: "Write the idea in natural English.",
  context_reading: "Read the text, then answer.",
  assemble_sentence: "Put the blocks in order to build the sentence.",
};

/** one icon and one label per format, shown above the task (the colour comes from the card's fmt-* class) */
export const FORMAT_LOOK: Record<string, { icon: string; label: string }> = {
  choose_form: { icon: "pi-list-check", label: "Choose the form" },
  choose_missing_fragment: { icon: "pi-th-large", label: "Fill the gap" },
  detect_error: { icon: "pi-search", label: "Find the mistake" },
  guided_short_answer: { icon: "pi-pencil", label: "Your sentence" },
  russian_to_english_short: { icon: "pi-language", label: "Russian → English" },
  context_reading: { icon: "pi-book", label: "Reading" },
  assemble_sentence: { icon: "pi-objects-column", label: "Build the sentence" },
};

/** Renders one prompt (all six formats) and the answer controls. No keyboard shortcut steals Space/Enter while typing. */
export function PromptView({ reveal, busy, hint, voice, onSubmit, onIdk, onSkip, onHint, onShowAnswer, locked = false, checkMode = false, vocabulary = false, translation, onTranslation, letters, onLetter }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [noMistake, setNoMistake] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  // vocabulary recall can be built from letter tiles; every second task starts that way, and the learner can switch either way
  const build = reveal.prompt.kind === "short" ? reveal.prompt.build : undefined;
  const [tilesOn, setTilesOn] = useState(() => !!build && [...reveal.slotId].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 2 === 0);
  const [placed, setPlaced] = useState<number[]>([]);
  const useTiles = vocabulary && !!build && tilesOn;
  const tileCount = build ? build.pattern.reduce((a, b) => a + b, 0) : 0;
  const built = build ? build.pattern.reduce<{ words: string[]; at: number }>((acc, n) => ({ words: [...acc.words, placed.slice(acc.at, acc.at + n).map((i) => build.tiles[i]).join("")], at: acc.at + n }), { words: [], at: 0 }).words.filter(Boolean).join(" ") : "";
  const groupId = useId();
  // a recording made on THIS task fills the text box once; a draft left over from the previous task never does
  const vs = voice?.state;
  const atMount = useRef(vs);
  useEffect(() => {
    if (vs?.phase === "draft" && vs !== atMount.current) {
      setText(vs.text);
      setDraftId(vs.draftId);
    }
  }, [vs]);
  const p = reveal.prompt;
  // Some vocabulary prompts include the word's Russian meaning before the sentence.
  const wordMeaning = vocabulary && p.kind === "choice"
    ? /^Choose the word meaning\s+[\u00ab\u201c"]([^\u00bb\u201d"]+)[\u00bb\u201d"]\s*:\s*(.+)$/isu.exec(p.prompt_en)
    : null;

  // blocks: a block joins the end of the sentence; a block already placed leaves it (the others keep their order)
  const pickBlock = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const toggle = (id: string, multiple: boolean) => setSelected((cur) => (multiple ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));
  const canSubmit = p.kind === "short" ? (useTiles ? placed.length === tileCount : text.trim().length > 0) : p.kind === "blocks" ? selected.length >= 2 : p.kind === "segments" ? noMistake || selected.length > 0 : selected.length > 0;

  function submit() {
    if (!canSubmit || busy) return;
    if (p.kind === "short") onSubmit(useTiles ? built : text, useTiles ? undefined : draftId ?? undefined);
    else if (p.kind === "segments") onSubmit(noMistake ? [p.noMistakeId] : selected);
    else onSubmit(selected);
  }

  // keyboard: 1-9 pick an option or part, Enter submits, I / H / A / S act, hold M to talk (Alt+M inside the text box)
  const options = p.kind === "choice" ? p.options : p.kind === "reading" ? p.question.options : p.kind === "segments" ? p.segments : [];
  const canHint = !checkMode && (vocabulary || reveal.hintsAvailable > 0);
  useKeys(
    (e) => {
      if (locked || e.ctrlKey || e.metaKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      const typing = isTextField(e.target);
      if (k === "m" && voice && (!typing || e.altKey)) {
        e.preventDefault();
        if (!e.repeat && !busy) voice.holdStart();
        return;
      }
      if (e.altKey) return;
      if (useTiles && e.key === "Backspace" && !typing) {
        e.preventDefault();
        setPlaced((cur) => cur.slice(0, -1));
        return;
      }
      if (typing) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        }
        return;
      }
      if (e.repeat) return;
      if (e.key === "Enter") {
        if (isPressable(e.target)) return; // a focused button does its own thing
        e.preventDefault();
        submit();
        return;
      }
      if (busy) return;
      if (/^[1-9]$/.test(k) && Number(k) <= options.length) {
        const o = options[Number(k) - 1]!;
        if (p.kind === "segments") {
          setNoMistake(false);
          toggle(o.id, false);
        } else toggle(o.id, p.kind === "choice" ? p.multiple : false);
        return;
      }
      if (k === "n" && p.kind === "segments") {
        setSelected([]);
        setNoMistake((v) => !v);
      } else if (k === "i") onIdk();
      else if (k === "s") onSkip();
      else if (k === "h" && canHint) onHint();
      else if (k === "a" && !checkMode) onShowAnswer();
    },
    (e) => {
      if (e.key.toLowerCase() === "m" && voice) voice.holdEnd();
    },
    () => voice?.holdEnd(),
  );
  const key = (i: number) => (i < 9 ? <Kbd k={String(i + 1)} /> : null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-label="Exercise"
    >
      {vocabulary && VOCAB_LOOK[reveal.format] ? (
        <>
          <p className="format-tag"><i className={`pi ${VOCAB_LOOK[reveal.format]!.icon}`} aria-hidden="true" /> {VOCAB_LOOK[reveal.format]!.label}</p>
          <p className="instruction">{VOCAB_LOOK[reveal.format]!.instruction}</p>
        </>
      ) : (
        <>
          <p className="format-tag">
            <i className={`pi ${FORMAT_LOOK[reveal.format]?.icon ?? "pi-circle"}`} aria-hidden="true" /> {FORMAT_LOOK[reveal.format]?.label ?? reveal.format}
          </p>
          <p className="instruction">{INSTRUCTION[reveal.format] ?? p.prompt_en}</p>
        </>
      )}

      {p.kind === "choice" && (
        <fieldset className="options">
          <legend className="prompt" data-testid="prompt" data-word-area>{wordMeaning?.[2] ?? p.prompt_en}</legend>
          {!checkMode && isSpeakableSentence(wordMeaning?.[2] ?? p.prompt_en) && <SpeakButton text={wordMeaning?.[2] ?? p.prompt_en} />}
          {wordMeaning && <p lang="ru" className="vocab-word-meaning">{"\u041f\u0435\u0440\u0435\u0432\u043e\u0434 \u0441\u043b\u043e\u0432\u0430: \u00ab"}{wordMeaning[1]}{"\u00bb"}</p>}
          {vocabulary && translation && <p lang="ru" className="vocab-translation" role="status">{translation}</p>}
          {p.options.map((o, i) => (
            <div key={o.id} className="option has-kbd">
              {!locked && key(i)}
              <input id={`${groupId}-${i}`} type={p.multiple ? "checkbox" : "radio"} name={groupId} value={o.id} checked={selected.includes(o.id)} disabled={locked} onChange={() => toggle(o.id, p.multiple)} />
              {!checkMode && isSpeakableSentence(o.text) && <SpeakButton text={o.text} />}
              <label htmlFor={`${groupId}-${i}`} data-word-area>{o.text}</label>
            </div>
          ))}
        </fieldset>
      )}

      {p.kind === "segments" && (
        <fieldset className="options">
          <legend className="visually-hidden">Choose the part of the sentence that contains a mistake</legend>
          {!checkMode && isSpeakableSentence(p.segments.map((s) => s.text).join(" ")) && <SpeakButton text={p.segments.map((s) => s.text).join(" ")} />}
          <p className="prompt sentence" data-testid="prompt" data-word-area>
            {p.segments.map((s, i) => (
              <button
                key={s.id}
                type="button"
                data-segment-id={s.id}
                className={`segment has-kbd${selected.includes(s.id) ? " segment-on" : ""}`}
                aria-pressed={selected.includes(s.id)}
                disabled={locked}
                onClick={() => {
                  setNoMistake(false);
                  toggle(s.id, false);
                }}
              >
                {!locked && key(i)}
                {s.text}
              </button>
            ))}
          </p>
          <button
            type="button"
            className={`btn btn-nomistake has-kbd${noMistake ? " btn-on" : ""}`}
            aria-pressed={noMistake}
            disabled={locked}
            data-testid="no-mistake"
            onClick={() => {
              setSelected([]);
              setNoMistake((v) => !v);
            }}
          >
            {!locked && <Kbd k="N" />}No mistake
          </button>
          <p className="muted small">“No mistake” says the sentence is correct. It is not the same as “I don’t know”.</p>
        </fieldset>
      )}

      {p.kind === "short" && vocabulary && build && useTiles && (
        <div className="short gap-fill tile-build" data-testid="tile-build">
          <p className="prompt" data-testid="prompt" data-word-area>
            {p.prompt_en.split("___").map((part, i, all) => <span key={i}>{part}{i < all.length - 1 && <em lang="ru" className="tile-meaning">{build.meaning_ru}</em>}</span>)}
          </p>
          {translation && <p lang="ru" className="vocab-translation" role="status">{translation}</p>}
          <p lang="ru" className="ru cue small">{p.cue_ru}</p>
          <div className="tile-slots" aria-live="polite" aria-label="Your word">
            {build.pattern.map((n, w) => {
              const from = build.pattern.slice(0, w).reduce((a, b) => a + b, 0);
              return <span key={w} className="tile-word">{Array.from({ length: n }, (_, k) => {
                const at = placed[from + k];
                return at === undefined ? <span key={k} className="tile-slot" /> : <button key={k} type="button" className="tile-slot tile-slot-filled" disabled={locked || from + k !== placed.length - 1} onClick={() => setPlaced((cur) => cur.slice(0, -1))} aria-label={`Remove letter ${build.tiles[at]}`}>{build.tiles[at]}</button>;
              })}</span>;
            })}
          </div>
          <div className="tile-pool" role="group" aria-label="Letters">
            {build.tiles.map((letter, i) => <button key={i} type="button" className="tile" disabled={locked || busy || placed.includes(i) || placed.length >= tileCount} onClick={() => setPlaced((cur) => [...cur, i])}>{letter}</button>)}
          </div>
          {!locked && <p className="small muted">
            <button type="button" className="link" disabled={placed.length === 0} onClick={() => setPlaced([])}>Clear</button>{" · "}
            <button type="button" className="link" onClick={() => { setPlaced([]); setTilesOn(false); }}>Type it instead</button>
            {" · "}Two letters are extra. A wrong word counts as a mistake, like a wrong typed answer.
          </p>}
        </div>
      )}

      {p.kind === "short" && vocabulary && !useTiles && (
        <div className="short gap-fill">
          <p className="prompt" data-testid="prompt" data-word-area>{p.prompt_en}</p>
          {translation && <p lang="ru" className="vocab-translation" role="status">{translation}</p>}
          <p lang="ru" className="ru cue small">{p.cue_ru}</p>
          <label htmlFor={`${groupId}-t`} className="visually-hidden">The missing word</label>
          {build && !locked && <button type="button" className="link" onClick={() => { setText(""); setTilesOn(true); }}>Build it from letters</button>}
          <input id={`${groupId}-t`} className="gap-input" maxLength={80} value={text} readOnly={locked} onChange={(e) => setText(e.target.value)} placeholder={p.max_words === 1 ? "one word" : `${p.max_words} words`} autoComplete="off" spellCheck={false} data-testid="answer-text" />
        </div>
      )}

      {p.kind === "short" && !vocabulary && (
        <div className="short">
          {/starting with|^Source:/i.test(p.prompt_en) && <p className="prompt" style={{ whiteSpace: "pre-line" }}>{p.prompt_en}</p>}
          <p lang="ru" className="ru cue" data-testid="prompt">{p.cue_ru}</p>
          <label htmlFor={`${groupId}-t`} className="visually-hidden">Your answer</label>
          <textarea id={`${groupId}-t`} rows={3} maxLength={2000} value={text} readOnly={locked} onChange={(e) => setText(e.target.value)} placeholder="Type your answer" data-testid="answer-text" />
          {voice && !locked && <VoiceBar voice={voice} busy={busy} hasDraft={draftId !== null} />}
        </div>
      )}

      {p.kind === "blocks" && (
        <div className="blocks" data-testid="blocks">
          <p lang="ru" className="ru cue" data-testid="prompt">{p.cue_ru}</p>
          <p className="blocks-line" aria-live="polite" data-testid="blocks-line">
            {selected.length === 0
              ? <span className="muted">Choose the blocks in order…</span>
              : selected.map((id) => <button key={id} type="button" className="block block-placed" disabled={locked} onClick={() => pickBlock(id)} aria-label={`Remove ${p.blocks.find((b) => b.id === id)?.text}`}>{p.blocks.find((b) => b.id === id)?.text}</button>)}
          </p>
          <div className="blocks-pool" role="group" aria-label="Blocks">
            {p.blocks.map((b) => <button key={b.id} type="button" className="block" disabled={locked || selected.includes(b.id)} aria-pressed={selected.includes(b.id)} onClick={() => pickBlock(b.id)}>{b.text}</button>)}
          </div>
          {!locked && selected.length > 0 && <button type="button" className="link" onClick={() => setSelected([])}>Start again</button>}
          <p className="small muted">One block may not belong to the sentence.</p>
        </div>
      )}

      {p.kind === "reading" && (
        <div className="reading">
          <div className="passage" data-testid="passage" data-word-area>
            {p.paragraphs.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
          <fieldset className="options">
            <legend className="prompt" data-testid="prompt" data-word-area>{p.question.prompt}</legend>
            {p.question.options.map((o, i) => (
              <div key={o.id} className="option has-kbd">
                {!locked && key(i)}
                <input id={`${groupId}-${i}`} type="radio" name={groupId} value={o.id} checked={selected.includes(o.id)} disabled={locked} onChange={() => toggle(o.id, false)} />
                {!checkMode && isSpeakableSentence(o.text) && <SpeakButton text={o.text} />}
              <label htmlFor={`${groupId}-${i}`} data-word-area>{o.text}</label>
              </div>
            ))}
          </fieldset>
        </div>
      )}

      {vocabulary && letters && <div className="letter-hint" aria-label="Letter hint">
        {letters.map((letter, index) => letter === null
          ? <button key={index} type="button" className="letter-hint-tile" disabled={busy || locked} onClick={() => onLetter?.(index)} aria-label={`Reveal letter ${index + 1}`} />
          : /\p{L}/u.test(letter) ? <span key={index} className="letter-hint-tile letter-hint-open">{letter}</span> : <span key={index} className="letter-hint-separator">{letter}</span>)}
      </div>}
      {hint && (
        <p className="hint" lang="ru" data-testid="hint" role="status">
          Hint: {hint}
        </p>
      )}

      {!locked && (
      <div className="actions">
        <button type="submit" className="btn btn-primary has-kbd" disabled={!canSubmit || busy} data-testid="submit">
          <Kbd k="Enter" />
          <i className="pi pi-check" aria-hidden="true" /> Submit
        </button>
        <button type="button" className="btn has-kbd" disabled={busy} onClick={onIdk} data-testid="idk">
          <Kbd k="I" />
          <i className="pi pi-question-circle" aria-hidden="true" /> I don’t know
        </button>
        {vocabulary && !checkMode && !translation && <button type="button" className="btn" disabled={busy} onClick={onTranslation}><i className="pi pi-language" aria-hidden="true" /> Show Russian translation</button>}
        {!checkMode && (
          <button type="button" className="btn has-kbd" disabled={busy || (!vocabulary && reveal.hintsAvailable === 0) || (vocabulary && !!letters)} onClick={onHint} data-testid="hint-btn">
            <Kbd k="H" />
            <i className="pi pi-lightbulb" aria-hidden="true" /> Hint
          </button>
        )}
        {!checkMode && (
          <button type="button" className="btn has-kbd" disabled={busy} onClick={onShowAnswer} data-testid="show-answer">
            <Kbd k="A" />
            <i className="pi pi-eye" aria-hidden="true" /> Show answer &amp; continue
          </button>
        )}
        <button type="button" className="btn has-kbd" disabled={busy} onClick={onSkip} data-testid="skip">
          <Kbd k="S" />
          <i className="pi pi-forward" aria-hidden="true" /> Skip
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
        <button type="button" className="btn btn-voice has-kbd" disabled={busy} onClick={() => void voice.record()} data-testid="record" title="Hold M while you speak, let go to write it down. A new recording replaces the text.">
          <Kbd k="M" />
          <i className="pi pi-microphone" aria-hidden="true" /> {hasDraft ? "Record again" : "Speak instead"}
        </button>
      )}
      {(s.phase === "idle" || s.phase === "unavailable") && <p className="muted small">Hold <kbd>M</kbd> and speak; let go to write it down (<kbd>Alt</kbd>+<kbd>M</kbd> while the cursor is in the text box).</p>}
      {s.phase === "preparing" && (
        <span role="status" className="voice-status muted">
          <i className="pi pi-spin pi-spinner" aria-hidden="true" /> Getting speech ready… wait for the red microphone before you speak.
        </span>
      )}
      {s.phase === "recording" && (
        <div className="voice-live">
          <span className="rec-dot" aria-hidden="true">
            <i className="pi pi-microphone" />
          </span>
          <span className="meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.level * 100)}>
            {Array.from({ length: 12 }, (_, i) => (
              <span key={i} className={i < Math.round(s.level * 12) ? "on" : ""} />
            ))}
          </span>
          <span role="status" className="muted"> Recording… {Math.floor(s.seconds)} s</span>
          <button type="button" className="btn btn-primary" onClick={() => void voice.stopRecording()} data-testid="stop-record">
            <i className="pi pi-stop-circle" aria-hidden="true" /> Stop
          </button>
        </div>
      )}
      {s.phase === "transcribing" && (
        <span role="status" className="voice-status muted">
          <i className="pi pi-spin pi-spinner" aria-hidden="true" /> Writing down what you said…
        </span>
      )}
      {s.phase === "draft" && <p className="muted small" data-testid="voice-draft-note">This is what I heard. Read it and fix anything that is wrong before you submit. The app does not save recordings.</p>}
      {s.phase === "unavailable" && <p className="notice notice-warn" role="status" data-testid="voice-unavailable">{s.message}</p>}
    </div>
  );
}
