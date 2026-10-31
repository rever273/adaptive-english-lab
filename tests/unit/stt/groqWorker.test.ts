import { describe, expect, it, vi } from "vitest";
import { GroqWorker } from "../../../apps/server/src/adapters/stt/groqWorker.js";

describe("Groq speech adapter", () => {
  it("sends an in-memory WAV with English parameters and returns text", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      expect(form.get("model")).toBe("whisper-large-v3");
      expect(form.get("language")).toBe("en");
      const file = form.get("file") as File;
      const wav = Buffer.from(await file.arrayBuffer());
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(16000);
      expect(wav.length).toBe(32044);
      return new Response(JSON.stringify({ text: "Hello there." }), { status: 200 });
    });
    const worker = new GroqWorker("test-key", request as typeof fetch);
    await worker.start();
    expect(await worker.transcribe(Buffer.alloc(32000))).toMatchObject({ text: "Hello there.", audioSeconds: 1 });
    await worker.stop();
  });
  it("does not leak provider error bodies or credentials", async () => {
    const worker = new GroqWorker("test-key", vi.fn(async () => new Response("secret provider details", { status: 401 })) as typeof fetch);
    await worker.start();
    await expect(worker.transcribe(Buffer.alloc(32000))).rejects.toMatchObject({ code: "authentication_failed", message: "Groq transcription failed" });
    await worker.stop();
  });
});
