import { createReadStream, readdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { normalizeWord, regularForms } from "../domain/vocabulary/forms.js";

/** Index only the configured directory; ambiguous inflections deliberately have no match. */
export function registerVocabularyImageRoutes(app: FastifyInstance, directory?: string): void {
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
  app.get<{ Params: { word: string } }>("/api/v1/vocabulary-image/:word", async (req, reply) => {
    const word = normalizeWord(req.params.word);
    const file = exact.get(word) ?? forms.get(word);
    if (!directory || !file) return reply.code(404).send();
    reply.header("Cache-Control", "no-store").type("image/jpeg");
    return reply.send(createReadStream(path.join(directory, file)));
  });
}
