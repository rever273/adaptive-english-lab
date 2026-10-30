import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";

export const MAX_EXTERNAL_BYTES = 1024 * 1024;
const MAX_ASSERTIONS = 200;

export const ImportRequestSchema = z
  .object({
    format: z.enum(["md", "json"]),
    text: z.string().min(1),
    source: z.string().trim().min(1).max(100),
    assessedAt: z.string().trim().min(8).max(40),
    method: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(120).optional(),
    transcriptQuality: z.enum(["unknown", "poor", "fair", "good"]).default("unknown"),
  })
  .strict();
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

/** JSON import shape: measures with their own words, plus limitations. Anything else is refused rather than guessed at. */
const JsonReportSchema = z
  .object({
    schema_version: z.literal("external-assessment-v1").optional(),
    measures: z.array(z.object({ label: z.string().min(1).max(200), value: z.union([z.number(), z.string().max(200)]).optional(), unit: z.string().max(40).optional(), note: z.string().max(500).optional() }).strict()).max(MAX_ASSERTIONS),
    limitations: z.array(z.string().max(500)).max(50).optional(),
  })
  .strict();

export interface Assertion {
  /** where in the source it came from: heading path + 1-based line */
  source: { section: string; line: number };
  kind: "reported_value" | "note";
  text: string;
  /** a percentage found in the text, as written; NEVER merged with an internal number */
  percent: number | null;
  /** always uncertain: an outside statement is a hypothesis, not evidence */
  status: "uncertain";
}
export interface Normalized {
  schema: "external-normalized-v1";
  assertions: Assertion[];
  limitations: string[];
  /** lines that look like markup or links: kept as text, flagged, never rendered or followed */
  flags: string[];
  truncated: boolean;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const PERCENT = /(\d{1,3}(?:[.,]\d+)?)\s?%/;
const MARKUP = /<\s*\/?\s*(script|iframe|img|object|embed|style|svg)\b|javascript:|data:text\/html|on\w+\s*=|\]\(\s*(?:javascript|file|data):/i;

export function normalizeMarkdown(text: string): Normalized {
  const out: Assertion[] = [];
  const flags: string[] = [];
  const stack: string[] = [];
  let truncated = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    if (MARKUP.test(line)) flags.push(`line ${i + 1}: contains markup or a link scheme; kept as plain text only`);
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      stack.length = Math.min(stack.length, h[1]!.length - 1);
      stack[h[1]!.length - 1] = h[2]!.trim().slice(0, 120);
      return;
    }
    if (out.length >= MAX_ASSERTIONS) {
      truncated = true;
      return;
    }
    const body = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").slice(0, 500);
    const m = PERCENT.exec(body);
    out.push({ source: { section: stack.filter(Boolean).join(" > ") || "(top)", line: i + 1 }, kind: m ? "reported_value" : "note", text: body, percent: m ? Number(m[1]!.replace(",", ".")) : null, status: "uncertain" });
  });
  return { schema: "external-normalized-v1", assertions: out, limitations: [], flags, truncated };
}

export function normalizeJson(text: string): Normalized {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(422, "EXTERNAL_INVALID", "The JSON could not be read");
  }
  const r = JsonReportSchema.safeParse(parsed);
  if (!r.success) throw new ApiError(422, "EXTERNAL_INVALID", "The JSON does not match external-assessment-v1", r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })));
  const flags: string[] = [];
  const out: Assertion[] = r.data.measures.map((m, i) => {
    const t = [m.label, m.value !== undefined ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : null, m.note].filter(Boolean).join(": ").slice(0, 500);
    if (MARKUP.test(t)) flags.push(`measure ${i + 1}: contains markup or a link scheme; kept as plain text only`);
    const pct = m.unit === "%" && typeof m.value === "number" ? m.value : (PERCENT.exec(t)?.[1] ? Number(PERCENT.exec(t)![1]!.replace(",", ".")) : null);
    return { source: { section: "measures", line: i + 1 }, kind: pct !== null ? "reported_value" : "note", text: t, percent: pct, status: "uncertain" };
  });
  return { schema: "external-normalized-v1", assertions: out, limitations: r.data.limitations ?? [], flags, truncated: false };
}

export interface ExternalView {
  id: string;
  source: string;
  assessedAt: string;
  importedAt: string;
  method: string;
  model: string | null;
  transcriptQuality: string;
  format: string;
  status: string;
  decidedAt: string | null;
  normalized: Normalized;
  comparability: { comparableToInternalMastery: false; reasons: string[] };
  /** the raw text, as stored; clients show it as TEXT */
  originalText?: string;
}

