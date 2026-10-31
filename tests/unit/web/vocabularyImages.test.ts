import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerVocabularyImageRoutes } from "../../../apps/server/src/routes/vocabularyImages.js";

describe("local vocabulary images", () => {
  it("serves exact matches and unambiguous regular forms, and rejects missing or ambiguous matches", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vocab-images-"));
    const app = Fastify();
    try {
      writeFileSync(path.join(dir, "#walk.jpg"), "walk image");
      writeFileSync(path.join(dir, "#hope.jpg"), "hope image");
      writeFileSync(path.join(dir, "#hop.jpg"), "hop image");
      registerVocabularyImageRoutes(app, dir);
      expect((await app.inject({ url: "/api/v1/vocabulary-image/WALK" })).body).toBe("walk image");
      expect((await app.inject({ url: "/api/v1/vocabulary-image/walking" })).body).toBe("walk image");
      expect((await app.inject({ url: "/api/v1/vocabulary-image/hoping" })).statusCode).toBe(404);
      expect((await app.inject({ url: "/api/v1/vocabulary-image/missing" })).statusCode).toBe(404);
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

