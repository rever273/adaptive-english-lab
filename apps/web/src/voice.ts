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
  /** level: loudness of the last audio chunk, 0..1, so the learner can see the microphone hears them */
  | { phase: "recording"; seconds: number; level: number }
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
async function startCapture(onTick: (seconds: number, level: number) => void): Promise<Capture> {
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
    let sum = 0;
    for (let i = 0; i < e.data.length; i++) sum += e.data[i]! * e.data[i]!;
    // RMS mapped so that normal speech fills most of the meter
    onTick(samples / ctx.sampleRate, Math.min(1, Math.sqrt(sum / Math.max(1, e.data.length)) * 6));
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
  provider: "groq" | "local" | null;
  /** the open server-side voice session, once started */
  readonly streamId: string | null;
  record: () => Promise<void>;
  stopRecording: () => Promise<void>;
  /** hold-to-talk (key M): press starts a fresh recording, release stops it and starts the transcription; a new press rewrites the text */
  holdStart: () => void;
  holdEnd: () => void;
  /** start speech recognition in the background (a voice task is on screen), so recording starts at once */
  prepare: () => void;
  /** discard the draft and go back to typing */
  clear: () => void;
}

/** the card may still be busy with a background model for a few seconds: these answers mean "wait", not "failed" */
const WAIT_CODES = new Set(["STT_PREPARING", "STT_BUSY"]);
const WAIT_LIMIT_MS = 60_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const friendly = (e: unknown): string => {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "NotFoundError")) return "The microphone is not available. You can type your answer.";
  return "Voice is not available right now. You can type your answer.";
};

export function useVoice(sessionId: string | null, tabId: string, enabled: boolean): VoiceController {
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const [provider, setProvider] = useState<"groq" | "local" | null>(null);
  const stream = useRef<string | null>(null);
  const capture = useRef<Capture | null>(null);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** the key was released before the microphone was ready: stop as soon as it is */
  const released = useRef(false);
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
      if (pcm.length < TARGET_RATE * 0.35) {
        setState({ phase: "unavailable", message: "That was too short. Hold the key (or the button) while you speak, then let go." });
        return;
      }
      const r = await sttAudio(id, pcm);
      if (current !== generation.current) return;
      setState({ phase: "draft", draftId: r.draftId, text: r.text });
    } catch (e) {
      if (current !== generation.current) return;
      release();
      setState({ phase: "unavailable", message: friendly(e) });
    }
  }, [release]);

  /** opens the server-side voice session, waiting (not failing) while the card is still being freed */
  const opening = useRef<Promise<void> | null>(null);
  const open = useCallback(async (current: number) => {
    if (stream.current) return;
    if (opening.current) return opening.current;
    opening.current = (async () => {
      const deadline = Date.now() + WAIT_LIMIT_MS;
      for (;;) {
        try {
          const started = await sttStart(sessionRef.current!, tabId);
          const id = started.streamId;
          if (current !== generation.current) {
            void sttStop(id).catch(() => undefined);
            return;
          }
          stream.current = id;
          setProvider(started.ready.device === "groq" ? "groq" : "local");
          return;
        } catch (e) {
          if (!(e instanceof ApiRequestError && WAIT_CODES.has(e.code)) || Date.now() > deadline || current !== generation.current) throw e;
          await pause(1500);
        }
      }
    })().finally(() => {
      opening.current = null;
    });
    return opening.current;
  }, [tabId]);

  const prepare = useCallback(() => {
    if (!enabled || !sessionRef.current || stream.current) return;
    void open(generation.current).catch(() => undefined); // a failure shows when the learner presses the button
  }, [enabled, open]);

  const record = useCallback(async () => {
    if (!enabled || !sessionRef.current) return;
    const current = generation.current;
    released.current = false; // a key released before this point is recorded by holdEnd after the call
    setState({ phase: "preparing" });
    try {
      await open(current);
      if (current !== generation.current || !stream.current) return;
      const cap = await startCapture((seconds, level) => {
        if (current !== generation.current) return;
        setState({ phase: "recording", seconds, level });
        if (seconds >= AUTO_STOP_SECONDS) void finish();
      });
      if (current !== generation.current) {
        await cap.stop();
        return;
      }
      capture.current = cap;
      setState({ phase: "recording", seconds: 0, level: 0 });
      if (released.current) void finish(); // let go while the microphone was starting
    } catch (e) {
      if (current !== generation.current) return;
      capture.current = null;
      release();
      setState({ phase: "unavailable", message: friendly(e) });
    }
  }, [enabled, open, finish, release]);

  return {
    state,
    provider,
    get streamId() {
      return stream.current;
    },
    record,
    holdStart: () => {
      const phase = stateRef.current.phase;
      if (phase === "preparing" || phase === "recording" || phase === "transcribing") return; // one recording at a time
      void record();
    },
    holdEnd: () => {
      released.current = true;
      if (capture.current) void finish();
    },
    stopRecording: finish,
    prepare,
    clear: () => setState({ phase: "idle" }),
  };
}
