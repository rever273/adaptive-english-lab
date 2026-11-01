import { createReadStream, readdirSync } from "node:fs";
import path from "node:path";
import type { Db } from "../db/open.js";
import type { FastifyInstance } from "fastify";
import { normalizeWord, regularForms } from "../domain/vocabulary/forms.js";

/** Index only the configured directory; ambiguous inflections deliberately have no match. */
export function registerVocabularyImageRoutes(app: FastifyInstance, directory?: string, db?: Db): void {
  const exact = new Map<string, string>();
  const forms = new Map<string, string | null>();
  if (directory) {
    try {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || !/^#.+\.jpg$/i.test(file.name)) continue;
        const word = normalizeWord(file.name.slice(1, -4));
        if (word) exact.set(word, file.name);
      }
      for (const [word, file] of exact) for (const form of regularForms(word)) {
        if (form === word) continue;
        forms.set(form, forms.has(form) && forms.get(form) !== file ? null : file);
      }
    } catch { /* An unavailable optional image directory does not prevent startup. */ }
  }
  app.get<{ Params: { slotId: string } }>("/api/v1/vocabulary-slot-image/:slotId", async (req, reply) => {
    const row = db?.prepare(`SELECT er.content_json AS c FROM session_slots ss
      JOIN vocabulary_sessions vs ON vs.session_id = ss.session_id
      JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
      WHERE ss.id = ? AND EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type = 'reveal')`).get(req.params.slotId) as { c: string } | undefined;
    const lemma = row ? (JSON.parse(row.c) as { vocabulary?: { target?: { lemma?: string } } }).vocabulary?.target?.lemma : undefined;
    const word = lemma ? normalizeWord(lemma) : "";
    const file = exact.get(word) ?? forms.get(word);
    if (!directory || !file) return reply.code(404).send();
    reply.header("Cache-Control", "no-store").type("image/jpeg");
    return reply.send(createReadStream(path.join(directory, file)));
  });
  app.get<{ Params: { word: string } }>("/api/v1/vocabulary-image/:word", async (req, reply) => {
    const word = normalizeWord(req.params.word);
    const file = exact.get(word) ?? forms.get(word);
    if (!directory || !file) return reply.code(404).send();
    reply.header("Cache-Control", "no-store").type("image/jpeg");
    return reply.send(createReadStream(path.join(directory, file)));
  });
}
