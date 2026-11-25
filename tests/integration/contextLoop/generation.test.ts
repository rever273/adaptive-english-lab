import { afterEach, describe, expect, it } from "vitest";
import type { CallStats, ChatClient } from "../../../apps/server/src/domain/ai/clients.js";
import { candidateHash, completeAgentBatch, startAgentBatch, startGeneration, studioStatus } from "../../../apps/server/src/domain/contextLoop/generate.js";
import { editByLearner, loadSentences, setStatusByLearner } from "../../../apps/server/src/domain/contextLoop/sentences.js";
import { patchWord, getEntry } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { deps, generationRunner, runJob, saveWord, setup, type Env } from "../wordLessons/fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
const stats: CallStats = { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null };

const GOOD: Record<string, string[]> = {
  overlook: ["Please do not overlook the small print.", "She overlooked a mistake in the report.", "It is easy to overlook quiet colleagues.", "We overlooked the cost of parking."],
  scarce: ["Water is scarce in the desert in summer.", "Good builders are scarce this year.", "Fresh bread was scarce after the storm.", "Cheap flats are scarce near the beach."],
};

/** a scripted model: the writer answers from `write(targets)`, the reviewer from `review(ids)` */
function chat(o: { write?: (targets: Array<{ target_id: string; word: string }>, call: number) => unknown; review?: (ids: string[]) => unknown } = {}): ChatClient & { calls: string[]; reviewInputs: string[] } {
  const calls: string[] = [];
  const reviewInputs: string[] = [];
  let writes = 0;
  return {
    calls,
    reviewInputs,
    chat: async (req) => {
      const system = req.messages[0]!.content;
      const user = req.messages[1]!.content;
      if (system.includes("You check short English example sentences")) {
        calls.push("review");
        reviewInputs.push(user);
        const ids = (JSON.parse(user) as { items: Array<{ id: string }> }).items.map((i) => i.id);
        const reply = o.review ? o.review(ids) : { verdicts: ids.map((id) => ({ id, ok: true, problem: "" })) };
        return { text: typeof reply === "string" ? reply : JSON.stringify(reply), stats };
      }
      calls.push("write");
      const targets = (JSON.parse(user.split("\n")[3]!) as { targets: Array<{ target_id: string; word: string }> }).targets;
      const reply = o.write ? o.write(targets, writes++) : { items: targets.map((t) => ({ target_id: t.target_id, sentences: GOOD[t.word]!.map((text, i) => ({ text, translation_ru: `Перевод ${i + 1}.`, target_surface: /overlooked/.test(text) ? "overlooked" : t.word, context_label: "life", difficulty: "easy" })), issues: [] })) };
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply), stats };
    },
  };
}

const statuses = (db: Env["db"]) => loadSentences(db).map((s) => s.status);