const COMPARABILITY = { comparableToInternalMastery: false as const, reasons: ["Another method, scale and sample: its percentages are never added to, averaged with or compared mechanically against the numbers computed here.", "It creates no skill opportunity and does not change Mastery or exercise selection."] };

interface Deps {
  now: () => Date;
  newId?: () => string;
}

const toView = (r: Record<string, any>, withText: boolean): ExternalView => ({
  id: r.id,
  source: r.source,
  assessedAt: r.assessed_at,
  importedAt: r.imported_at,
  method: r.method_version,
  model: r.model_version,
  transcriptQuality: r.transcript_quality,
  format: r.format,
  status: r.status,
  decidedAt: r.decided_at,
  normalized: JSON.parse(r.normalized_json) as Normalized,
  comparability: JSON.parse(r.comparability_json) as ExternalView["comparability"],
  ...(withText ? { originalText: r.original_text as string } : {}),
});

/** Step 1: size and schema check, normalised PREVIEW stored as a draft. Nothing outside this table is touched. */
export function importExternal(db: Db, deps: Deps, input: unknown): { view: ExternalView; created: boolean } {
  const parsed = ImportRequestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Import request is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const req = parsed.data;
  if (Buffer.byteLength(req.text, "utf8") > MAX_EXTERNAL_BYTES) throw new ApiError(413, "EXTERNAL_TOO_LARGE", "The report is larger than 1 MiB");
  const at = Date.parse(req.assessedAt);
  if (Number.isNaN(at)) throw new ApiError(422, "EXTERNAL_INVALID", "assessedAt must be a date");
  if (at > deps.now().getTime() + 86_400_000) throw new ApiError(422, "EXTERNAL_INVALID", "assessedAt is in the future");
  const assessedAt = new Date(at).toISOString().slice(0, 10);
  const normalized = req.format === "json" ? normalizeJson(req.text) : normalizeMarkdown(req.text);
  const hash = sha256(req.text);
  return db
    .transaction((): { view: ExternalView; created: boolean } => {
      const found = db.prepare("SELECT * FROM external_assessments WHERE source = ? AND assessed_at = ? AND content_hash = ?").get(req.source, assessedAt, hash) as Record<string, any> | undefined;
      if (found) return { view: toView(found, false), created: false }; // the same report again: the same record
      const id = (deps.newId ?? randomUUID)();
      db.prepare(
        "INSERT INTO external_assessments(id, source, assessed_at, imported_at, method_version, model_version, transcript_quality, format, content_hash, original_text, normalized_json, comparability_json, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(id, req.source, assessedAt, deps.now().toISOString(), req.method, req.model ?? null, req.transcriptQuality, req.format, hash, req.text, JSON.stringify(normalized), JSON.stringify(COMPARABILITY), "draft");
      return { view: toView(db.prepare("SELECT * FROM external_assessments WHERE id = ?").get(id) as Record<string, any>, false), created: true };
    })
    .immediate();
}

/** Step 2: the user's decision about the RECORD (keep it as a separate series, or drop it). It says nothing about whether the report is right. */
export function decideExternal(db: Db, deps: Deps, id: string, decision: "approved" | "rejected"): ExternalView {
  return db
    .transaction((): ExternalView => {
      const r = db.prepare("SELECT * FROM external_assessments WHERE id = ?").get(id) as Record<string, any> | undefined;
      if (!r) throw new ApiError(404, "EXTERNAL_NOT_FOUND", "Unknown external assessment");
      if (r.status !== "draft") throw new ApiError(409, "EXTERNAL_DECIDED", `Already ${r.status}`);
      db.prepare("UPDATE external_assessments SET status = ?, decided_at = ? WHERE id = ?").run(decision, deps.now().toISOString(), id);
      return toView(db.prepare("SELECT * FROM external_assessments WHERE id = ?").get(id) as Record<string, any>, false);
    })
    .immediate();
}

export function listExternal(db: Db): { series: ExternalView[]; note: string } {
  const rows = db.prepare("SELECT * FROM external_assessments ORDER BY assessed_at, imported_at, id").all() as Array<Record<string, any>>;
  return { series: rows.map((r) => toView(r, false)), note: "Each outside report is its own point in time. Compare them by reading what each one measured and how, not by adding percentages together." };
}

export function readExternal(db: Db, id: string): ExternalView {
  const r = db.prepare("SELECT * FROM external_assessments WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!r) throw new ApiError(404, "EXTERNAL_NOT_FOUND", "Unknown external assessment");
  return toView(r, true);
}
