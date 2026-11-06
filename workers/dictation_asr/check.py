"""English Lab dictation ASR check (TASK_028, D97).

Transcribes SYNTHESISED dictation audio with local faster-whisper large-v3, so that a sentence only reaches a lesson when it can be
understood. (Never used for the learner's voice; that is workers/stt.) Protocol over stdin/stdout, one JSON line each way:
  worker -> parent : {"event": "ready", "model": ..., "device": ..., "loadSeconds": ...}
  parent -> worker : {"id": ..., "wav": "<base64 WAV>"}   |   {"op": "shutdown"}
  worker -> parent : {"id": ..., "ok": true, "text": ..., "seconds": ...}   |   {"id": ..., "ok": false, "error": ...}
Weights come from the local Hugging Face cache only; nothing is downloaded.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
from pathlib import Path


def find_model() -> str | None:
    explicit = os.environ.get("ENGLISHLAB_DICTATION_ASR_MODEL_PATH")
    if explicit:
        return explicit if (Path(explicit) / "model.bin").exists() else None
    hf = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
    snaps = hf / "hub" / "models--Systran--faster-whisper-large-v3" / "snapshots"
    if snaps.exists():
        for snap in sorted(snaps.iterdir()):
            if (snap / "model.bin").exists():
                return str(snap)
    return None


def say(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="int8_float16")
    args = parser.parse_args()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    model_path = args.model_path or find_model()
    if not model_path:
        say({"event": "error", "error": "no_local_large_v3_model"})
        return 2
    from faster_whisper import WhisperModel

    t0 = time.perf_counter()
    model = WhisperModel(model_path, device=args.device, compute_type=args.compute_type, local_files_only=True)
    say({"event": "ready", "model": "faster-whisper-large-v3", "device": args.device, "computeType": args.compute_type, "loadSeconds": round(time.perf_counter() - t0, 2)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if req.get("op") == "shutdown":
            return 0
        rid = req.get("id")
        try:
            t1 = time.perf_counter()
            words = bool(req.get("words"))  # the voice evaluation (TASK_029) also wants how sure the model was of each word
            segments, _ = model.transcribe(
                io.BytesIO(base64.b64decode(req["wav"])),
                language="en",
                beam_size=5,
                vad_filter=False,
                condition_on_previous_text=False,
                temperature=0.0,
                word_timestamps=words,
            )
            segs = list(segments)
            text = " ".join(s.text.strip() for s in segs).strip()
            reply = {"id": rid, "ok": True, "text": text, "seconds": round(time.perf_counter() - t1, 3)}
            if words:
                probs = [w.probability for s in segs for w in (s.words or [])]
                if probs:
                    reply["minWordProb"] = round(min(probs), 4)
                    reply["meanWordProb"] = round(sum(probs) / len(probs), 4)
                if segs:
                    reply["avgLogprob"] = round(sum(s.avg_logprob for s in segs) / len(segs), 4)
            say(reply)
        except Exception as e:  # noqa: BLE001 - reported to the parent, which decides
            say({"id": rid, "ok": False, "error": str(e)[:300]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
