import { useEffect, useRef, useState } from "react";
import type { AiModelStatus } from "@english-lab/contracts";
import { fetchAiModel } from "../api";

/** plain-English reasons for the codes the server reports */
export const MODEL_ERROR_TEXT: Record<string, string> = {
  model_server_unreachable: "the local model server (Ollama) is not reachable",
  insufficient_vram: "not enough free graphics memory",
  model_not_resident_after_load: "the model did not stay in memory after loading",
  unload_not_confirmed: "the model is still in memory after the unload request",
  load_aborted: "the load was stopped",
};
export const modelErrorText = (code: string | null): string => (code ? (MODEL_ERROR_TEXT[code] ?? code) : "unknown reason");

const FAST_MS = 1500;
const SLOW_MS = 10_000;
const READY_SHOWN_MS = 3000;

/**
 * Bottom-right, non-blocking: tells the learner that the local model is warming up (the first load takes about 40 seconds), flashes
 * "ready" briefly and shows a failure with its reason. It polls quickly only while the model is loading/unloading, otherwise slowly.
 */
export function AiModelNotice() {
  const [s, setS] = useState<AiModelStatus | null>(null);
  const [readyFlash, setReadyFlash] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const prev = useRef<AiModelStatus["state"] | null>(null);

  useEffect(() => {
    let off = false;
    let timer: number | undefined;
    const tick = async () => {
      let next: AiModelStatus | null = null;
      try {
        next = await fetchAiModel();
      } catch {
        next = null;
      }
      if (off) return;
      if (next) {
        if (prev.current === "loading" && next.state === "ready") {
          setReadyFlash(true);
          window.setTimeout(() => !off && setReadyFlash(false), READY_SHOWN_MS);
        }
        prev.current = next.state;
        setS(next);
      }
      const fast = next !== null && (next.state === "loading" || next.state === "unloading");
      timer = window.setTimeout(() => void tick(), fast ? FAST_MS : SLOW_MS);
    };
    void tick();
    return () => {
      off = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (!s) return null;
  if (s.state === "loading") {
    return (
      <div className="model-notice" role="status" data-testid="model-notice">
        <i className="pi pi-spin pi-spinner" aria-hidden="true" /> Loading the AI model - the first load takes about 40 seconds
      </div>
    );
  }
  if (s.state === "error" && s.error !== dismissedError) {
    return (
      <div className="model-notice model-notice-error" role="status" data-testid="model-notice">
        <i className="pi pi-exclamation-triangle" aria-hidden="true" /> AI model problem: {modelErrorText(s.error)}.
        <button type="button" className="icon-btn" onClick={() => setDismissedError(s.error)} aria-label="Dismiss"><i className="pi pi-times" aria-hidden="true" /></button>
      </div>
    );
  }
  if (readyFlash && s.state === "ready") {
    return (
      <div className="model-notice model-notice-ready" role="status" data-testid="model-notice">
        <i className="pi pi-check" aria-hidden="true" /> AI model ready
      </div>
    );
  }
  return null;
}
