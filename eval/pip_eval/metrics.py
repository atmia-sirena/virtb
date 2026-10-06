"""Scores for one run: WER/CER, Wispr-style output quality, latency."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .normalize import for_wer, for_zero_edit

LEXICON = Path(__file__).resolve().parents[2] / "shared" / "speech" / "lexicon"


@dataclass
class Alignment:
    substitutions: int = 0
    deletions: int = 0
    insertions: int = 0
    reference_length: int = 0
    inserted: list[str] = field(default_factory=list)

    @property
    def errors(self) -> int:
        return self.substitutions + self.deletions + self.insertions


def align(reference: list[str], hypothesis: list[str]) -> Alignment:
    """Levenshtein alignment with operation counts (and which words were inserted)."""
    rows, columns = len(reference) + 1, len(hypothesis) + 1
    cost = np.zeros((rows, columns), dtype=np.int32)
    cost[:, 0] = np.arange(rows)
    cost[0, :] = np.arange(columns)
    for row in range(1, rows):
        for column in range(1, columns):
            same = reference[row - 1] == hypothesis[column - 1]
            cost[row, column] = min(cost[row - 1, column] + 1, cost[row, column - 1] + 1, cost[row - 1, column - 1] + (0 if same else 1))
    result = Alignment(reference_length=len(reference))
    row, column = rows - 1, columns - 1
    while row > 0 or column > 0:
        if row > 0 and column > 0 and cost[row, column] == cost[row - 1, column - 1] + (0 if reference[row - 1] == hypothesis[column - 1] else 1):
            if reference[row - 1] != hypothesis[column - 1]:
                result.substitutions += 1
            row, column = row - 1, column - 1
        elif row > 0 and cost[row, column] == cost[row - 1, column] + 1:
            result.deletions += 1
            row -= 1
        else:
            result.insertions += 1
            result.inserted.append(hypothesis[column - 1])
            column -= 1
    return result


def word_errors(reference: str, hypothesis: str, language: str) -> Alignment:
    return align(for_wer(reference, language).split(), for_wer(hypothesis, language).split())


def char_errors(reference: str, hypothesis: str, language: str) -> Alignment:
    return align(list(for_wer(reference, language).replace(" ", "")), list(for_wer(hypothesis, language).replace(" ", "")))


def fillers() -> set[str]:
    words: set[str] = set()
    for path in LEXICON.glob("*.json"):
        if "roman" in path.name:
            continue
        words.update(word.lower() for word in json.loads(path.read_text(encoding="utf-8")).get("fillers", []))
    return words


ENTITY = re.compile(r"₹\s?[\d,]+(?:\.\d+)?|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\d[\d,:.]*\b|https?://\S+|\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b")


def entities(text: str) -> list[str]:
    """Numbers, money, times, emails, URLs and capitalized names: things a dictation must get exactly right."""
    found = [match.group(0).rstrip(".,") for match in ENTITY.finditer(text)]
    # A capitalized word at a sentence start is not a name.
    starts = {match.group(1) for match in re.finditer(r"(?:^|[.?!\n]\s*)([A-Z][a-z]+)", text)}
    return [item for item in found if item not in starts]


def percentile(values: list[float], q: float) -> float | None:
    return float(np.percentile(values, q)) if values else None


@dataclass
class Item:
    id: str
    language: str
    reference: str  # verbatim transcript (for WER)
    hypothesis: str  # speech model output
    final_reference: str | None = None  # what Pip should type after cleanup
    final: str | None = None  # what Pip typed
    tags: list[str] = field(default_factory=list)
    latency: float | None = None  # seconds, key-up to text
    model: str | None = None


def score(items: list[Item]) -> dict[str, Any]:
    """Aggregate metrics, overall and per language."""
    by_language: dict[str, list[Item]] = {}
    for item in items:
        by_language.setdefault(item.language, []).append(item)
    report: dict[str, Any] = {"overall": _score(items), "languages": {language: _score(group) for language, group in sorted(by_language.items())}}
    return report


def _score(items: list[Item]) -> dict[str, Any]:
    words = [word_errors(item.reference, item.hypothesis, item.language) for item in items if item.reference]
    chars = [char_errors(item.reference, item.hypothesis, item.language) for item in items if item.reference]
    reference_words = sum(alignment.reference_length for alignment in words) or 1
    reference_chars = sum(alignment.reference_length for alignment in chars) or 1
    result: dict[str, Any] = {
        "utterances": len(items),
        "wer": round(sum(alignment.errors for alignment in words) / reference_words, 4),
        "cer": round(sum(alignment.errors for alignment in chars) / reference_chars, 4),
    }
    finals = [item for item in items if item.final_reference is not None and item.final is not None]
    if finals:
        filler_words = fillers()
        zero_edit = [for_zero_edit(item.final) == for_zero_edit(item.final_reference) for item in finals]
        commands = [ok for item, ok in zip(finals, zero_edit) if {"command", "backtrack"} & set(item.tags)]
        final_alignments = [word_errors(item.final_reference, item.final, item.language) for item in finals]
        leaks = sum(1 for item in finals if any(word.lower().strip(".,?!") in filler_words for word in item.final.split()))
        expected_entities = [(entity, item.final) for item in finals for entity in entities(item.final_reference)]
        result.update(
            {
                "final_wer": round(sum(a.errors for a in final_alignments) / (sum(a.reference_length for a in final_alignments) or 1), 4),
                "zero_edit_rate": round(sum(zero_edit) / len(finals), 4),
                "command_accuracy": round(sum(commands) / len(commands), 4) if commands else None,
                "filler_leak_rate": round(leaks / len(finals), 4),
                # Words in the output the speaker never said (ASR hallucinations, cleanup additions).
                # Said-but-not-removed words (a missed filler or correction) show up in final_wer instead.
                "hallucinated_word_rate": round(
                    sum(sum(1 for word in a.inserted if word not in set(for_wer(item.reference, item.language).split())) for a, item in zip(final_alignments, finals))
                    / (sum(a.reference_length for a in final_alignments) or 1),
                    4,
                ),
                "entity_accuracy": round(sum(1 for entity, final in expected_entities if entity in final) / len(expected_entities), 4) if expected_entities else None,
            }
        )
    latencies = [item.latency for item in items if item.latency is not None]
    if latencies:
        result["latency_p50"] = round(percentile(latencies, 50), 3)
        result["latency_p95"] = round(percentile(latencies, 95), 3)
    return result


# Targets from the plan; a report marks each metric pass/fail.
TARGETS = {
    "svarah": {"wer": 0.08},
    "hi": {"wer": 0.08},
    "hinglish": {"wer": 0.12},
    "ta": {"wer": 0.15, "cer": 0.05},
    "te": {"wer": 0.15, "cer": 0.05},
    "pa": {"wer": 0.12},
    "dictation": {"zero_edit_rate": 0.90, "command_accuracy": 0.95, "filler_leak_rate": 0.01, "hallucinated_word_rate": 0.002},
    "latency": {"latency_p50": 0.7, "latency_p95": 1.5},
}


def check(metric: str, value: float | None, target: float) -> bool | None:
    if value is None:
        return None
    higher_is_better = metric in {"zero_edit_rate", "command_accuracy", "entity_accuracy"}
    return value >= target if higher_is_better else value <= target
