import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, sttAudio, sttStart, sttStop } from "./api";

/**
 * Browser side of voice input (TASK_011). Audio is captured into memory only, converted to 16 kHz mono 16-bit PCM, sent once and dropped.
 * Nothing is written to disk, localStorage or IndexedDB. The server answers with TEXT; the learner reads and may edit it before anything is
 * submitted. If the microphone, the card or the model is not available the page says so and typing keeps working.
 */
export const TARGET_RATE = 16000;
export const AUTO_STOP_SECONDS = 20; // a short sentence; the server accepts up to 60 s

export type VoiceState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "recording"; seconds: number }
  | { phase: "transcribing" }
  | { phase: "draft"; draftId: string; text: string }
  | { phase: "unavailable"; message: string };

/** linear resampling of float samples to 16 kHz int16 */
export function toPcm16k(chunks: Float32Array[], sourceRate: number): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const src = new Float32Array(total);
  let o = 0;
  for (const c of chunks) (src.set(c, o), (o += c.length));
  const ratio = sourceRate / TARGET_RATE;
  const n = Math.floor(src.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const v = (src[i0] ?? 0) * (1 - frac) + (src[Math.min(i0 + 1, src.length - 1)] ?? 0) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

interface Capture {
  stop: () => Promise<Int16Array>;
}
async function startCapture(onTick: (seconds: number) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let ctx: AudioContext | undefined;
  try {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/voice-tap.js"); // same-origin file: the CSP forbids blob: scripts
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    await ctx?.close().catch(() => undefined);
    throw e;
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "tap");
  const chunks: Float32Array[] = [];
  let samples = 0;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    chunks.push(e.data);
    samples += e.data.length;
    onTick(samples / ctx.sampleRate);
  };
  src.connect(node);
  return {
    stop: async () => {
      src.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop()); // the microphone light goes off
      const rate = ctx.sampleRate;
      await ctx.close();
      return toPcm16k(chunks, rate);
    },
  };
}

export interface VoiceController {
  state: VoiceState;
  /** the open server-side voice session, once started */
  readonly streamId: string | null;
  record: () => Promise<void>;
  stopRecording: () => Promise<void>;
  /** discard the draft and go back to typing */
  clear: () => void;
}

const friendly = (e: unknown): string => {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "NotFoundError")) return "The microphone is not available. You can type your answer.";
  return "Voice is not available right now. You can type your answer.";
};

export function useVoice(sessionId: string | null, tabId: string, enabled: boolean): VoiceController {
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const stream = useRef<string | null>(null);
  const capture = useRef<Capture | null>(null);
  const generation = useRef(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const release = useCallback(() => {
    generation.current++;
    const cap = capture.current;
    capture.current = null;
    if (cap) void cap.stop().catch(() => undefined);
    const id = stream.current;
    stream.current = null;
    if (id) void sttStop(id).catch(() => undefined);
  }, []);
  useEffect(() => () => release(), [release, sessionId]);
  useEffect(() => {
    const onHide = () => release();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [release]);

  const finish = useCallback(async () => {
    const cap = capture.current;
    capture.current = null;
    if (!cap) return;
    const id = stream.current;
    const current = generation.current;
    setState({ phase: "transcribing" });
    try {
      const pcm = await cap.stop();
      if (!id || current !== generation.current) return;
      const r = await sttAudio(id, pcm);
      if (current !== generation.current) return;
      setState({ phase: "draft", draftId: r.draftId, text: r.text });
    } catch (e) {
      if (current !== generation.current) return;
      release();
      setState({ phase: "unavailable", message: friendly(e) });
    }
  }, [release]);

  const record = useCallback(async () => {
    if (!enabled || !sessionRef.current) return;
    const current = generation.current;
    setState({ phase: "preparing" });
    try {
      if (!stream.current) {
        const id = (await sttStart(sessionRef.current, tabId)).streamId;
        if (current !== generation.current) {
          void sttStop(id).catch(() => undefined);
          return;
        }
        stream.current = id;
      }
      const cap = await startCapture((seconds) => {
        if (current !== generation.current) return;
        setState({ phase: "recording", seconds });
        if (seconds >= AUTO_STOP_SECONDS) void finish();
      });
      if (current !== generation.current) {
        await cap.stop();
        return;
      }
      capture.current = cap;
      setState({ phase: "recording", seconds: 0 });
    } catch (e) {
      if (current !== generation.current) return;
      capture.current = null;
      release();
      setState({ phase: "unavailable", message: friendly(e) });
    }
  }, [enabled, tabId, finish, release]);

  return {
    state,
    get streamId() {
      return stream.current;
    },
    record,
    stopRecording: finish,
    clear: () => setState({ phase: "idle" }),
  };
}
