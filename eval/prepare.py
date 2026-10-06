"""Downloads public test sets into %APPDATA%\\Pip\\eval\\data\\<set>\\ as 16 kHz WAV + manifest.jsonl.

    uv run --extra data python prepare.py fleurs-hi fleurs-ta fleurs-te fleurs-pa
    uv run --extra data python prepare.py hindi --limit 500

Needs `huggingface-cli login` for gated sets (accept the terms on each dataset page first).
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import soundfile

from pip_eval.manifest import data_dir, expand, load_config


def prepare(name: str, spec: dict, limit: int) -> str:
    from datasets import Audio, load_dataset

    if spec.get("source") != "hf":
        return f"{name}: {spec.get('note', 'not a Hugging Face set')}"
    target = data_dir() / name
    target.mkdir(parents=True, exist_ok=True)
    try:
        dataset = load_dataset(spec["repo"], spec.get("config"), split=spec["split"], streaming=True)
    except Exception as error:  # wrong id/config/split, or terms not accepted
        hint = " (check the repo id/config/split on the dataset page; this entry is marked verify)" if spec.get("verify") else ""
        return f"{name}: couldn't load {spec['repo']} {spec.get('config') or ''} {spec['split']}: {error}{hint}"
    dataset = dataset.cast_column("audio", Audio(sampling_rate=16000))
    count = 0
    with (target / "manifest.jsonl").open("w", encoding="utf-8") as manifest:
        for index, row in enumerate(dataset):
            if limit and count >= limit:
                break
            text = row.get(spec.get("text", "text"))
            if not text:
                continue
            audio = row["audio"]
            file_name = f"{index:06d}.wav"
            soundfile.write(target / file_name, np.asarray(audio["array"], dtype=np.float32), 16000)
            manifest.write(json.dumps({"id": f"{name}-{index}", "audio": file_name, "text": text, "language": spec["language"]}, ensure_ascii=False) + "\n")
            count += 1
    return f"{name}: {count} utterances -> {target}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sets", nargs="+")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    config = load_config()
    for name in expand(args.sets, config):
        spec = config["sets"].get(name)
        print(prepare(name, spec, args.limit) if spec else f"{name}: unknown")


if __name__ == "__main__":
    main()
