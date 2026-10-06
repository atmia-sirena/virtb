"""Downloads training corpora into 16 kHz WAV + manifest.jsonl per source, with quality filters.

    uv run --extra data python -m data.prepare_asr --all
    uv run --extra data python -m data.prepare_asr indicvoices-hi kathbath-hi --max-hours 50

Filters:

- 0.5-30 s duration;
- 2-25 characters per second (drops misaligned labels);
- empty or [noise]-only transcripts.

With --check-wer, it also drops clips where the current champion model disagrees with the label by more than 60% WER. That needs the speech server running, and catches wrong labels, not hard audio.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import soundfile

from data.common import load_sources, train_dir, write_jsonl

TAGS = re.compile(r"\[[^\]]*\]|<[^>]*>|\([^)]*noise[^)]*\)", re.IGNORECASE)


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", TAGS.sub(" ", text)).strip()


def plausible(text: str, seconds: float) -> bool:
    if not text or not 0.5 <= seconds <= 30:
        return False
    rate = len(text.replace(" ", "")) / seconds
    return 2 <= rate <= 25


def champion_wer(path: Path, text: str, language: str, server: str) -> float | None:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "eval"))
    from pip_eval.metrics import word_errors

    query = urllib.parse.urlencode({"languages": language, "language": language})
    request = urllib.request.Request(f"{server}/transcribe?{query}", data=path.read_bytes(), headers={"content-type": "audio/wav"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            hypothesis = json.loads(response.read())["text"]
    except Exception:
        return None
    alignment = word_errors(text, hypothesis, language)
    return alignment.errors / max(alignment.reference_length, 1)


def prepare(name: str, spec: dict, max_hours: float, check_wer: bool, server: str) -> str:
    if spec.get("manual") or spec.get("local"):
        return f"{name}: {spec.get('note') or 'local manifest, nothing to download'}"
    from datasets import Audio, load_dataset

    target = train_dir() / name
    target.mkdir(parents=True, exist_ok=True)
    try:
        dataset = load_dataset(spec["repo"], spec.get("config"), split=spec["split"], streaming=True).cast_column("audio", Audio(sampling_rate=16000))
    except Exception as error:
        return f"{name}: couldn't load {spec['repo']}/{spec.get('config')}/{spec['split']}: {error}" + (" (marked verify: check the dataset page)" if spec.get("verify") else "")
    budget = min(max_hours or 1e9, spec.get("hours", 1e9)) * 3600
    kept = dropped = 0
    seconds_total = 0.0
    rows = []
    for index, row in enumerate(dataset):
        if seconds_total >= budget:
            break
        text = clean_text(str(row.get(spec.get("text", "text")) or ""))
        audio = np.asarray(row["audio"]["array"], dtype=np.float32)
        seconds = audio.size / 16000
        if not plausible(text, seconds):
            dropped += 1
            continue
        path = target / f"{index:08d}.wav"
        soundfile.write(path, audio, 16000)
        if check_wer:
            wer = champion_wer(path, text, spec["language"], server)
            if wer is not None and wer > 0.6:
                path.unlink()
                dropped += 1
                continue
        rows.append({"audio": path.name, "text": text, "language": spec["language"], "duration": round(seconds, 3), "source": name})
        kept += 1
        seconds_total += seconds
    write_jsonl(target / "manifest.jsonl", rows)
    return f"{name}: kept {kept} ({seconds_total / 3600:.1f} h), dropped {dropped}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sources", nargs="*")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--max-hours", type=float, default=0)
    parser.add_argument("--check-wer", action="store_true")
    parser.add_argument("--server", default="http://127.0.0.1:8790")
    args = parser.parse_args()
    sources = load_sources()["sources"]
    for name in (list(sources) if args.all else args.sources):
        print(prepare(name, sources[name], args.max_hours, args.check_wer, args.server) if name in sources else f"{name}: unknown")


if __name__ == "__main__":
    main()
