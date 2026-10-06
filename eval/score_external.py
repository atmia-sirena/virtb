"""Scores another dictation app's output (e.g. Wispr Flow) on a Pip test set.

    python score_external.py --set pip-dictation --outputs wispr.jsonl --name wispr-flow

`wispr.jsonl` has one {"id": ..., "text": ...} per clip (and optionally "latency" in seconds).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from pip_eval.manifest import ROOT, load_config, load_set
from pip_eval.metrics import Item, score
from pip_eval.run import write_report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", required=True)
    parser.add_argument("--outputs", required=True)
    parser.add_argument("--name", default="external")
    args = parser.parse_args()
    utterances = load_set(args.set, load_config())
    if isinstance(utterances, str):
        raise SystemExit(utterances)
    outputs = {row["id"]: row for row in (json.loads(line) for line in Path(args.outputs).read_text(encoding="utf-8").splitlines() if line.strip())}
    items = []
    for utterance in utterances:
        row = outputs.get(utterance.id)
        if row is None:
            continue
        # The app's typed text is both its transcript and its final output.
        items.append(Item(utterance.id, utterance.language, utterance.text, row["text"], utterance.final, row["text"], utterance.tags, row.get("latency")))
    print(f"scored {len(items)} of {len(utterances)} clips")
    report = {"config": args.name, "sets": {args.set: score(items)}}
    print(write_report(report, f"{args.name}-{args.set}", ROOT / "reports").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
