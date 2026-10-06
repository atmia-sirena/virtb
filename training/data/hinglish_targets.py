"""Romanized Hinglish training targets: Devanagari words in code-switched
transcripts (MUCS, HiACC, synthetic) become casual Latin spellings, the way
Pip types Hinglish. Uses the same table as the backend
(shared/speech/lexicon/hinglish-roman.json), then IndicXlit in the speech
server, then leaves the word for review.

    python -m data.hinglish_targets path/to/manifest.jsonl --out path/to/manifest.roman.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from pathlib import Path

from data.common import REPO, read_jsonl, write_jsonl

DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def load_table() -> dict[str, str]:
    data = json.loads((REPO / "shared" / "speech" / "lexicon" / "hinglish-roman.json").read_text(encoding="utf-8"))
    return data.get("words", {})


def xlit(words: list[str], server: str) -> list[str | None]:
    if not words:
        return []
    request = urllib.request.Request(f"{server}/xlit", data=json.dumps({"words": words, "source": "hi"}).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())["words"]
    except Exception:
        return [None] * len(words)


def romanize(text: str, table: dict[str, str], server: str, cache: dict[str, str | None]) -> tuple[str, int]:
    tokens = re.findall(r"\S+", text.replace("।", "."))
    unknown = [token for token in tokens if DEVANAGARI.search(token) and token not in table and token not in cache]
    for word, roman in zip(unknown, xlit(unknown, server)):
        cache[word] = roman.lower() if roman else None
    output, unresolved = [], 0
    for token in tokens:
        if not DEVANAGARI.search(token):
            output.append(token)
            continue
        core = token.strip(".,?!")
        roman = table.get(core) or cache.get(core)
        if roman is None:
            unresolved += 1
            output.append(token)
        else:
            output.append(token.replace(core, roman))
    return " ".join(output), unresolved


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest")
    parser.add_argument("--out", required=True)
    parser.add_argument("--server", default="http://127.0.0.1:8790")
    args = parser.parse_args()
    table, cache = load_table(), {}
    rows, unresolved_rows = [], 0
    for row in read_jsonl(Path(args.manifest)):
        text, unresolved = romanize(row["text"], table, args.server, cache)
        if unresolved:
            unresolved_rows += 1
            continue  # keep targets clean: rows with words we couldn't romanize are left out
        rows.append({**row, "text": text, "language": "hinglish"})
    count = write_jsonl(Path(args.out), rows)
    print(f"{count} romanized rows -> {args.out} ({unresolved_rows} skipped with unromanizable words)")


if __name__ == "__main__":
    main()
