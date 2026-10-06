"""Test sets as manifests: one JSON line per utterance.

{"id": "...", "audio": "clip.wav", "text": "verbatim transcript", "language": "hi",
 "final": "what Pip should type (optional)", "tags": ["command", "entity", ...]}
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]


def state_dir() -> Path:
    if os.environ.get("PIP_STATE_DIR"):
        return Path(os.environ["PIP_STATE_DIR"])
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "Pip"
    return Path.home() / ".config" / "pip"


def data_dir() -> Path:
    return Path(os.environ["PIP_EVAL_DATA"]) if os.environ.get("PIP_EVAL_DATA") else state_dir() / "eval" / "data"


@dataclass
class Utterance:
    id: str
    language: str
    text: str
    audio: Path | None = None
    final: str | None = None
    tags: list[str] = field(default_factory=list)
    app: str | None = None


def load_config(path: Path | None = None) -> dict[str, Any]:
    return yaml.safe_load((path or ROOT / "datasets.yaml").read_text(encoding="utf-8"))


def expand(names: list[str], config: dict[str, Any]) -> list[str]:
    output: list[str] = []
    for name in names:
        for member in config.get("groups", {}).get(name, [name]):
            if member not in output:
                output.append(member)
    return output


def manifest_path(name: str, spec: dict[str, Any]) -> Path:
    if spec.get("source") == "manifest":
        return Path(spec["path"].replace("{data}", str(data_dir())).replace("{state}", str(state_dir())))
    return data_dir() / name / "manifest.jsonl"


def read_manifest(path: Path, spec: dict[str, Any]) -> list[Utterance]:
    # prepare.py always writes "text"; hand-made manifests may name their own field.
    text_key = spec.get("text", "text") if spec.get("source") == "manifest" else "text"
    final_key = spec.get("final")
    items: list[Utterance] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        items.append(
            Utterance(
                id=str(row["id"]),
                language=row.get("language", spec.get("language", "en")),
                text=row.get(text_key) or row.get("text", ""),
                audio=(path.parent / row["audio"]) if row.get("audio") else None,
                final=row.get(final_key) if final_key else row.get("final"),
                tags=row.get("tags", []),
                app=row.get("app"),
            )
        )
    return items


def read_seeds() -> list[Utterance]:
    items: list[Utterance] = []
    for path in sorted((ROOT / "seeds").glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                items.append(Utterance(id=f"{path.stem}-{row['id']}", language=row["language"], text=row["spoken"], final=row["final"], tags=row.get("tags", []), app=row.get("app")))
    return items


def load_set(name: str, config: dict[str, Any]) -> list[Utterance] | str:
    """Utterances, or a string explaining why the set isn't available yet."""
    spec = config["sets"].get(name)
    if spec is None:
        return f"unknown set {name}"
    if spec["source"] == "seeds":
        return read_seeds()
    if spec["source"] == "manual":
        path = data_dir() / name / "manifest.jsonl"
        return read_manifest(path, spec) if path.exists() else f"manual set: {spec.get('note', '')} -> {path}"
    path = manifest_path(name, spec)
    if not path.exists():
        return f"not downloaded: python prepare.py {name}" if spec["source"] == "hf" else f"missing {path}"
    return read_manifest(path, spec)
