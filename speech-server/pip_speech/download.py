"""Downloads the open models the speech server routes to, into the models
folder the backend uses (%APPDATA%\\Pip\\models). Run on your PC:

    uv run python -m pip_speech.download            # recommended set for your languages
    uv run python -m pip_speech.download --all      # everything in routing.json
    uv run python -m pip_speech.download qwen3-asr-1.7b indicconformer-rnnt

Gated Hugging Face repos need `huggingface-cli login` (a free account; the
token stays on your PC). Nothing here needs an API key.
"""

from __future__ import annotations

import argparse
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from .paths import models_dir
from .registry import load_routing

SHERPA_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

# Recommended set for English + Hindi/Hinglish + Tamil/Telugu/Punjabi on one GPU (~12 GB on disk).
RECOMMENDED = ["qwen3-asr-1.7b", "qwen3-asr-0.6b", "indicconformer-rnnt", "whisper-large-v3", "parakeet-v2", "omnilingual-300m"]

# Engines whose weights aren't on the Hub under the id in routing.json.
MANUAL = {
    "sravaani": "Download SraVaani-1.0 (IISc/ARTPARK, MIT) from its model page and save the .nemo file as models/sravaani-1.0.nemo, "
    "or export it to ONNX with training/export/nemo_to_sherpa.py into models/sravaani-1.0-onnx.",
    "indicwhisper-hi": "Get the IndicWhisper Hindi checkpoint (MIT) from github.com/AI4Bharat/vistaar, then: "
    "ct2-transformers-converter --model <checkpoint folder> --output_dir models/indicwhisper-hi-ct2 --quantization float16",
    "shunya-hinglish": "Get Shunya Labs' zero-stt-hinglish checkpoint (OpenRAIL-M) from its model page, then: "
    "ct2-transformers-converter --model <checkpoint folder> --output_dir models/shunya-zero-stt-hinglish-ct2 --quantization float16",
}


def download_hub(repo_id: str, target: Path) -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=repo_id, local_dir=str(target))


def download_sherpa(folder: str, target_root: Path) -> None:
    url = f"{SHERPA_RELEASES}/{folder}.tar.bz2"
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / f"{folder}.tar.bz2"
        print(f"  {url}")
        with urllib.request.urlopen(url) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        with tarfile.open(archive) as bundle:
            bundle.extractall(target_root, filter="data")


def fetch(engine_id: str, config: dict, root: Path) -> str:
    if engine_id in MANUAL:
        return f"manual: {MANUAL[engine_id]}"
    reference = config.get("model", "")
    if config["kind"] == "fake":
        return "skipped"
    if config["kind"] == "sherpa":
        if (root / reference).exists():
            return "already there"
        download_sherpa(reference, root)
        return "downloaded"
    if "/" in reference:
        target = root / reference
        if target.exists() and any(target.iterdir()):
            return "already there"
        download_hub(reference, target)
        return "downloaded"
    return f"manual: put the model in {root / reference}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("engines", nargs="*")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()
    routing = load_routing()
    root = models_dir()
    root.mkdir(parents=True, exist_ok=True)
    wanted = list(routing["engines"]) if args.all else (args.engines or RECOMMENDED)
    seen: set[str] = set()
    for engine_id in wanted:
        config = routing["engines"].get(engine_id)
        if config is None:
            print(f"{engine_id}: not in routing.json")
            continue
        # Several engines share one checkpoint (IndicConformer CTC/RNNT).
        key = f"{config['kind']}:{config.get('model')}"
        if key in seen:
            continue
        seen.add(key)
        print(f"{engine_id}:")
        try:
            print(f"  {fetch(engine_id, config, root)}")
        except Exception as error:
            print(f"  failed: {error}")


if __name__ == "__main__":
    main()
