import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { startConversation, submitConversation, conversationState, pauseConversation, resumeConversation } from "../../../apps/server/src/domain/conversation/repository.js";
import { runConversation } from "../../../apps/server/src/domain/conversation/runner.js";
import { SttService } from "../../../apps/server/src/domain/stt/sttService.js";
import type { ChatMessage } from "../../../apps/server/src/domain/ai/clients.js";
import type { RunnerContext } from "../../../apps/server/src/queue/types.js";
import type { ConversationPayload } from "../../../apps/server/src/domain/conversation/runner.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { createDictationEnv } from "../../../apps/server/src/domain/typing/dictation/env.js";
import { VoiceService } from "../../../apps/server/src/domain/voices/service.js";
import { checkedConversationSpeech } from "../../../apps/server/src/domain/conversation/speech.js";
import { LocalDictationAsr } from "../../../apps/server/src/domain/typing/dictation/asr.js";
import { writeFileSync } from "node:fs";
import { freePort, makeScratchRoot, projectRoot, testConfig } from "../helpers.js";

function sampleWav(): Buffer {
  const rate = 22050, samples = rate, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 10) * 3000), 44 + i * 2);
  return wav;
}

it("checks every generated clip, retries mismatches and never returns unchecked speech", async () => {
  let generated = 0, checked = 0;
  const tts = { available: () => ({ ok: true as const, modelSha256: "test" }), synthesize: async () => { generated++; return sampleWav(); }, stop: async () => undefined };
  const asr = { available: () => true, transcribe: async () => ({ text: ++checked === 1 ? "Hello hello there" : "Hello there", model: "test" }), stop: async () => undefined };
  const args = { text: "Hello there.", params: { speakerId: 0, lengthScale: 1 }, tts, asr, signal: new AbortController().signal };
  expect((await checkedConversationSpeech(args)).subarray(0, 4).toString()).toBe("RIFF");
  expect([generated, checked]).toEqual([2, 2]);
  await expect(checkedConversationSpeech({ ...args, asr: { ...asr, transcribe: async () => ({ text: "Hello hello there", model: "test" }) } })).rejects.toThrow("ASR_MISMATCH");
  await expect(checkedConversationSpeech({ ...args, asr: { ...asr, transcribe: async () => { throw new Error("offline"); } } })).rejects.toThrow("offline");
});

