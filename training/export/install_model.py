"""Puts a trained model where the speech server's routing expects it
(routing.json lists these ids first for their languages, so they win once present):

    python -m export.install_model qwen runs/qwen3-asr-india-v1/checkpoint-36000   # -> models/pip-qwen3-asr-india
    python -m export.install_model sherpa runs/sravaani-south-v1/onnx              # -> models/pip-sravaani-india-onnx

The previous install is kept as <name>.previous so you can roll back by renaming it.
Restart Pip afterwards (or the speech server).
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from data.common import models_dir

TARGETS = {"qwen": "pip-qwen3-asr-india", "sherpa": "pip-sravaani-india-onnx"}


def install(kind: str, source: Path) -> Path:
    target = models_dir() / TARGETS[kind]
    previous = target.with_name(target.name + ".previous")
    if target.exists():
        if previous.exists():
            shutil.rmtree(previous)
        target.rename(previous)
    ignore = shutil.ignore_patterns("optimizer.pt", "scheduler.pt", "rng_state*.pth", "trainer_state.json", "training_args.bin")
    shutil.copytree(source, target, ignore=ignore)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("kind", choices=sorted(TARGETS))
    parser.add_argument("source")
    args = parser.parse_args()
    print(f"installed -> {install(args.kind, Path(args.source))}")


if __name__ == "__main__":
    main()
