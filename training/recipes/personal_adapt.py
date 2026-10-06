"""Recipe D: adapt to your voice. Runs a short fine-tune of the current Qwen3-ASR
champion on your Home recordings (%APPDATA%\\Pip\\eval\\personal), mixed with
replay data from the main mix so it doesn't forget anything else. A fifth of
your clips are held out to prove the gain.

    python -m recipes.personal_adapt --base runs/qwen3-asr-india-v1/checkpoint-36000 --replay mix/india-v1 --out runs/personal-2026-10

Home's "Improve with my voice" button can run this monthly. Audio never leaves the PC.

Settings:

- lr 1e-5;
- 3 epochs over the personal clips, which make up ~30% of the mix;
- needs about 100+ clips (around 15 minutes) to be worth it.
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path

from data.common import QWEN_LANGUAGE, read_jsonl, state_dir, write_jsonl

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", required=True, help="current champion checkpoint")
    parser.add_argument("--replay", required=True, help="a data/mix.py folder")
    parser.add_argument("--out", required=True)
    parser.add_argument("--min-clips", type=int, default=100)
    args = parser.parse_args()

    personal_dir = state_dir() / "eval" / "personal"
    clips = list(read_jsonl(personal_dir / "manifest.jsonl")) if (personal_dir / "manifest.jsonl").exists() else []
    if len(clips) < args.min_clips:
        raise SystemExit(f"{len(clips)} personal clips; record at least {args.min_clips} in Home -> Settings -> Languages first")
    rng = random.Random(11)
    rng.shuffle(clips)
    held_out = clips[: len(clips) // 5]
    train = clips[len(clips) // 5 :]
    out = Path(args.out)
    language = lambda code: QWEN_LANGUAGE.get(code.split("-")[0] if code != "hinglish" else code, "None")  # noqa: E731
    personal_rows = [{"audio": str(personal_dir / clip["audio"]), "text": f"language {language(clip.get('language', 'en'))}<asr_text>{clip['reference']}"} for clip in train]
    replay = list(read_jsonl(Path(args.replay) / "qwen_train.jsonl"))
    rng.shuffle(replay)
    replay = replay[: len(personal_rows) * 3 * 7 // 3]  # personal ~30% after 3x oversampling
    rows = personal_rows * 3 + replay
    rng.shuffle(rows)
    write_jsonl(out / "train.jsonl", rows)
    write_jsonl(out / "held_out.jsonl", held_out)
    (out / "README.txt").write_text(
        f"Compare before installing:\n  python -m evaluate_checkpoint {args.base} --sets english --personal-held-out {out / 'held_out.jsonl'}\n"
        f"  python -m evaluate_checkpoint {out / 'checkpoints'}/checkpoint-N --sets english --personal-held-out {out / 'held_out.jsonl'}\n",
        encoding="utf-8",
    )
    command = [
        sys.executable, str(ROOT / "third_party" / "qwen3_asr_sft.py"),
        "--model_path", args.base, "--train_file", str(out / "train.jsonl"), "--output_dir", str(out / "checkpoints"),
        "--batch_size", "16", "--grad_acc", "2", "--lr", "1e-5", "--epochs", "1", "--save_steps", "500", "--save_total_limit", "2",
    ]
    print(json.dumps({"personal_train": len(personal_rows), "held_out": len(held_out), "replay": len(replay)}))
    raise SystemExit(subprocess.call(command))


if __name__ == "__main__":
    main()
