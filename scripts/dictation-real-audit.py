"""Inspect local Common Voice candidates; never publishes exercises or downloads models."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import re
import sys
import time
from pathlib import Path

WORD = re.compile(r"[a-z0-9]+(?:['\u2019][a-z0-9]+)*", re.I)
END = re.compile(r"[.!?]$")
ACCENT = "Australian English"


def word_count(text: str) -> int:
    return len(WORD.findall(text))


def comparable(text: str) -> list[str]:
    # Deliberately conservative: punctuation and case are ignored, but words are not invented or rewritten.
    return re.findall(r"[a-z0-9]+", text.lower().replace("'", "").replace("\u2019", ""))


def candidate(row: dict[str, str], audio_dir: Path, min_words: int = 5, max_words: int = 16) -> bool:
    text = row.get("sentence", "").strip()
    filename = row.get("path", "")
    if not filename or Path(filename).name != filename or not filename.lower().endswith(".mp3"):
        return False
    try:
        duration = float(row.get("duration_ms", ""))  # v24 en-AU stores seconds despite its field name
        votes = int(row.get("up_votes", ""))
        downvotes = int(row.get("down_votes", ""))
    except (TypeError, ValueError):
        return False
    return bool(
        5 <= min_words <= max_words <= 16
        and min_words <= word_count(text) <= max_words
        and END.search(text)
        and row.get("accents", "").strip() == ACCENT
        and votes >= 2 and downvotes == 0
        and math.isfinite(duration) and 2 <= duration <= 12
        and (audio_dir / filename).is_file()
    )


def pick(rows: list[dict[str, str]], audio_dir: Path, count: int, seed: int, excluded: set[str] | None = None) -> list[dict[str, str]]:
    matches = [r for r in rows if candidate(r, audio_dir)]
    random.Random(seed).shuffle(matches)
    selected: list[dict[str, str]] = []
    sentence_ids: set[str] = set(excluded or ())
    for row in matches:
        sid = row.get("sentence_id", "")
        if not sid or sid in sentence_ids:
            continue
        selected.append(row)
        sentence_ids.add(sid)
        if len(selected) >= count:
            break
    return selected


def cached_model(name: str) -> Path:
    hub = Path.home() / ".cache" / "huggingface" / "hub" / f"models--Systran--faster-whisper-{name}" / "snapshots"
    snapshots = sorted(hub.iterdir()) if hub.is_dir() else []
    for path in snapshots:
        if (path / "model.bin").is_file():
            return path
    raise FileNotFoundError(f"No cached faster-whisper {name} model; no download was attempted")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Extracted dataset directory containing CSV and audio_files")
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--seed", type=int, default=1126)
    parser.add_argument("--indices", help="Comma-separated zero-based indices from the selected candidates")
    parser.add_argument("--verify", action="store_true", help="Run both locally cached Whisper models on CPU")
    parser.add_argument("--exclude-reviewed", type=Path, help="Exclude sentence IDs already in the reviewed catalogue")
    parser.add_argument("--exclude-batches", type=Path, help="Exclude sentence IDs in completed batches")
    parser.add_argument("--metadata-index", type=Path, help="Create a local index of eligible source metadata when missing")
    parser.add_argument("--output", type=Path, default=Path("var/dictation-real/review-candidates.json"))
    args = parser.parse_args()
    if not 1 <= args.count <= 1000:
        parser.error("--count must be between 1 and 1000")
    csv_path = args.dataset / "commonvoice-v24_en-AU.csv"
    audio_dir = args.dataset / "audio_files"
    with csv_path.open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))
    if args.metadata_index and not args.metadata_index.exists():
        metadata = {r["path"]: {"sentence_id": r["sentence_id"], "text": r["sentence"], "audio_ms": round(float(r["duration_ms"]) * 1000)} for r in rows if candidate(r, audio_dir)}
        args.metadata_index.parent.mkdir(parents=True, exist_ok=True)
        temp = args.metadata_index.with_suffix(".tmp")
        temp.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        temp.replace(args.metadata_index)
    excluded: set[str] = set()
    files = ([args.exclude_reviewed] if args.exclude_reviewed and args.exclude_reviewed.is_file() else [])
    if args.exclude_batches and args.exclude_batches.is_dir():
        files.extend(args.exclude_batches.glob("batch-*.json"))
    for filename in files:
        data = json.loads(filename.read_text(encoding="utf-8"))
        for clip in data.get("clips", []):
            sid = clip.get("sentenceId") or clip.get("sentence_id")
            if sid:
                excluded.add(sid)
    selected = pick(rows, audio_dir, args.count, args.seed, excluded)
    if args.indices:
        try:
            indices = [int(v) for v in args.indices.split(",")]
            if len(indices) != len(set(indices)) or any(i < 0 or i >= len(selected) for i in indices):
                raise ValueError()
            selected = [selected[i] for i in indices]
        except ValueError:
            parser.error("--indices must contain distinct, valid zero-based indices")
    result = [{"file": r["path"], "sentence_id": r["sentence_id"], "text": r["sentence"], "audio_ms": round(float(r["duration_ms"]) * 1000), "sha256": hashlib.sha256((audio_dir / r["path"]).read_bytes()).hexdigest(), "status": "pending_review", "checks": {}} for r in selected]
    print(f"Selected {len(result)} of {len(rows)} rows; status pending_review", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Each result is checkpointed, so a cancelled CPU batch can resume without repeating successful transcriptions.
    if args.output.is_file():
        try:
            previous = json.loads(args.output.read_text(encoding="utf-8"))
            if previous.get("version") == 1 and previous.get("source") == "common-voice-v24-en-au" and previous.get("seed") == args.seed:
                saved = {(c["file"], c["text"], c["sha256"]): c.get("checks", {}) for c in previous.get("clips", [])}
                for clip in result:
                    clip["checks"] = saved.get((clip["file"], clip["text"], clip["sha256"]), {})
        except (ValueError, KeyError, TypeError):
            pass

    active_model: str | None = None
    active_started: float | None = None

    def checkpoint() -> None:
        complete = all(all(name in c["checks"] for name in ("large-v3", "medium")) for c in result) and bool(result)
        payload = {"version": 1, "source": "common-voice-v24-en-au", "seed": args.seed, "asr_checks_completed": complete, "active_model": active_model, "active_started": active_started, "clips": result}
        temp = args.output.with_suffix(args.output.suffix + ".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(args.output)

    checkpoint()
    if args.verify:
        from faster_whisper import WhisperModel
        for name in ("large-v3", "medium"):
            start = time.monotonic()
            active_model, active_started = name, None
            checkpoint()
            print(f"Checking with {name} on CPU", flush=True)
            model = WhisperModel(str(cached_model(name)), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
            for i, clip in enumerate(result, 1):
                if name in clip["checks"]:
                    continue
                active_started = time.time()
                checkpoint()
                check_started = time.monotonic()
                segments, _ = model.transcribe(str(audio_dir / clip["file"]), language="en", beam_size=5, vad_filter=False, condition_on_previous_text=False, temperature=0.0)
                heard = " ".join(s.text.strip() for s in segments).strip()
                clip["checks"][name] = {"text": heard, "matches": comparable(heard) == comparable(clip["text"]), "seconds": round(time.monotonic() - check_started, 2)}
                active_started = None
                checkpoint()
                print(f"{name} {i}/{len(result)} ({time.monotonic() - start:.0f}s)", flush=True)
            del model
    active_model, active_started = None, None
    checkpoint()
    print(f"Saved {len(result)} candidates to {args.output}; none approved", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
