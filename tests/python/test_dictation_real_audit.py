import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import csv
import json
import sys
import types

MODULE = Path(__file__).resolve().parents[2] / "scripts" / "dictation-real-audit.py"
spec = importlib.util.spec_from_file_location("dictation_real_audit", MODULE)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.audio = Path(self.tmp.name)
        (self.audio / "a.mp3").write_bytes(b"sample")
        self.row = {"path": "a.mp3", "sentence_id": "one", "sentence": "I want to eat some cake.", "duration_ms": "4.5", "up_votes": "2", "down_votes": "0", "accents": "Australian English"}

    def test_filters_metadata_and_unsafe_or_missing_audio(self):
        self.assertTrue(audit.candidate(self.row, self.audio))
        for updates in ({"sentence": "Too short."}, {"sentence": " ".join(["word"] * 17) + "."}, {"down_votes": "1"}, {"duration_ms": "nan"}, {"path": "../a.mp3"}, {"path": "missing.mp3"}, {"accents": "Australian English,United States English"}):
            with self.subTest(updates=updates):
                self.assertFalse(audit.candidate({**self.row, **updates}, self.audio))

    def test_selection_is_deterministic_and_deduplicates_sentences(self):
        rows = [self.row, {**self.row, "path": "a.mp3"}, {**self.row, "sentence_id": "two"}]
        chosen = audit.pick(rows, self.audio, 3, 42)
        self.assertEqual(len(chosen), 2)
        self.assertEqual(chosen, audit.pick(rows, self.audio, 3, 42))
        self.assertEqual([r["sentence_id"] for r in audit.pick(rows, self.audio, 3, 42, {"one"})], ["two"])

    def test_comparison_never_fills_in_words(self):
        self.assertEqual(audit.comparable("It's fine!"), audit.comparable("its fine"))
        self.assertNotEqual(audit.comparable("I want cake"), audit.comparable("I want the cake"))

    def test_checkpoint_reuses_only_the_same_audio(self):
        root = Path(self.tmp.name) / "dataset"
        audio = root / "audio_files"
        audio.mkdir(parents=True)
        file = audio / "a.mp3"
        file.write_bytes(b"first")
        with (root / "commonvoice-v24_en-AU.csv").open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(self.row))
            writer.writeheader()
            writer.writerow(self.row)
        calls = []
        class Model:
            def __init__(self, model_path, **_options): self.name = model_path
            def transcribe(self, *_args, **_kwargs):
                calls.append(self.name)
                return [types.SimpleNamespace(text=self_row["sentence"])], None
        self_row = self.row
        output = Path(self.tmp.name) / "out.json"
        argv = ["audit", str(root), "--count", "1", "--verify", "--output", str(output)]
        with patch.object(sys, "argv", argv), patch.dict(sys.modules, {"faster_whisper": types.SimpleNamespace(WhisperModel=Model)}), patch.object(audit, "cached_model", side_effect=lambda name: name):
            self.assertEqual(audit.main(), 0)
            self.assertEqual(len(calls), 2)
            self.assertTrue(json.loads(output.read_text(encoding="utf-8"))["asr_checks_completed"])
            self.assertEqual(audit.main(), 0)
            self.assertEqual(len(calls), 2)
            file.write_bytes(b"changed")
            self.assertEqual(audit.main(), 0)
            self.assertEqual(len(calls), 4)


if __name__ == "__main__":
    unittest.main()
