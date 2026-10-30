"""Protocol tests for workers/stt/worker.py with a stub backend (no GPU, no model).
Run: py -3.11 -m unittest discover -s tests/python -v"""
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "workers", "stt"))
import worker  # noqa: E402


class Stub:
    def __init__(self):
        self.calls = 0

    def transcribe(self, samples):
        self.calls += 1
        return "hello world", 0.01


def run(raw: bytes, backend=None):
    out = io.StringIO()
    real = sys.stdout
    sys.stdout = out
    try:
        code = worker.serve(io.BytesIO(raw), backend or Stub(), convert=lambda b: b)
    finally:
        sys.stdout = real
    return code, [json.loads(x) for x in out.getvalue().splitlines()]


def frame(n_bytes: int) -> bytes:
    return json.dumps({"op": "transcribe", "bytes": n_bytes}).encode() + b"\n" + b"\x01\x00" * (n_bytes // 2)


class WorkerProtocol(unittest.TestCase):
    def test_ping_and_shutdown(self):
        code, out = run(b'{"op":"ping"}\n{"op":"shutdown"}\n')
        self.assertEqual(code, 0)
        self.assertEqual([o["op"] for o in out], ["ping", "shutdown"])

    def test_transcribe_returns_text_only(self):
        b = Stub()
        code, out = run(frame(32000), b)
        self.assertEqual(out[0], {"ok": True, "op": "transcribe", "text": "hello world", "audioSeconds": 1.0, "decodeSeconds": 0.01})
        self.assertEqual(b.calls, 1)
        self.assertEqual(code, 0)  # stdin closed: the worker leaves on its own

    def test_bad_audio_is_refused_without_decoding(self):
        b = Stub()
        _, out = run(frame(100) + frame(2 * 1024 * 1024 + 2), b)
        self.assertEqual([o["error"] for o in out], ["too_short", "too_long"])
        self.assertEqual(b.calls, 0)

    def test_odd_length_refused(self):
        raw = json.dumps({"op": "transcribe", "bytes": 3201}).encode() + b"\n" + b"\x00" * 3201
        _, out = run(raw)
        self.assertEqual(out[0]["error"], "odd_length")

    def test_absurd_length_ends_the_stream(self):
        code, out = run(json.dumps({"op": "transcribe", "bytes": 10**9}).encode() + b"\n")
        self.assertEqual(out[0]["error"], "bad_length")
        self.assertEqual(code, 3)

    def test_garbage_and_unknown_ops_do_not_kill_it(self):
        _, out = run(b"not json\n" + b'{"op":"dance"}\n' + b'{"op":"ping"}\n')
        self.assertEqual([o.get("error") for o in out[:2]], ["bad_json", "unknown_op"])
        self.assertTrue(out[2]["ok"])

    def test_decode_failure_is_reported_and_survivable(self):
        class Boom(Stub):
            def transcribe(self, samples):
                raise RuntimeError("cuda")

        _, out = run(frame(32000) + b'{"op":"ping"}\n', Boom())
        self.assertEqual(out[0]["error"], "decode_failed")
        self.assertTrue(out[1]["ok"])

    def test_module_never_writes_files(self):
        src = open(worker.__file__, encoding="utf8").read().replace("os.path.isdir", "")
        # the only "open(" allowed is this very check; no temp files, no audio writers, no directories
        for forbidden in ("tempfile", "NamedTemporaryFile", "wave.open", "soundfile", "write_bytes", "makedirs", "mkdir"):
            self.assertNotIn(forbidden, src, forbidden)
        self.assertNotIn("open(", src)

    def test_missing_model_path_reports_and_exits(self):
        out = io.StringIO()
        real = sys.stdout
        sys.stdout = out
        try:
            code = worker.main(["--model-path", os.path.join(os.path.dirname(__file__), "does-not-exist")])
        finally:
            sys.stdout = real
        self.assertEqual(code, 2)
        self.assertIn("model_path_missing", out.getvalue())


if __name__ == "__main__":
    unittest.main()
