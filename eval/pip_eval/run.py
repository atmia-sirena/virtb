"""Runs Pip's speech stack over test sets and writes a report.

    python run.py --set hindi                      # route like live dictation (LID across --languages)
    python run.py --set fleurs-ta --force-language # skip language ID
    python run.py --set all --config engine=indicconformer-rnnt
    python run.py --set dictation --cleanup        # full pipeline: speech + cleanup layer
    python run.py --set cleanup-seeds              # cleanup layer only, no audio
    python run.py --bakeoff --set hindi,south,punjabi,english
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Callable

from .clients import BackendClient, SpeechClient
from .manifest import ROOT, Utterance, expand, load_config, load_set, state_dir
from .metrics import TARGETS, Item, check, score

DEFAULT_LANGUAGES = ["en-IN", "hi", "hinglish", "ta", "te", "pa"]


def run_items(
    utterances: list[Utterance],
    speech: SpeechClient | None,
    backend: BackendClient | None,
    languages: list[str],
    force_language: bool,
    engine: str | None,
    cleanup: bool,
    progress: Callable[[int, int], None] | None = None,
) -> list[Item]:
    items: list[Item] = []
    for index, utterance in enumerate(utterances):
        hypothesis, latency, model, detected, words = utterance.text, None, None, utterance.language, None
        if utterance.audio is not None:
            if speech is None:
                raise RuntimeError("audio sets need the speech server (python -m pip_speech in speech-server/)")
            result, latency = speech.transcribe(utterance.audio.read_bytes(), languages, utterance.language if force_language else None, engine)
            hypothesis, model, detected, words = result.get("text", ""), result.get("model"), result.get("language") or utterance.language, result.get("words")
        final = None
        if backend is not None and (cleanup or utterance.final is not None):
            cleaned, cleanup_latency = backend.cleanup(hypothesis, detected, utterance.app, words)
            final = cleaned.get("text", "")
            latency = (latency or 0.0) + cleanup_latency
        items.append(Item(utterance.id, utterance.language, utterance.text, hypothesis, utterance.final, final, utterance.tags, latency, model))
        if progress:
            progress(index + 1, len(utterances))
    return items


def markdown(report: dict[str, Any], title: str) -> str:
    lines = [f"# {title}", ""]
    metrics = ["utterances", "wer", "cer", "final_wer", "zero_edit_rate", "command_accuracy", "filler_leak_rate", "hallucinated_word_rate", "entity_accuracy", "latency_p50", "latency_p95"]
    for set_name, body in report["sets"].items():
        if isinstance(body, str):
            lines += [f"## {set_name}", "", f"skipped: {body}", ""]
            continue
        lines += [f"## {set_name}", "", "| scope | " + " | ".join(metrics) + " |", "|" + " --- |" * (len(metrics) + 1)]
        for scope, values in [("overall", body["overall"]), *body["languages"].items()]:
            cells = []
            for metric in metrics:
                value = values.get(metric)
                target = TARGETS.get(scope, {}).get(metric) or TARGETS.get(set_name, {}).get(metric) or TARGETS["dictation"].get(metric) or TARGETS["latency"].get(metric)
                mark = {True: " ✓", False: " ✗", None: ""}[check(metric, value, target)] if target is not None and isinstance(value, float) else ""
                cells.append("" if value is None else f"{value}{mark}")
            lines.append(f"| {scope} | " + " | ".join(cells) + " |")
        lines.append("")
        failures = body.get("failures", [])[:10]
        if failures:
            lines += ["Typed text that differs from what was meant (first 10):", ""]
            lines += [f"- `{failure['id']}`: expected `{failure['reference']}`, got `{failure['got']}`" for failure in failures]
            lines.append("")
    return "\n".join(lines)


def write_report(report: dict[str, Any], name: str, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stem = directory / f"{dt.datetime.now():%Y-%m-%d-%H%M}-{name}"
    stem.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    stem.with_suffix(".md").write_text(markdown(report, name), encoding="utf-8")
    return stem.with_suffix(".md")


# --- bake-off ---------------------------------------------------------------------

def bakeoff(sets: dict[str, list[Utterance]], speech: SpeechClient, languages: list[str], routing_path: Path) -> dict[str, Any]:
    """Every usable engine on every language's audio; reorders routing chains by measured WER."""
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    usable = {engine_id for engine_id, info in speech.health().get("engines", {}).items() if info.get("usable")}
    by_language: dict[str, list[Utterance]] = {}
    for utterances in sets.values():
        for utterance in utterances:
            if utterance.audio is not None:
                by_language.setdefault(utterance.language, []).append(utterance)
    results: dict[str, dict[str, Any]] = {}
    for language, utterances in by_language.items():
        candidates = [engine_id for engine_id in usable if _serves(routing["engines"][engine_id], language)]
        results[language] = {}
        for engine_id in sorted(candidates):
            try:
                items = run_items(utterances, speech, None, languages, True, engine_id, False)
            except Exception as error:
                results[language][engine_id] = {"error": str(error)}
                continue
            results[language][engine_id] = score(items)["overall"]
        ranked = sorted((engine for engine, value in results[language].items() if "wer" in value), key=lambda engine: results[language][engine]["wer"])
        if not ranked:
            continue
        route = routing["routes"].setdefault(language, json.loads(json.dumps(routing["routes"].get("*", {}))))
        best = results[language][ranked[0]]["wer"]
        fast = sorted((engine for engine in ranked if results[language][engine]["wer"] <= best + 0.03), key=lambda engine: results[language][engine].get("latency_p50", 9e9))
        route["final"] = ranked + [engine for engine in route.get("final", []) if engine not in ranked]
        route["partial"] = fast[:1] + [engine for engine in route.get("partial", []) if engine not in fast[:1]]
        route["second"] = ranked[1:2] + [engine for engine in route.get("second", []) if engine not in ranked[1:2]]
    routing["_bakeoff"] = {"at": dt.datetime.now().isoformat(timespec="seconds"), "results": results}
    return routing


