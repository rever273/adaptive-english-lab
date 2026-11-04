import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";

type Options = { request?: typeof fetch; email?: string };

const Body = z.object({ text: z.string().trim().min(1).max(3000) }).strict();
const CACHE_LIMIT = 500;

/**
 * Quick Russian translation of one English sentence (the Books reading aid) from MyMemory, a public translation API that needs no key
 * (about 5 000 characters a day anonymously; giving an e-mail raises that to about 50 000: set MYMEMORY_EMAIL in `.env`). Google's
 * unofficial endpoint was tried first and answers automated requests with HTTP 429 and a "Sorry…" page, so it is not used.
 * Only the sentence leaves the machine, on an explicit key press. Answers are cached in memory.
 */
export function registerTranslateRoutes(app: FastifyInstance, options: Options = {}): void {
  const request = options.request ?? fetch;
  const cache = new Map<string, string>();
  app.post("/api/v1/translate", async (req) => {
    const body = Body.safeParse(req.body);
    if (!body.success) throw new ApiError(400, "VALIDATION_ERROR", "Expected a short text to translate");
    let text = body.data.text.replace(/\s+/g, " ");
    // the service takes at most 500 characters: a very long sentence is translated up to a word boundary
    if (text.length > 450) text = text.slice(0, text.lastIndexOf(" ", 450));
    const hit = cache.get(text);
    if (hit !== undefined) return { text: hit, cached: true };

    const url = new URL("https://api.mymemory.translated.net/get");
    const params = new URLSearchParams({ q: text, langpair: "en|ru" });
    if (options.email) params.set("de", options.email);
    url.search = params.toString();
    let response: Response;
    try {
      response = await request(url, { signal: AbortSignal.timeout(10000) });
    } catch {
      throw new ApiError(502, "TRANSLATE_UNAVAILABLE", "Could not reach the translation service.");
    }
    if (response.status === 429) throw new ApiError(429, "TRANSLATE_RATE_LIMIT", "The translation service is limiting requests; try again later.");
    if (!response.ok) throw new ApiError(502, "TRANSLATE_UNAVAILABLE", `The translation service answered HTTP ${response.status}.`);
    let translated = "";
    let quotaFinished = false;
    try {
      const json = (await response.json()) as { responseData?: { translatedText?: unknown }; quotaFinished?: unknown; responseStatus?: unknown };
      quotaFinished = json.quotaFinished === true || json.responseStatus === 429;
      if (typeof json.responseData?.translatedText === "string") translated = json.responseData.translatedText.trim();
    } catch {
      /* handled below */
    }
    if (quotaFinished) throw new ApiError(429, "TRANSLATE_RATE_LIMIT", "Today's free translation quota is used up. Set MYMEMORY_EMAIL in .env to raise it.");
    // the service reports its own errors as text in the same field
    if (!translated || /^(MYMEMORY WARNING|PLEASE SELECT TWO DISTINCT LANGUAGES|INVALID)/i.test(translated)) throw new ApiError(502, "TRANSLATE_UNAVAILABLE", "The translation service returned nothing usable.");
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(text, translated);
    return { text: translated, cached: false };
  });
}
