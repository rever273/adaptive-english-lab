import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Db } from "../../../apps/server/src/db/open.js";
import type { RealAudit } from "../../../apps/server/src/domain/typing/dictation/realAudit.js";
import type { DictationEnv } from "../../../apps/server/src/domain/typing/dictation/lessons.js";
import { registerTypingDictationRoutes } from "../../../apps/server/src/routes/typingDictation.js";

describe("real speech audit routes", () => {
  it("reports status and changes the toggle", async () => {
    const app = Fastify();
    let enabled = false;
    const status = () => ({ enabled, running: false, checked: 0, matched: 0, pendingReview: 0, error: null, progress: null });
    const realAudit = { status, setEnabled: (next: boolean) => { enabled = next; return status(); } } as RealAudit;
    registerTypingDictationRoutes(app, {} as Db, { now: () => new Date(), newId: () => "test" }, { env: {} as DictationEnv, realAudit });
    try {
      expect((await app.inject({ method: "GET", url: "/api/v1/typing/dictation/real-audit" })).json()).toMatchObject({ enabled: false });
      expect((await app.inject({ method: "POST", url: "/api/v1/typing/dictation/real-audit", payload: { enabled: true } })).json()).toMatchObject({ enabled: true });
    } finally { await app.close(); }
  });
});