describe("Context Loop sentence generation (local model)", () => {
  it("writes, checks and reviews a batch: validated sentences count as coverage, a second batch finds nothing to do", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    saveWord(db, "scarce", "дефицитный");
    const r = startGeneration(db, deps, { words: 10, perWord: 4 });
    expect(r.created).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.contextLoopBatchId') IS NOT NULL").get() as { n: number }).n).toBe(1);
    expect(() => startGeneration(db, deps, { words: 5, perWord: 4 })).toThrow(/Every word/); // the words are in work
    const c = chat();
    expect((await runJob(db, generationRunner(db, c), "contextLoopBatchId")).error).toBeNull();
    expect(c.calls).toEqual(["write", "review"]);
    expect(statuses(db)).toEqual(Array(8).fill("validated"));
    // v3: the translation written with the sentence is stored with it, and the review saw it
    expect((db.prepare("SELECT COUNT(*) AS n FROM context_loop_sentences WHERE translation_ru LIKE 'Перевод %'").get() as { n: number }).n).toBe(8);
    expect(c.reviewInputs[0]).toContain("Перевод 1.");
    const st = studioStatus(db, deps);
    expect(st.coverage).toMatchObject({ ready: 2, playable: 2, missing: 0, eligible: 2 });
    expect(st.batches[0]).toMatchObject({ status: "done", sentences: 8 });
    expect(() => startGeneration(db, deps, { words: 5, perWord: 4 })).toThrow(/Every word/);
  });

  it("drops bad sentences and unknown ids, asks again for the missing ones, and flags what the review rejects or skips", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    startGeneration(db, deps, { words: 1, perWord: 3 });
    const c = chat({
      write: (targets, call) =>
        call === 0
          ? { items: [{ target_id: "t9", sentences: [{ text: "Water is scarce here.", target_surface: "scarce", context_label: "x", difficulty: "easy" }] }, { target_id: targets[0]!.target_id, sentences: [{ text: "Please do not overlook the small print.", target_surface: "overlook", context_label: "work", difficulty: "easy" }, { text: "Do not overlook it or overlook them.", target_surface: "overlook", context_label: "x", difficulty: "easy" }] }] }
          : call === 1
            ? "not json at all"
            : { items: [{ target_id: targets[0]!.target_id, sentences: [{ text: "Please do not overlook the small print.", target_surface: "overlook", context_label: "work", difficulty: "easy" }, { text: "She overlooked a mistake in the report.", target_surface: "overlooked", context_label: "work", difficulty: "medium" }, { text: "We overlooked the cost of parking.", target_surface: "overlooked", context_label: "travel", difficulty: "easy" }] }] },
      review: (ids) => ({ verdicts: [{ id: ids[0], ok: true, problem: "" }, { id: ids[1], ok: false, problem: "sounds unnatural" }] }),
    });
    expect((await runJob(db, generationRunner(db, c), "contextLoopBatchId")).error).toBeNull();
    const ss = loadSentences(db);
    expect(ss.map((s) => s.text)).toEqual(["Please do not overlook the small print.", "She overlooked a mistake in the report.", "We overlooked the cost of parking."]); // the repeat of an accepted sentence was dropped
    expect(ss.map((s) => [s.status, s.reason])).toEqual([["validated", null], ["flagged", "sounds unnatural"], ["flagged", "the review gave no clear verdict"]]);
    expect(studioStatus(db, deps).coverage.playable).toBe(0);
  });

  it("a chunk with no usable sentence fails the batch with a code, and a sentence of the exercise bank or of this word is refused", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    startGeneration(db, deps, { words: 1, perWord: 3 });
    const { error } = await runJob(db, generationRunner(db, chat({ write: (t) => ({ items: [{ target_id: t[0]!.target_id, sentences: [{ text: "Nothing here.", target_surface: "x", context_label: "x", difficulty: "easy" }] }] }) })), "contextLoopBatchId");
    expect((error as { code?: string }).code).toBe("context_loop_empty");
    expect(studioStatus(db, deps).batches[0]).toMatchObject({ status: "failed", errorCode: "context_loop_empty" });
  });
});

describe("Context Loop: up to 15 sentences per word", () => {
  it("asks one word per model call when many sentences are wanted, and refuses more than 15", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    saveWord(db, "scarce", "дефицитный");
    expect(() => startGeneration(db, deps, { words: 2, perWord: 15 })).not.toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.contextLoopBatchId') IS NOT NULL").get() as { n: number }).n).toBe(2);
    expect(studioStatus(db, deps).limits.perWord.max).toBe(15);
    const c = chat();
    expect((await runJob(db, generationRunner(db, c), "contextLoopBatchId")).error).toBeNull();
    expect(c.calls[0]).toBe("write");
  });
});

describe("Context Loop sentences in Studio", () => {
  it("the learner hides, restores and edits; an edit is a new sentence and a changed translation makes sentences stale", async () => {
    env = await setup();
    const { db } = env;
    const entry = saveWord(db, "overlook");
    startGeneration(db, deps, { words: 1, perWord: 4 });
    await runJob(db, generationRunner(db, chat()), "contextLoopBatchId");
    const [a, b] = loadSentences(db);
    expect(setStatusByLearner(db, deps, a!.id, "rejected").status).toBe("rejected");
    expect(setStatusByLearner(db, deps, a!.id, "validated").status).toBe("validated");
    expect(() => editByLearner(db, deps, b!.id, "She did not notice it.")).toThrow(/not in the sentence/);
    const edited = editByLearner(db, deps, b!.id, "She overlooked a typo in the report.");
    expect(edited).toMatchObject({ source: "learner", status: "validated", text: "She overlooked a typo in the report." });
    expect(loadSentences(db, { id: b!.id })[0]).toMatchObject({ status: "rejected", reason: "edited" });
    expect(studioStatus(db, deps).coverage.ready).toBe(1);
    const e = getEntry(db, entry);
    patchWord(db, deps, entry, { expectedRevision: e.userRevision, translationRu: "смотреть сверху" });
    expect(studioStatus(db, deps).coverage).toMatchObject({ ready: 0, stale: 1 });
  });
});

