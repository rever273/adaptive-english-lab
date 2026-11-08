import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";

type Options = { request?: typeof fetch; email?: string; deeplKey?: string };

const Body = z.object({ text: z.string().trim().min(1).max(3000) }).strict();
const CACHE_LIMIT = 500;

/**
 * DeepL API Developer/Free is used when DEEPL_API_KEY is set; otherwise MyMemory is used.
 * MyMemory is a public translation API that needs no key
 * (about 5 000 characters a day anonymously; giving an e-mail raises that to about 50 000: set MYMEMORY_EMAIL in `.env`). Google's
 * unofficial endpoint was tried first and answers automated requests with HTTP 429 and a "Sorry…" page, so it is not used.
 * Only the sentence leaves the machine, on an explicit key press. Answers are cached in memory.
 */
export function registerTranslateRoutes(app: FastifyInstance, options: Options = {}): void {
  const request = options.request ?? fetch;
  const cache = new Map<string, string>();
  app.get("/api/v1/translate/usage", async () => {
    if (!options.deeplKey) return { available: false, reason: "DeepL API key is not configured." };
    try {
      const response = await request("https://api-free.deepl.com/v2/usage", {
        headers: { Authorization: `DeepL-Auth-Key ${options.deeplKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return { available: false, reason: response.status === 403 ? "DeepL rejected the API key." : "DeepL usage is unavailable right now." };
      const data = await response.json() as { character_count?: unknown; character_limit?: unknown };
      if (typeof data.character_count !== "number" || !Number.isSafeInteger(data.character_count) || data.character_count < 0 ||
          typeof data.character_limit !== "number" || !Number.isSafeInteger(data.character_limit) || data.character_limit < 0) {
        return { available: false, reason: "DeepL returned invalid usage data." };
      }
      return { available: true, used: data.character_count, limit: data.character_limit };
    } catch {
      return { available: false, reason: "Could not reach DeepL." };
    }
  });
  app.post("/api/v1/translate", async (req) => {
    const body = Body.safeParse(req.body);
    if (!body.success) throw new ApiError(400, "VALIDATION_ERROR", "Expected a short text to translate");
    let text = body.data.text.replace(/\s+/g, " ");
    // MyMemory has a 500-character limit; DeepL accepts the entire sentence.
    if (!options.deeplKey && text.length > 450) {
      const boundary = text.lastIndexOf(" ", 450);
      text = text.slice(0, boundary > 0 ? boundary : 450);
    }
    const hit = cache.get(text);
    if (hit !== undefined) return { text: hit, cached: true };

    if (options.deeplKey) {
      let response: Response;
      try {
        response = await request("https://api-free.deepl.com/v2/translate", {
          method: "POST", signal: AbortSignal.timeout(10000),
          headers: { Authorization: `DeepL-Auth-Key ${options.deeplKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: [text], source_lang: "EN", target_lang: "RU" }),
        });
      } catch { throw new ApiError(502, "TRANSLATE_UNAVAILABLE", "Could not reach DeepL."); }
      if (response.status === 456) throw new ApiError(429, "TRANSLATE_RATE_LIMIT", "DeepL translation quota is exhausted.");
      if (response.status === 429) throw new ApiError(429, "TRANSLATE_RATE_LIMIT", "DeepL is limiting requests; try again later.");
      if (response.status === 403) throw new ApiError(502, "TRANSLATE_UNAVAILABLE", "DeepL rejected the API key; check DEEPL_API_KEY in .env.");
      if (!response.ok) throw new ApiError(502, "TRANSLATE_UNAVAILABLE", `DeepL answered HTTP ${response.status}.`);
      let translated = "";
      try { const body = await response.json() as { translations?: Array<{ text?: unknown }> }; if (typeof body.translations?.[0]?.text === "string") translated = body.translations[0].text.trim(); } catch { /* handled below */ }
      if (!translated) throw new ApiError(502, "TRANSLATE_UNAVAILABLE", "DeepL returned no translation.");
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      cache.set(text, translated);
      return { text: translated, cached: false };
    }

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
