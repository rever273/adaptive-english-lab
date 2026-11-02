import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchContentStock, savePreloadModel } from "../../../apps/web/src/api.js";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("api GET dedupe", () => {
  it("sends one request for identical concurrent GETs and a fresh one after a mutation", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      await new Promise((r) => setTimeout(r, 5));
      if (url === "/api/v1/session") return json({ csrfToken: "t" });
      if (url === "/api/v1/settings") return json({ revision: 1, values: {}, defaults: {} });
      return json({ grammar: { available: 1, threshold: 1, low: false }, vocabulary: { available: 1, threshold: 1, low: false } });
    }));
    // ContentStockNotice and Content Studio ask at the same time
    const [a, b, c] = await Promise.all([fetchContentStock(), fetchContentStock(), fetchContentStock()]);
    expect(a).toEqual(b);
    expect(c.grammar.available).toBe(1);
    expect(calls.filter((x) => x === "GET /api/v1/content/stock")).toHaveLength(1);
    // a read that starts after a write is a new request, never an answer to the older one
    const early = fetchContentStock();
    const write = savePreloadModel(true);
    const late = fetchContentStock();
    await Promise.all([early, write, late]);
    expect(calls.filter((x) => x === "GET /api/v1/content/stock")).toHaveLength(3);
  });
});