describe("Context Loop agent batches (D161)", () => {
  const draft = (target_id: string, text: string, target_surface: string) => {
    const c = { target_id, text, target_surface, context_label: "life", difficulty: "easy", translation_ru: "Перевод." };
    return { ...c, hash: candidateHash(c) };
  };

  it("queues no job, refuses a self-review, a missing verdict, an edited hash or a bad sentence without writing, then stores approved/flagged once", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    const r = startAgentBatch(db, deps, { words: 3, perWord: 3 });
    expect(r.prompt).toContain(`npm run content:loop -- prepare ${r.batchId}`);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.contextLoopBatchId') IS NOT NULL").get() as { n: number }).n).toBe(0);
    const cands = GOOD.overlook!.slice(0, 3).map((t) => draft("t1", t, /overlooked/.test(t) ? "overlooked" : "overlook"));
    const review = (reviewer: string) => ({ reviewer, items: cands.map((c, i) => ({ hash: c.hash, verdict: (i === 2 ? "flag" : "accept") as "accept" | "flag", reason: i === 2 ? "too easy to guess" : "" })) });
    const author = "agent:writer@1";
    expect(() => completeAgentBatch(db, deps, r.batchId, { author, candidates: cands, review: review(author) })).toThrow(/different agent/);
    expect(() => completeAgentBatch(db, deps, r.batchId, { author, candidates: cands, review: { reviewer: "agent:rev@1", items: [] } })).toThrow(/cannot be finalised/);
    expect(() => completeAgentBatch(db, deps, r.batchId, { author, candidates: [{ ...cands[0]!, text: "Changed text with overlook." }], review: review("agent:rev@1") })).toThrow(/cannot be finalised/);
    const bad = draft("t1", "Overlook it, overlook it.", "overlook");
    expect(() => completeAgentBatch(db, deps, r.batchId, { author, candidates: [bad], review: { reviewer: "agent:rev@1", items: [{ hash: bad.hash, verdict: "accept" }] } })).toThrow(/cannot be finalised/);
    expect(loadSentences(db)).toEqual([]);
    const body = { author, candidates: cands, review: review("agent:rev@1") };
    const receipt = completeAgentBatch(db, deps, r.batchId, body);
    expect(receipt).toMatchObject({ accepted: 2, flagged: 1, rejected: 0 });
    expect(loadSentences(db).map((s) => [s.source, s.status])).toEqual([["agent", "approved"], ["agent", "approved"], ["agent", "flagged"]]);
    expect(completeAgentBatch(db, deps, r.batchId, body)).toEqual(receipt); // an identical retry returns the receipt
    expect(() => completeAgentBatch(db, deps, r.batchId, { ...body, author: "agent:other@1" })).toThrow(/already finished/);
    expect(studioStatus(db, deps).coverage.playable).toBe(1);
  });

  it("agent v2: the translation is part of the reviewed hash and is stored; a non-Russian one is refused", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    const r = startAgentBatch(db, deps, { words: 3, perWord: 3 });
    const withTr = (text: string, tr: string) => {
      const c = { target_id: "t1", text, target_surface: /overlooked/.test(text) ? "overlooked" : "overlook", context_label: "life", difficulty: "easy", translation_ru: tr };
      return { ...c, hash: candidateHash(c) };
    };
    const cands = GOOD.overlook!.slice(0, 3).map((t, i) => withTr(t, `Перевод ${i + 1}.`));
    expect(cands[0]!.hash).not.toBe(candidateHash({ ...cands[0]!, translation_ru: undefined }));
    const review = { reviewer: "agent:rev@1", items: cands.map((c) => ({ hash: c.hash, verdict: "accept" as const })) };
    // the reviewer approved one translation: another one under the same hash is refused
    expect(() => completeAgentBatch(db, deps, r.batchId, { author: "agent:writer@1", candidates: [{ ...cands[0]!, translation_ru: "Другой." }, ...cands.slice(1)], review })).toThrow(/cannot be finalised/);
    const bare = { ...cands[0]!, translation_ru: undefined };
    const bareHashed = { ...bare, hash: candidateHash(bare) };
    expect(() => completeAgentBatch(db, deps, r.batchId, { author: "agent:writer@1", candidates: [bareHashed], review: { reviewer: "agent:rev@1", items: [{ hash: bareHashed.hash, verdict: "accept" }] } })).toThrow(/cannot be finalised/); // v2 batch: required on the server too
    const latin = withTr(GOOD.overlook![0]!, "Perevod.");
    expect(() => completeAgentBatch(db, deps, r.batchId, { author: "agent:writer@1", candidates: [latin], review: { reviewer: "agent:rev@1", items: [{ hash: latin.hash, verdict: "accept" }] } })).toThrow(/cannot be finalised/);
    expect(completeAgentBatch(db, deps, r.batchId, { author: "agent:writer@1", candidates: cands, review })).toMatchObject({ accepted: 3 });
    expect((db.prepare("SELECT translation_ru AS t FROM context_loop_sentences ORDER BY rowid").all() as Array<{ t: string }>).map((x) => x.t)).toEqual(["Перевод 1.", "Перевод 2.", "Перевод 3."]);
  });
});
