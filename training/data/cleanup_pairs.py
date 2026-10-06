"""Training data for the cleanup LLM (recipe C): (spoken transcript, what should be
typed) pairs become (Pip's edit prompt, edit-op JSON) chat examples.

The prompt comes from Pip's backend (/v2/dictation/edit-prompt: the rules run
first, exactly as live), and the ops are derived by aligning the rule output
with the target text. Pairs the op set can't express (they'd need a new word)
are dropped, so the model only ever learns faithful edits.

    python -m data.cleanup_pairs --pairs data/disco.jsonl eval-scripts.jsonl --out mix/cleanup-v1.jsonl

Pair files: JSONL with spoken/final/language (DISCO), or the scripts.jsonl that
eval/generate_dictation_set.py --split train writes (text/final/language).
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from data.common import read_jsonl, write_jsonl

TOKEN = re.compile(r"\n+|[\wऀ-෿][\wऀ-෿'’@._+\-/:]*[\wऀ-෿]|[\wऀ-෿]|[^\s\w]", re.UNICODE)
MARKS = {",", ".", "?", "!", ":", ";", "।"}
NUMBER_WORDS = {"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "lakh", "lakhs", "crore", "crores", "million", "and", "percent"}


def is_word(token: str) -> bool:
    return bool(token) and unicodedata.category(token[0])[0] in "LMN"


def loose(word: str) -> str:
    return unicodedata.normalize("NFC", word).lower().replace("़", "").replace("਼", "")


def words_and_marks(text: str) -> tuple[list[str], list[str]]:
    """Words, and the punctuation mark right after each ("" if none)."""
    words: list[str] = []
    marks: list[str] = []
    for token in TOKEN.findall(text):
        if is_word(token):
            words.append(token)
            marks.append("")
        elif token in MARKS and words and not marks[-1]:
            marks[-1] = token
    return words, marks


def replacement_ok(span: list[str], replacement: str) -> bool:
    letters = lambda text: re.sub(r"[^\w]", "", loose(text))  # noqa: E731
    if letters("".join(span)) == letters(replacement):
        return True
    return bool(re.fullmatch(r"₹?[\d,]+%?", replacement)) and all(loose(word) in NUMBER_WORDS or word.isdigit() for word in span)


def derive_ops(source_words: list[str], source_marks: list[str], final: str) -> dict[str, Any] | None:
    target_words, target_marks = words_and_marks(final)
    matcher = SequenceMatcher(a=[loose(word) for word in source_words], b=[loose(word) for word in target_words], autojunk=False)
    ops: dict[str, list] = {"delete": [], "punctuation": [], "capitalize": [], "lowercase": [], "replace": []}
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(a1 - a0):
                source, target = source_words[a0 + offset], target_words[b0 + offset]
                if source[:1] != target[:1]:
                    ops["capitalize" if target[:1].isupper() else "lowercase"].append(a0 + offset)
                if source_marks[a0 + offset] != target_marks[b0 + offset]:
                    ops["punctuation"].append({"after": a0 + offset, "mark": target_marks[b0 + offset]})
        elif tag == "delete":
            ops["delete"].append([a0, a1 - 1])
        elif tag == "replace":
            replacement = " ".join(target_words[b0:b1])
            if not replacement_ok(source_words[a0:a1], replacement):
                return None
            ops["replace"].append({"from": a0, "to": a1 - 1, "with": replacement})
            if source_marks[a1 - 1] != target_marks[b1 - 1]:
                ops["punctuation"].append({"after": a1 - 1, "mark": target_marks[b1 - 1]})
        else:  # insert: the target has words that were never said
            return None
    return {key: value for key, value in ops.items() if value}


def edit_prompt(backend: str, text: str, language: str) -> dict[str, Any]:
    request = urllib.request.Request(f"{backend}/v2/dictation/edit-prompt", data=json.dumps({"text": text, "language": language}).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def build(pair_files: list[Path], backend: str) -> tuple[list[dict[str, Any]], int]:
    examples, dropped = [], 0
    for path in pair_files:
        for row in read_jsonl(path):
            spoken = row.get("spoken") or row.get("text") or ""
            final = row.get("final") or ""
            language = row.get("language", "en")
            if not spoken.strip():
                continue
            prepared = edit_prompt(backend, spoken, language)
            source_words = prepared["words"]
            _, source_marks = words_and_marks(prepared["deterministic"])
            if len(source_marks) != len(source_words):
                dropped += 1
                continue
            ops = derive_ops(source_words, source_marks, final)
            if ops is None:
                dropped += 1
                continue
            examples.append(
                {
                    "language": language,
                    "messages": [
                        {"role": "system", "content": prepared["system"]},
                        {"role": "user", "content": prepared["user"]},
                        {"role": "assistant", "content": json.dumps(ops, ensure_ascii=False)},
                    ],
                }
            )
    return examples, dropped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pairs", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--backend", default="http://127.0.0.1:8787")
    args = parser.parse_args()
    examples, dropped = build([Path(path) for path in args.pairs], args.backend)
    write_jsonl(Path(args.out), examples)
    print(f"{len(examples)} examples -> {args.out} ({dropped} pairs dropped: not expressible without adding words)")


if __name__ == "__main__":
    main()
