import { VocabularyPracticeMetadataSchema } from "@english-lab/contracts";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import type { SessionDeps } from "../domain/sessions/policy.js";
import { lookupWord } from "../domain/vocabulary/repository.js";

export const MATCH_RULE_VERSION = "vocabulary-match-v1";
/** the rush mode's repeat count when the client does not say (the default of Settings: Matching game repeats) */
const DEFAULT_ROUNDS = 3;

/**
 * The word list of the matching game that follows a finished vocabulary practice: every tested word of the session once, with its Russian meaning.
 * Closed until every slot is finished, so the list cannot reveal an answer that is still to be asked.
 */
export function matchWords(db: Db, sessionId: string): Array<{ id: string; en: string; ru: string }> {
  if (!db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(sessionId)) throw new ApiError(404, "SESSION_NOT_FOUND", "Not a vocabulary session");
  const open = (db.prepare("SELECT COUNT(*) AS n FROM session_slots ss WHERE ss.session_id = ? AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type IN ('skip','continue'))").get(sessionId) as { n: number }).n;
  if (open > 0) throw new ApiError(409, "SESSION_NOT_FINISHED", "The matching game opens when every exercise is done");
  const rows = db.prepare("SELECT er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ? ORDER BY ss.rowid").all(sessionId) as Array<{ c: string }>;
  const seenEn = new Set<string>();
  const seenRu = new Set<string>();
  const words: Array<{ id: string; en: string; ru: string }> = [];
  for (const row of rows) {
    const parsed = VocabularyPracticeMetadataSchema.safeParse((JSON.parse(row.c) as { vocabulary?: unknown }).vocabulary);
    if (!parsed.success) continue;
    const en = parsed.data.target.lemma.trim();
    const ru = (lookupWord(db, en)?.translation.text || parsed.data.wordRu || "").trim();
    const enKey = en.toLowerCase();
    const ruKey = ru.toLowerCase();
    // one pair per word, and no two words with the same meaning (that pair would be ambiguous)
    if (!en || !ru || seenEn.has(enKey) || seenRu.has(ruKey)) continue;
    seenEn.add(enKey);
    seenRu.add(ruKey);
    words.push({ id: enKey, en, ru });
  }
  return words;
}

export function registerVocabularyMatchRoutes(app: FastifyInstance, db: Db, deps: SessionDeps): void {
  app.get<{ Params: { sessionId: string } }>("/api/v1/vocabulary-sessions/:sessionId/match-words", async (req) => ({ words: matchWords(db, req.params.sessionId) }));

  /** the finished game: one raw row per word, saved once per session (a repeated send changes nothing). Not Mastery evidence. */
  app.post<{ Params: { sessionId: string }; Body: { mode?: unknown; results?: unknown; rounds?: unknown } }>("/api/v1/vocabulary-sessions/:sessionId/match-results", async (req, reply) => {
    const { sessionId } = req.params;
    const mode = req.body?.mode;
    const input = req.body?.results;
    if ((mode !== "once" && mode !== "rush") || !Array.isArray(input) || input.length === 0 || input.length > 50) throw new ApiError(400, "VALIDATION_ERROR", "Expected a mode and one to fifty results");
    // the rush mode's repeat count is the learner's setting (1-10); the client says which one the game was played with
    const rounds = req.body?.rounds ?? DEFAULT_ROUNDS;
    if (!Number.isInteger(rounds) || (rounds as number) < 1 || (rounds as number) > 10) throw new ApiError(400, "VALIDATION_ERROR", "Rounds must be a whole number from 1 to 10");
    const per = mode === "once" ? 1 : (rounds as number);
    const known = new Set(matchWords(db, sessionId).map((w) => w.id));
    const seen = new Set<string>();
    const rows = (input as Array<{ lemma?: unknown; matched?: unknown; wrong?: unknown }>).map((r) => {
      const lemma = typeof r?.lemma === "string" ? r.lemma.trim().toLowerCase() : "";
      const matched = r?.matched;
      const wrong = r?.wrong;
      if (!known.has(lemma) || seen.has(lemma) || !Number.isInteger(matched) || (matched as number) < 0 || (matched as number) > per || !Number.isInteger(wrong) || (wrong as number) < 0 || (wrong as number) > 500) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid matching result");
      }
      seen.add(lemma);
      return { lemma, matched: matched as number, wrong: wrong as number };
    });
    const saved = db
      .transaction(() => {
        if (db.prepare("SELECT 1 FROM vocabulary_match_results WHERE session_id = ?").get(sessionId)) return false;
        const now = deps.now().toISOString();
        const put = db.prepare("INSERT INTO vocabulary_match_results(id, session_id, lemma, mode, needed, matched, wrong, rule_version, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
        for (const r of rows) put.run(deps.newId(), sessionId, r.lemma, mode, per, r.matched, r.wrong, MATCH_RULE_VERSION, now);
        return true;
      })
      .immediate();
    return reply.code(saved ? 201 : 200).send({ saved });
  });
}
