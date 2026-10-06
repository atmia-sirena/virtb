"""Builds the training mix from prepared sources: hour caps per source, a held-out
dev slice, and the two formats the recipes need.

    python -m data.mix --out mix/india-v1

Writes:
- qwen_train.jsonl / qwen_dev.jsonl: {"audio", "text": "language Hindi<asr_text>...", "prompt"?}
  20% of rows carry a context prompt with names/terms from the transcript plus
  distractors from other rows: the exact form the speech server sends at inference,
  so the model learns to use your dictionary without copying it blindly.
- nemo_train.json / nemo_dev.json: {"audio_filepath", "duration", "text", "lang"}
- summary.json: hours per language and source.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from data.common import QWEN_LANGUAGE, eval_data_dir, load_sources, read_jsonl, train_dir, write_jsonl

CONTEXT_PREFIX = "Names and terms that may appear: "
TERM = re.compile(r"\b[A-Z][a-zA-Z]{2,}\b|\b[a-zA-Z]+[0-9][a-zA-Z0-9]*\b")


def source_rows(name: str, spec: dict[str, Any]) -> list[dict[str, Any]]:
    if spec.get("local"):
        path = Path(spec["local"].replace("{eval_data}", str(eval_data_dir())))
    else:
        path = train_dir() / name / "manifest.jsonl"
    if not path.exists():
        return []
    rows = []
    for row in read_jsonl(path):
        audio = Path(row["audio"])
        audio = audio if audio.is_absolute() else path.parent / audio
        duration = row.get("duration")
        if duration is None:
            import soundfile

            duration = soundfile.info(str(audio)).duration
        rows.append({"audio": str(audio), "text": row["text"], "language": row.get("language", spec.get("language")), "duration": float(duration), "source": name})
    return rows


def cap_hours(rows: list[dict[str, Any]], hours: float, rng: random.Random) -> list[dict[str, Any]]:
    rng.shuffle(rows)
    kept, total = [], 0.0
    for row in rows:
        if total >= hours * 3600:
            break
        kept.append(row)
        total += row["duration"]
    return kept


def context_prompt(text: str, pool: list[str], rng: random.Random) -> str | None:
    terms = list(dict.fromkeys(TERM.findall(text)))
    if not terms:
        return None
    chosen = rng.sample(terms, min(len(terms), rng.randint(1, 3)))
    distractors = rng.sample(pool, min(len(pool), rng.randint(2, 8))) if pool else []
    words = [*chosen, *[word for word in distractors if word not in chosen]]
    rng.shuffle(words)
    return CONTEXT_PREFIX + ", ".join(words)


def qwen_row(row: dict[str, Any], prompt: str | None) -> dict[str, Any]:
    language = QWEN_LANGUAGE.get(row["language"], "None")
    value = {"audio": row["audio"], "text": f"language {language}<asr_text>{row['text']}"}
    if prompt:
        value["prompt"] = prompt
    return value


def nemo_row(row: dict[str, Any]) -> dict[str, Any]:
    return {"audio_filepath": row["audio"], "duration": round(row["duration"], 3), "text": row["text"], "lang": row["language"]}


def build(out: Path, dev_share: float, context_share: float, seed: int, only: set[str] | None) -> dict[str, Any]:
    rng = random.Random(seed)
    sources = load_sources()["sources"]
    rows: list[dict[str, Any]] = []
    for name, spec in sources.items():
        if only and spec.get("language") not in only:
            continue
        found = source_rows(name, spec)
        rows += cap_hours(found, spec.get("hours", 1e9), rng)
    rng.shuffle(rows)
    dev_count = max(1, int(len(rows) * dev_share)) if rows else 0
    dev, train = rows[:dev_count], rows[dev_count:]
    pool = list({term for row in rows[:20000] for term in TERM.findall(row["text"])})

    def with_prompts(subset):
        return [qwen_row(row, context_prompt(row["text"], pool, rng) if rng.random() < context_share else None) for row in subset]

    write_jsonl(out / "qwen_train.jsonl", with_prompts(train))
    write_jsonl(out / "qwen_dev.jsonl", with_prompts(dev))
    write_jsonl(out / "nemo_train.json", (nemo_row(row) for row in train))
    write_jsonl(out / "nemo_dev.json", (nemo_row(row) for row in dev))
    summary: dict[str, Any] = {"utterances": len(rows), "hours": defaultdict(float), "sources": defaultdict(float)}
    for row in rows:
        summary["hours"][row["language"]] += row["duration"] / 3600
        summary["sources"][row["source"]] += row["duration"] / 3600
    summary = {"utterances": summary["utterances"], "hours": {k: round(v, 1) for k, v in summary["hours"].items()}, "sources": {k: round(v, 1) for k, v in summary["sources"].items()}}
    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="mix/india-v1")
    parser.add_argument("--dev-share", type=float, default=0.01)
    parser.add_argument("--context-share", type=float, default=0.2)
    parser.add_argument("--languages", default="", help="only these languages (e.g. ta,te,pa for the SraVaani recipe)")
    parser.add_argument("--seed", type=int, default=13)
    args = parser.parse_args()
    out = Path(args.out)
    print(json.dumps(build(out, args.dev_share, args.context_share, args.seed, set(args.languages.split(",")) if args.languages else None), indent=2))


if __name__ == "__main__":
    main()
