"""English Lab local STT worker (TASK_011).

Owns ONLY speech-to-text inference. Talks to its parent over stdin/stdout:
  parent -> worker : one JSON line  {"op": "...", ...}  optionally followed by exactly `bytes` raw bytes of PCM
  worker -> parent : one JSON line per answer (stdout carries nothing else)
Audio lives in memory only: this module never opens a file for writing, never creates temp files and never logs audio.
Weights are loaded from a local directory only (local_files_only); nothing is downloaded.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

PROTOCOL = 1
SAMPLE_RATE = 16000
MAX_BYTES = 2 * 1024 * 1024  # 2 MiB, about 65 s of 16 kHz mono int16
MIN_BYTES = 3200  # 0.1 s


class Backend:
    """Wraps faster-whisper. Replaced by a stub in tests."""

    def __init__(self, model_path: str, device: str, compute_type: str, language: str) -> None:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        from faster_whisper import WhisperModel  # imported late: --help and the tests do not need CUDA

        self.language = language
        t0 = time.perf_counter()
        self.model = WhisperModel(model_path, device=device, compute_type=compute_type, local_files_only=True)
        self.load_seconds = time.perf_counter() - t0

    def transcribe(self, samples) -> tuple[str, float]:
        t0 = time.perf_counter()
        segments, _info = self.model.transcribe(
            samples,
            language=self.language,
            beam_size=1,
            vad_filter=True,  # without VAD the model invents text on silence (TASK_002)
            condition_on_previous_text=False,
            temperature=0.0,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        return text, time.perf_counter() - t0


def pcm_to_samples(pcm: bytes):
    import numpy as np

    return np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0


def validate_pcm(pcm: bytes) -> str | None:
    if len(pcm) % 2 != 0:
        return "odd_length"
    if len(pcm) < MIN_BYTES:
        return "too_short"
    if len(pcm) > MAX_BYTES:
        return "too_long"
    return None


def reply(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def serve(stdin, backend, convert=pcm_to_samples) -> int:
    """Main loop; returns the exit code. Reads from a binary stream so raw PCM can follow a control line."""
    while True:
        line = stdin.readline()
        if not line:
            return 0  # parent went away: leave (and free the GPU with the process)
        try:
            msg = json.loads(line)
        except ValueError:
            reply({"ok": False, "error": "bad_json"})
            continue
        op = msg.get("op")
        if op == "ping":
            reply({"ok": True, "op": "ping", "protocol": PROTOCOL})
        elif op == "shutdown":
            reply({"ok": True, "op": "shutdown"})
            return 0
        elif op == "transcribe":
            n = msg.get("bytes")
            if not isinstance(n, int) or n < 0 or n > MAX_BYTES + 1024:
                reply({"ok": False, "op": "transcribe", "error": "bad_length"})
                return 3  # cannot resync a framed stream after a bad length
            pcm = b""
            while len(pcm) < n:
                chunk = stdin.read(n - len(pcm))
                if not chunk:
                    return 0
                pcm += chunk
            problem = validate_pcm(pcm)
            if problem:
                reply({"ok": False, "op": "transcribe", "error": problem})
                continue
            try:
                text, seconds = backend.transcribe(convert(pcm))
            except Exception as exc:  # report, stay alive: the parent decides
                reply({"ok": False, "op": "transcribe", "error": "decode_failed", "detail": type(exc).__name__})
                continue
            reply({"ok": True, "op": "transcribe", "text": text, "audioSeconds": round(len(pcm) / 2 / SAMPLE_RATE, 3), "decodeSeconds": round(seconds, 3)})
        else:
            reply({"ok": False, "error": "unknown_op"})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-path", required=True)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute-type", default="int8_float16")
    ap.add_argument("--language", default="en")
    args = ap.parse_args(argv)
    if not os.path.isdir(args.model_path):
        reply({"event": "error", "error": "model_path_missing"})
        return 2
    try:
        backend = Backend(args.model_path, args.device, args.compute_type, args.language)
        # The first decode is slow (kernel preparation): do it NOW so "ready" means ready (TASK_002: 26 s the first time).
        import numpy as np

        t0 = time.perf_counter()
        backend.transcribe(np.zeros(SAMPLE_RATE, dtype="float32"))
        warmup = time.perf_counter() - t0
    except Exception as exc:
        reply({"event": "error", "error": "load_failed", "detail": type(exc).__name__})
        return 2
    reply({"event": "ready", "protocol": PROTOCOL, "pid": os.getpid(), "loadSeconds": round(backend.load_seconds, 3), "warmupSeconds": round(warmup, 3), "device": args.device, "computeType": args.compute_type})
    return serve(sys.stdin.buffer, backend)


if __name__ == "__main__":
    sys.exit(main())
