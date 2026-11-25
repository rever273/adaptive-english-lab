import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerUiRoutes } from "../../../apps/server/src/routes/ui.js";

/** reads an event stream until `text` appears or the time is up */
async function seen(url: string, text: string, ms: number): Promise<{ got: boolean; abort: () => void }> {
  const ctl = new AbortController();
  const res = await fetch(url, { signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const got = await Promise.race([
    (async () => { for (;;) { const r = await reader.read(); if (r.done) return false; buf += dec.decode(r.value); if (buf.includes(text)) return true; } })().catch(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
  return { got, abort: () => ctl.abort() };
}

it("a page that connects later replaces the earlier one; the same page reconnecting does not", async () => {
  // the kept-alive sockets of the aborted streams would hold app.close() for several seconds on Windows and push the test over the default 5 s timeout
  const app = Fastify({ forceCloseConnections: true });
  registerUiRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/v1/ui`;
  try {
    const first = new AbortController();
    const a = await fetch(`${base}/stream?id=a`, { signal: first.signal });
    const reader = a.body!.getReader();
    let text = "";
    const pump = (async () => { const dec = new TextDecoder(); for (;;) { const r = await reader.read().catch(() => ({ done: true, value: undefined })); if (r.done) return; text += dec.decode(r.value); } })();
    await new Promise((r) => setTimeout(r, 100));
    const same = await seen(`${base}/stream?id=a`, "replaced", 300); // a reconnect of the same page
    same.abort();
    expect(text).not.toContain("replaced");
    const other = await seen(`${base}/stream?id=b`, "replaced", 300); // another page
    other.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(text).toContain("event: replaced");
    first.abort();
    await pump;
  } finally { await app.close(); }
});
