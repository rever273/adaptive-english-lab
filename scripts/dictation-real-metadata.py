"""Index eligible Common Voice source metadata for existing completed audit batches."""
import csv
import json
import sys
from pathlib import Path
import importlib.util

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("dictation-real-audit.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
dataset, output = map(Path, sys.argv[1:3])
with (dataset / "commonvoice-v24_en-AU.csv").open(encoding="utf-8-sig", newline="") as f:
    items = {r["path"]: {"sentence_id": r["sentence_id"], "text": r["sentence"], "audio_ms": round(float(r["duration_ms"]) * 1000)}
             for r in csv.DictReader(f) if audit.candidate(r, dataset / "audio_files")}
output.parent.mkdir(parents=True, exist_ok=True)
temp = output.with_suffix(".tmp")
temp.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
temp.replace(output)
print(f"Indexed {len(items)} eligible source recordings")
