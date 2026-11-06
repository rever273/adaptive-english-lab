"""English Lab voice evaluation: DNSMOS P.835 on SYNTHESISED clips (TASK_029, D125).

Scores every WAV in a folder with Microsoft's DNSMOS P.835 ONNX model (signal, background, overall; 1-5, higher is better) on the CPU.
It is a predicted quality score made for noisy speech: for synthetic voices it says whether the sound is clean and speech-like, not whether the
accent or the voice is pleasant. Only a person can say that. Never used for the learner's voice.

  python dnsmos.py --model <sig_bak_ovr.onnx> --dir <folder with .wav files>   ->   one JSON object on stdout: {"model": ..., "scores": {file: {sig, bak, ovr}}}

Clips shorter than the model window (9.01 s) are repeated to fill it, as the reference implementation does.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

SR = 16000
INPUT_LENGTH = 9.01
# polynomial adjustment of the raw scores (reference implementation, non-personalised model)
P_OVR = np.poly1d([-0.06766283, 1.11546468, 0.04602535])
P_SIG = np.poly1d([-0.08397278, 1.22083953, 0.0052439])
P_BAK = np.poly1d([-0.13166888, 1.60915514, -0.39604546])


def load(path: Path) -> np.ndarray:
    import soundfile as sf
    import librosa

    audio, rate = sf.read(str(path), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if rate != SR:
        audio = librosa.resample(audio, orig_sr=rate, target_sr=SR)
    return audio.astype("float32")


def score(session, audio: np.ndarray) -> dict:
    need = int(INPUT_LENGTH * SR)
    while len(audio) < need:
        audio = np.append(audio, audio)
    hops = int(np.floor(len(audio) / SR) - INPUT_LENGTH) + 1
    sigs, baks, ovrs = [], [], []
    for i in range(max(1, hops)):
        seg = audio[int(i * SR): int((i + INPUT_LENGTH) * SR)]
        if len(seg) < need:
            break
        raw = session.run(None, {"input_1": seg[np.newaxis, :]})[0][0]
        sigs.append(float(P_SIG(raw[0])))
        baks.append(float(P_BAK(raw[1])))
        ovrs.append(float(P_OVR(raw[2])))
    return {"sig": round(float(np.mean(sigs)), 3), "bak": round(float(np.mean(baks)), 3), "ovr": round(float(np.mean(ovrs)), 3)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()
    import onnxruntime as ort

    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    scores = {}
    for wav in sorted(Path(args.dir).glob("*.wav")):
        try:
            scores[wav.name] = score(session, load(wav))
        except Exception as e:  # noqa: BLE001 - one bad clip must not lose the rest
            scores[wav.name] = {"error": str(e)[:200]}
    sys.stdout.write(json.dumps({"model": "dnsmos-p835-sig_bak_ovr", "onnxruntime": ort.__version__, "scores": scores}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
