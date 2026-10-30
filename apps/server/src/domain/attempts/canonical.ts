import type { AttemptRequest } from "@english-lab/contracts";

/** Stored verbatim in attempts.raw_answer_json; the original text/IDs are never normalised or rewritten. */
export type RawAnswer =
  | { schema_version: 1; kind: "text"; text: string }
  | { schema_version: 1; kind: "options"; optionIds: string[] }
  | { schema_version: 1; kind: "idk" };

export function toRawAnswer(req: Pick<AttemptRequest, "answer" | "idk">): RawAnswer {
  if (req.idk === true) return { schema_version: 1, kind: "idk" };
  if (typeof req.answer === "string") return { schema_version: 1, kind: "text", text: req.answer };
  if (Array.isArray(req.answer)) return { schema_version: 1, kind: "options", optionIds: [...req.answer] };
  throw new Error("attempt has neither answer nor idk");
}

/** Fixed key order so equal answers always serialise to equal bytes. */
export function rawAnswerJson(a: RawAnswer): string {
  switch (a.kind) {
    case "text":
      return JSON.stringify({ schema_version: 1, kind: "text", text: a.text });
    case "options":
      return JSON.stringify({ schema_version: 1, kind: "options", optionIds: a.optionIds });
    case "idk":
      return JSON.stringify({ schema_version: 1, kind: "idk" });
  }
}

/** Learning day in the session's own time zone (spec/03: UTC date does not define the learning day). */
export function localDateIn(timeZone: string, at: Date): string {
  // en-CA formats as YYYY-MM-DD; throws RangeError for an invalid zone.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export interface AttemptFacts {
  firstAttempt: boolean;
  hintsBefore: number;
  answerSeenBefore: boolean;
}

/** Unaided independent evidence: first attempt, no hint, answer not shown (spec/04). Retries never qualify. */
export function isIndependent(f: AttemptFacts): boolean {
  return f.firstAttempt && f.hintsBefore === 0 && !f.answerSeenBefore;
}

export function isAssisted(f: Pick<AttemptFacts, "hintsBefore" | "answerSeenBefore">): boolean {
  return f.hintsBefore > 0 || f.answerSeenBefore;
}

export interface StoredSubmission {
  slot_id: string;
  raw_answer_json: string;
  input_mode: string;
  transcript_id: string | null;
  idk: number;
}

/** Whether a repeated submissionId carries the same payload (replay) or a different one (conflict). */
export function sameSubmission(stored: StoredSubmission, req: AttemptRequest): boolean {
  return (
    stored.slot_id === req.slotId &&
    stored.raw_answer_json === rawAnswerJson(toRawAnswer(req)) &&
    stored.input_mode === req.inputMode &&
    stored.transcript_id === (req.transcriptId ?? null) &&
    stored.idk === (req.idk === true ? 1 : 0)
  );
}
