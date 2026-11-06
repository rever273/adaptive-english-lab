import { describe, expect, it } from "vitest";
import type { Voice } from "../../../apps/server/src/domain/voices/catalog.js";
import { alternativeVoice, pickVoice, planVoiceList, voiceSuits, type Weighted } from "../../../apps/server/src/domain/voices/select.js";

const voice = (id: number, name: string, gender: "male" | "female", older = false): Voice => ({
  key: `piper:m:${id}`, id, name, gender, ageGroup: older ? "elderly" : "adult", impression: null, enabled: true, purposes: ["dictation", "books", "listening"],
  avoidGroups: older ? ["tech", "gaming", "crypto"] : [], lengthScale: 1.1, noiseScale: null, noiseWScale: null, maxSpeedUp: 0.2, priorWeight: 1, revision: 1, source: "seed",
});
const cand = (v: Voice, weight = 1): Weighted => ({ voice: v, weight });

const VOICES = [voice(1, "bindi", "female", true), voice(2, "marlo", "female"), voice(4, "angus", "male", true), voice(5, "banjo", "male"), voice(9, "willow", "female", true)];

describe("voice selection", () => {
  it("does not give older voices software or game topics, but uses them for the rest", () => {
    const groups = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? "tech" : "nature"));
    const plan = planVoiceList(VOICES.map((v) => cand(v)), 40, 11, groups);
    plan.forEach((v, i) => {
      if (groups[i] === "tech") expect(["marlo", "banjo"]).toContain(v.name);
    });
    expect(plan.some((v, i) => groups[i] === "nature" && v.ageGroup === "elderly")).toBe(true);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.key).not.toBe(plan[i - 1]!.key);
    expect(voiceSuits(VOICES[0]!, "gaming")).toBe(false);
    expect(voiceSuits(VOICES[1]!, "gaming")).toBe(true);
  });

  it("rotates without neighbours repeating and with both genders, deterministically for a seed", () => {
    const six = Array.from({ length: 6 }, (_, i) => voice(i, `v${i}`, i < 5 ? "female" : "male"));
    const plan = planVoiceList(six.map((v) => cand(v)), 12, 3);
    expect(plan).toHaveLength(12);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.key).not.toBe(plan[i - 1]!.key);
    expect(plan.some((v) => v.gender === "male")).toBe(true);
    expect(planVoiceList(six.map((v) => cand(v)), 12, 3).map((v) => v.key)).toEqual(plan.map((v) => v.key));
  });

  it("a voice with a small weight is used less, a voice with weight 0 never", () => {
    const list = [cand(voice(1, "low", "female"), 0.15), cand(voice(2, "high", "female"), 1), cand(voice(3, "off", "male"), 0), cand(voice(4, "mid", "male"), 0.6)];
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 3000; seed++) {
      const v = pickVoice(list, { seed })!;
      counts.set(v.name, (counts.get(v.name) ?? 0) + 1);
    }
    expect(counts.get("off")).toBeUndefined();
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(counts.get("low")! / total).toBeGreaterThan(0.04);
    expect(counts.get("low")! / total).toBeLessThan(0.14); // 0.15 / 1.75 = 8.6%
    expect(counts.get("high")!).toBeGreaterThan(counts.get("mid")!);
  });

  it("the small weights are not flattened away in a short plan", () => {
    const list = [cand(voice(1, "low", "female"), 0.15), cand(voice(2, "a", "female"), 1), cand(voice(3, "b", "male"), 1), cand(voice(4, "c", "male"), 1)];
    let low = 0;
    let all = 0;
    for (let seed = 0; seed < 400; seed++) for (const v of planVoiceList(list, 5, seed)) {
      all++;
      if (v.name === "low") low++;
    }
    expect(low / all).toBeLessThan(0.1);
  });

  it("fills the missing gender by weight, not with the first voice by number", () => {
    const list = [cand(voice(1, "w1", "female")), cand(voice(2, "w2", "female")), cand(voice(10, "m-low", "male"), 0.15), cand(voice(11, "m-high", "male"), 1)];
    const picked = new Map<string, number>();
    for (let seed = 0; seed < 600; seed++) {
      const plan = planVoiceList(list, 2, seed).filter((v) => v.gender === "male");
      for (const v of plan) picked.set(v.name, (picked.get(v.name) ?? 0) + 1);
    }
    expect(picked.get("m-high")!).toBeGreaterThan(picked.get("m-low") ?? 0);
  });

  it("an alternative voice is another one, drawn by weight, and never one that failed", () => {
    const list = [cand(voice(1, "a", "female"), 1), cand(voice(2, "b", "female"), 1), cand(voice(3, "c", "male"), 0.15)];
    for (let seed = 0; seed < 100; seed++) expect(alternativeVoice(list, { failed: ["piper:m:1"], seed })!.key).not.toBe("piper:m:1");
    expect(alternativeVoice(list, { failed: ["piper:m:1", "piper:m:2", "piper:m:3"], seed: 1 })).toBeNull();
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 1000; seed++) {
      const v = alternativeVoice(list, { failed: ["piper:m:1"], seed })!;
      counts.set(v.name, (counts.get(v.name) ?? 0) + 1);
    }
    expect(counts.get("b")!).toBeGreaterThan(counts.get("c")! * 3);
  });

  it("an elderly voice still answers when it is the only one left for a software topic", () => {
    const only = [cand(voice(1, "old", "female", true))];
    expect(pickVoice(only, { seed: 1, topicGroup: "tech" })!.name).toBe("old");
  });
});
