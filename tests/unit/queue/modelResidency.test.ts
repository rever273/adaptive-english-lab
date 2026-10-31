import { describe, expect, it } from "vitest";
import { ModelResidency } from "../../../apps/server/src/queue/modelResidency.js";
import { deferred, FakeDispatcher, FakeModelHost } from "../../fixtures/queue/fakes.js";

const TAG = "gemma4:12b";
function make(over: { preload?: boolean } = {}) {
  const host = new FakeModelHost();
  const dispatcher = new FakeDispatcher();
  const flags = { preload: over.preload ?? true, auto: true };
  const residency = new ModelResidency({ host, dispatcher, model: TAG, numCtx: 8192, keepAlive: "30m", preloadEnabled: () => flags.preload, autoAllowed: () => flags.auto, unloadVerifyMs: 50, sleep: async () => undefined });
  return { host, dispatcher, flags, residency };
}
const done = async (b: ReturnType<ModelResidency["load"]>) => {
  expect(b.ok).toBe(true);
  if (b.ok) await b.done;
};

describe("model residency state machine (D67)", () => {
  it("unloaded -> loading -> ready; load is idempotent (one call to the server) and tells the dispatcher", async () => {
    const { host, dispatcher, residency } = make();
    expect((await residency.status()).state).toBe("unloaded");
    host.loadGate = deferred();
    const a = residency.load();
    const b = residency.load();
    expect(residency.transitioning()).toBe(true);
    expect((await residency.status()).state).toBe("loading");
    host.loadGate.resolve();
    await done(a);
    await done(b);
    expect(host.loads).toBe(1);
    const s = await residency.status();
    expect(s).toMatchObject({ state: "ready", model: TAG, error: null, busy: null });
    expect(s.lastLoadMs).not.toBeNull();
    expect(s.loadedSince).not.toBeNull();
    expect(dispatcher.loadedNotes).toBe(1);
    await done(residency.load()); // already resident: nothing to do
    expect(host.loads).toBe(1);
    expect(residency.transitioning()).toBe(false);
  });

  it("a failed load shows the reason (error state) and a later load recovers", async () => {
    const { host, residency } = make();
    host.failLoad = "boom";
    await done(residency.load());
    expect(await residency.status()).toMatchObject({ state: "error", error: "boom" });
    host.failLoad = null;
    await done(residency.load());
    expect((await residency.status()).state).toBe("ready");
  });

  it("not enough free graphics memory is an error, not a half-loaded model", async () => {
    const { host, dispatcher, residency } = make();
    dispatcher.shortfall = "insufficient_vram";
    await done(residency.load());
    expect(host.loads).toBe(0);
    expect(await residency.status()).toMatchObject({ state: "error", error: "insufficient_vram" });
  });

  it("an unreachable model server is reported as an error", async () => {
    const { host, residency } = make();
    host.reachable = false;
    expect(await residency.status()).toMatchObject({ state: "error", error: "model_server_unreachable" });
  });

  it("unload is verified through /api/ps: a model that stays resident is an error, not 'unloaded'", async () => {
    const { host, dispatcher, residency } = make();
    await done(residency.load());
    host.stickyUnload = true;
    await done(residency.unload());
    expect(await residency.status()).toMatchObject({ state: "ready" }); // still resident: the truth is /api/ps
    host.stickyUnload = false;
    await done(residency.unload());
    expect((await residency.status()).state).toBe("unloaded");
    expect(dispatcher.releasedNotes).toBe(1);
  });

  it("unload is refused (with the reason) while a unit holds the model or a load runs; load is refused while local speech owns the card", async () => {
    const { host, dispatcher, residency } = make();
    await done(residency.load());
    dispatcher.job = { kind: "free_text_analysis" };
    expect(await residency.status()).toMatchObject({ busy: "job_running" });
    expect(residency.unload()).toEqual({ ok: false, reason: "job_running" });
    expect(host.unloads).toBe(0);
    dispatcher.job = null;
    await done(residency.unload());
    dispatcher.practice = true;
    expect(residency.load()).toEqual({ ok: false, reason: "practice_active" });
    dispatcher.practice = false;
    host.loadGate = deferred();
    const l = residency.load();
    expect(residency.unload()).toEqual({ ok: false, reason: "loading" });
    host.loadGate.resolve();
    await done(l);
  });

  it("automatic warm-up honours the setting; a manual unload switches it off until a manual load", async () => {
    const { host, flags, residency } = make({ preload: false });
    expect(residency.load({ auto: true })).toEqual({ ok: false, reason: "auto_disabled" });
    residency.noteActivity();
    residency.warmOnStart();
    expect(host.loads).toBe(0);
    expect(residency.idleUnloadMs()).toBe(60_000);
    flags.preload = true;
    expect(residency.idleUnloadMs()).toBe(30 * 60_000);
    residency.warmOnStart();
    await new Promise((r) => setTimeout(r, 5)); // the background load started by warmOnStart
    expect(host.loads).toBe(1);
    await done(residency.unload()); // manual
    residency.noteActivity();
    expect(residency.load({ auto: true })).toEqual({ ok: false, reason: "auto_disabled" });
    expect(host.loads).toBe(1);
    await done(residency.load()); // manual load re-enables it
    expect(host.loads).toBe(2);
  });

  it("learner activity starts one background load, not one per request", async () => {
    const { host, residency } = make();
    host.loadGate = deferred();
    residency.noteActivity();
    residency.noteActivity();
    residency.noteActivity();
    host.loadGate.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(host.loads).toBe(1);
  });

  it("a model owned by a running unit is left alone: no VRAM check, no second /api/generate", async () => {
    const { host, dispatcher, residency } = make();
    dispatcher.job = { kind: "free_text_analysis" };
    dispatcher.shortfall = "insufficient_vram"; // would be an error if it were checked
    await done(residency.load());
    expect(host.loads).toBe(0);
    expect(residency.transitioning()).toBe(false);
    expect((await residency.status()).error).toBeNull();
  });

  it("activity on an already-resident model never enters 'loading' (so an unload is not blocked and no toast flashes)", async () => {
    const { host, residency } = make();
    await done(residency.load());
    host.loads = 0;
    residency.noteActivity();
    expect(residency.transitioning()).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(host.loads).toBe(0);
    expect(residency.transitioning()).toBe(false);
  });

  it("no automatic load while routing is off (digest drift / runners disabled); the manual button still works", async () => {
    const { host, flags, residency } = make();
    flags.auto = false;
    residency.warmOnStart();
    residency.noteActivity();
    await new Promise((r) => setTimeout(r, 5));
    expect(host.loads).toBe(0);
    await done(residency.load());
    expect(host.loads).toBe(1);
  });

  it("abortLoad stops a load in flight without leaving an error, and says which model to prove released", async () => {
    const { host, residency } = make();
    host.loadGate = deferred();
    const b = residency.load();
    expect(await residency.abortLoad()).toEqual([TAG]);
    if (b.ok) await b.done;
    expect(residency.transitioning()).toBe(false);
    expect(await residency.status()).toMatchObject({ state: "unloaded", error: null });
    expect(await residency.abortLoad()).toEqual([]);
  });

  it("shutdown unloads the model and refuses new loads", async () => {
    const { host, residency } = make();
    await done(residency.load());
    await residency.shutdown(1000);
    expect(host.resident.has(TAG)).toBe(false);
    expect(residency.load()).toEqual({ ok: false, reason: "shutting_down" });
  });
});