it("cancels a local verifier while its worker is still starting", async () => {
  const scratch = makeScratchRoot();
  const script = path.join(scratch.root, "slow-worker.cjs");
  writeFileSync(script, "setInterval(() => {}, 1000);");
  const asr = new LocalDictationAsr({ script, env: { ENGLISHLAB_PYTHON: process.execPath }, device: "cpu" });
  try {
    const controller = new AbortController();
    const pending = asr.transcribe(sampleWav(), controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow();
  } finally { await asr.stop(); scratch.cleanup(); }
}, 12000);

it("does not stop the local verifier while transcription is running", async () => {
  const scratch = makeScratchRoot();
  const script = path.join(scratch.root, "slow-decode.cjs");
  writeFileSync(script, `const rl=require('node:readline').createInterface({input:process.stdin}); console.log(JSON.stringify({event:'ready'})); rl.on('line',line=>{ const m=JSON.parse(line); if(m.op==='shutdown') process.exit(0); else setTimeout(()=>console.log(JSON.stringify({id:m.id,ok:true,text:'Hello there'})),300); });`);
  const asr = new LocalDictationAsr({ script, env: { ENGLISHLAB_PYTHON: process.execPath }, device: "cpu", idleMs: 50 });
  try { expect((await asr.transcribe(sampleWav(), AbortSignal.timeout(5000))).text).toBe("Hello there"); }
  finally { await asr.stop(); scratch.cleanup(); }
});

it("separates conversation and analysis, resumes, and keeps retry submissions idempotent", async () => {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const deps = { now: () => new Date(), newId: randomUUID };
    const id = startConversation(db, deps, "Coffee", "tab");
    const calls: ChatMessage[][] = [];
    let analysisOutput = '{"ok":false,"feedback":"Use drank.","corrected":"I drank coffee yesterday.","grammar_skill_id":"invented-skill","original":"drink"}';
    const chat = { chat: async (request: { messages: ChatMessage[] }) => { calls.push(request.messages); return { text: request.messages[0]!.content.includes("cautious") ? analysisOutput : "What did you drink?", stats: { totalMs: 0, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } }; } };
    const run = async (action: "reply" | "analysis", messageId: string | null) => {
      const payload: ConversationPayload = { conversation: true, sessionId: id, action, messageId };
      const ctx = { job: { payload }, signal: new AbortController().signal, checkpoint: () => undefined } as unknown as RunnerContext<ConversationPayload>;
      const out = await runConversation(db, chat, ctx); out.alsoCommit?.(db);
    };
    await run("reply", null);
    const answer = randomUUID();
    submitConversation(db, deps, id, "tab", answer, "I drink coffee yesterday.");
    submitConversation(db, deps, id, "tab", answer, "I drink coffee yesterday.");
    expect((conversationState(db, id).session as { answerCount: number }).answerCount).toBe(1);
    expect(db.prepare("SELECT track, amount FROM mode_xp_events WHERE source='conversation'").all()).toEqual([{ track: 'conversation', amount: 10 }]); // one answer, one payment
    await run("analysis", answer);
    const annotation = JSON.parse((db.prepare("SELECT text FROM conversation_analyses WHERE message_id=?").get(answer) as { text: string }).text);
    expect(annotation).toMatchObject({ version: "conversation-feedback-v2", corrected: "I drank coffee yesterday.", grammarSkillId: null, status: "tentative" });
    expect((db.prepare("SELECT count(*) AS n FROM attempts").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM error_events").get() as { n: number }).n).toBe(0);
    await run("reply", answer);
    expect(calls[2]!.map(m => m.content).join(" ")).not.toContain("Use drank");
    expect(calls[1]!.map(m => m.content).join(" ")).toContain("I drink coffee yesterday.");
    const tax = db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as { id: string };
    db.prepare("INSERT INTO skills(id,created_at) VALUES ('test.past','now')").run();
    db.prepare("INSERT INTO skill_revisions(id,skill_id,taxonomy_id,label_en,domain,family,active) VALUES ('test-rev','test.past',?,'Past simple','grammar','past',1)").run(tax.id);
    db.prepare("UPDATE conversation_analyses SET status='pending' WHERE message_id=?").run(answer);
    analysisOutput = '{"ok":false,"feedback":"Use past tense.","corrected":"I drank coffee yesterday.","grammar_skill_id":"test.past","original":"drink"}';
    await run("analysis", answer);
    expect(JSON.parse((db.prepare("SELECT text FROM conversation_analyses WHERE message_id=?").get(answer) as { text: string }).text)).toMatchObject({ grammarSkillId: "test.past", original: "drink", status: "tentative" });
    expect((db.prepare("SELECT count(*) AS n FROM error_events").get() as { n: number }).n).toBe(0);
    pauseConversation(db, deps, id, "tab");
    expect(() => submitConversation(db, deps, id, "tab", randomUUID(), "No")).toThrow();
    resumeConversation(db, deps, id, "tab2");
    expect((conversationState(db, id).session as { status: string }).status).toBe("active");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); scratch.cleanup(); }
});

it("serves topic selection and session controls over the authenticated local API", async () => {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const port = await freePort();
    const config = testConfig(scratch.root, port);
    const dictation = createDictationEnv(config);
    const seeds: string[] = [], spoken: string[] = [];
    dictation.voices = { pickForConversation: (_db: unknown, o: { seed: string }) => { seeds.push(o.seed); return { id: 2 }; }, synthesisParams: () => ({ speakerId: 2, lengthScale: 1 }) } as unknown as typeof dictation.voices;
    dictation.tts = { available: () => ({ ok: true, modelSha256: "test" }), synthesize: async input => { spoken.push(input.text); return sampleWav(); }, stop: async () => undefined };
    dictation.asr = { available: () => true, transcribe: async () => ({ text: "Hello there", model: "test" }), stop: async () => undefined };
    app = await buildApp({ config, dictation, groqKey: "test", db, instanceId: "test", startedAt: new Date().toISOString(), shutdownToken: "test", onShutdown: () => undefined });
    const host = `127.0.0.1:${port}`;
    const boot = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
    const headers = { host, origin: `http://${host}`, cookie: String(boot.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": boot.json().csrfToken as string };
    const home = await app.inject({ method: "GET", url: "/api/v1/conversations", headers });
    expect(home.statusCode).toBe(200);
    const topic = home.json().topics[0] as string;
    const tabId = randomUUID();
    const started = await app.inject({ method: "POST", url: "/api/v1/conversations", headers, payload: { topic, tabId } });
    expect(started.statusCode).toBe(200);
    const id = started.json().session.id as string;
    expect(started.json().session.topic).toBe(topic);
    const messageId = randomUUID(), userMessageId = randomUUID();
    db.prepare("INSERT INTO conversation_messages(id,session_id,role,text,created_at) VALUES (?,?,'assistant','Hello there.','now'),(?,?,'user','Private answer','now')").run(messageId, id, userMessageId, id);
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: `/api/v1/conversations/${id}/speech`, headers, payload: { messageId } })).statusCode).toBe(200);
    expect(seeds).toEqual([`conversation:${topic}`, `conversation:${topic}`]);
    expect(spoken).toEqual(["Hello there."]);
    expect((await app.inject({ method: "POST", url: `/api/v1/conversations/${id}/speech`, headers, payload: { messageId: userMessageId } })).statusCode).toBe(404);
    const offlineApp = await buildApp({ config, dictation, conversationAsr: dictation.asr, db, instanceId: "offline-test", startedAt: new Date().toISOString(), shutdownToken: "test", onShutdown: () => undefined });
    try {
      const offlineBoot = await offlineApp.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
      const offlineHeaders = { host, origin: `http://${host}`, cookie: String(offlineBoot.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": offlineBoot.json().csrfToken as string };
      expect((await offlineApp.inject({ method: "POST", url: `/api/v1/conversations/${id}/speech`, headers: offlineHeaders, payload: { messageId } })).statusCode).toBe(200);
    } finally { await offlineApp.close(); }
    expect((await app.inject({ method: "POST", url: `/api/v1/conversations/${id}/pause`, headers, payload: { tabId } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/v1/conversations/${id}/resume`, headers, payload: { tabId: randomUUID() } })).statusCode).toBe(200);
    const pendingMessageId = randomUUID();
    db.prepare("INSERT INTO conversation_messages(id,session_id,role,text,created_at) VALUES (?,?,'assistant','Hello there.','now')").run(pendingMessageId, id);
    let release!: () => void, markStarted!: () => void;
    const startedChecking = new Promise<void>(resolve => { markStarted = resolve; });
    dictation.asr.transcribe = async () => { markStarted(); await new Promise<void>(resolve => { release = resolve; }); return { text: "Hello there", model: "test" }; };
    const pendingResponse = app.inject({ method: "POST", url: `/api/v1/conversations/${id}/speech`, headers, payload: { messageId: pendingMessageId } });
    await startedChecking;
    expect((await app.inject({ method: "POST", url: `/api/v1/conversations/${id}/delete-history`, headers, payload: {} })).statusCode).toBe(200);
    release();
    expect((await pendingResponse).statusCode).toBe(502);
    expect((await app.inject({ method: "POST", url: `/api/v1/conversations/${id}/speech`, headers, payload: { messageId } })).statusCode).toBe(404);
  } finally { await app?.close(); db.close(); scratch.cleanup(); }
});

it("voice requires the active conversation tab and releases the GPU", async () => {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  const calls: string[] = [];
  const stt = new SttService({ db, deps: { now: () => new Date(), newId: randomUUID }, scheduler: { beginPractice: async () => { calls.push("grant"); return { ready: true, reason: null, elapsedMs: 0 }; }, endPractice: () => { calls.push("release"); } }, available: () => true, createWorker: () => ({ worker: { alive: true, start: async () => ({ device: "cuda", model: "test" }), transcribe: async () => ({ text: "hello", audioSeconds: 1, decodeSeconds: 0.1 }), stop: async () => undefined } as never, modelPath: "test" }) });
  try {
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const id = startConversation(db, { now: () => new Date(), newId: randomUUID }, "Coffee", "tab");
    await expect(stt.start(id, "other", "conversation")).rejects.toMatchObject({ code: "LEASE_REQUIRED" });
    const stream = await stt.start(id, "tab", "conversation");
    await stt.stop(stream.streamId);
    expect(calls).toEqual(["grant", "release"]);
  } finally { await stt.shutdown(); db.close(); scratch.cleanup(); }
});

it("keeps topic voices stable and favours the user's preferred enabled voices", async () => {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const service = new VoiceService();
    const choice = () => service.pickForConversation(db, { purpose: "listening", seed: "conversation:Famous buildings", topicGroup: "buildings" });
    expect(["banjo", "matilda", "flynn", "kirra"]).toContain(choice()?.name);
    expect(choice()?.key).toBe(choice()?.key);
    for (const v of service.active(db, { purpose: "listening" })) if (v.priorWeight >= 0.85) service.updateSettings(db, v.key, { enabled: false });
    expect(choice()?.enabled).toBe(true);
    expect(choice()?.priorWeight).toBeGreaterThanOrEqual(0.5);
  } finally { db.close(); scratch.cleanup(); }
});