def _serves(config: dict[str, Any], language: str) -> bool:
    languages = config.get("languages") or ["*"]
    return "*" in languages or language in languages


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", default="dictation", help="set or group names, comma-separated (datasets.yaml)")
    parser.add_argument("--languages", default=",".join(DEFAULT_LANGUAGES), help="languages Pip may detect between")
    parser.add_argument("--force-language", action="store_true", help="tell the speech server each clip's language (no LID)")
    parser.add_argument("--config", default="pip-default", help="pip-default, or engine=<id> to force one model")
    parser.add_argument("--cleanup", action="store_true", help="also run the cleanup layer on every clip")
    parser.add_argument("--limit", type=int, default=0, help="first N utterances per set")
    parser.add_argument("--bakeoff", action="store_true", help="rank every installed engine per language and write speech-routing.json")
    parser.add_argument("--reports", default=str(ROOT / "reports"))
    args = parser.parse_args(argv)

    config = load_config()
    names = expand(args.set.split(","), config)
    languages = args.languages.split(",")
    engine = args.config.split("=", 1)[1] if args.config.startswith("engine=") else None
    loaded: dict[str, list[Utterance] | str] = {name: load_set(name, config) for name in names}
    for name, value in loaded.items():
        if isinstance(value, list) and args.limit:
            loaded[name] = value[: args.limit]
        print(f"{name}: {len(value) if isinstance(value, list) else value}")
    needs_audio = any(isinstance(value, list) and any(item.audio for item in value) for value in loaded.values())
    speech = SpeechClient() if needs_audio else None
    backend = BackendClient()

    if args.bakeoff:
        if speech is None:
            print("the bake-off needs audio sets")
            return 1
        routing = bakeoff({name: value for name, value in loaded.items() if isinstance(value, list)}, speech, languages, ROOT.parent / "speech-server" / "routing.json")
        target = state_dir() / "speech-routing.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(routing, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(routing["_bakeoff"]["results"], indent=2))
        print(f"wrote {target}; restart Pip (or the speech server) to use it")
        return 0

    report: dict[str, Any] = {"config": args.config, "languages": languages, "sets": {}}
    for name, value in loaded.items():
        if isinstance(value, str):
            report["sets"][name] = value
            continue
        items = run_items(value, speech, backend, languages, args.force_language, engine, args.cleanup, lambda done, total: print(f"\r  {name} {done}/{total}", end="", file=sys.stderr))
        print(file=sys.stderr)
        report["sets"][name] = score(items)
        report["sets"][name]["failures"] = [
            {"id": item.id, "reference": item.final_reference or item.reference, "got": item.final if item.final is not None else item.hypothesis}
            for item in items
            if (item.final_reference is not None and item.final is not None and item.final.strip().rstrip(".।") != item.final_reference.strip().rstrip(".।"))
        ][:50]
    path = write_report(report, f"{args.config}-{args.set.replace(',', '+')}", Path(args.reports))
    print(path.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
