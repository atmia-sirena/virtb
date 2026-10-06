"""Recipe A: one model for Indian English, Hindi, romanized Hinglish, Tamil, Telugu
and Punjabi. Full fine-tune of Qwen3-ASR-1.7B with Alibaba's official SFT script
(third_party/qwen3_asr_sft.py, Apache-2.0) on the data/mix.py mix.

    uv sync --extra qwen
    python -m data.mix --out mix/india-v1
    python -m recipes.qwen3_asr_finetune --mix mix/india-v1 --out runs/qwen3-asr-india-v1
    python -m evaluate_checkpoint runs/qwen3-asr-india-v1/checkpoint-XXXX --sets hindi,south,punjabi,english
    python -m export.install_model qwen runs/qwen3-asr-india-v1/checkpoint-XXXX

Defaults for one RTX PRO 6000 Blackwell (96 GB):

- batch 32 x grad-acc 4 = 128 utterances per step;
- lr 2e-5 (the official default), 2 epochs, since Tamil, Telugu and Punjabi are new languages for the model;
- bf16, with FlashAttention 2 if installed.

On ~6.5k hours that's ~36k steps, about 1.5-3 days. If memory runs out, use --batch 16 --grad-acc 8.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mix", required=True, help="folder from data/mix.py")
    parser.add_argument("--base", default="Qwen/Qwen3-ASR-1.7B", help="or a previous checkpoint to continue from")
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--grad-acc", type=int, default=4)
    parser.add_argument("--save-steps", type=int, default=2000)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--gpus", type=int, default=1)
    args = parser.parse_args()

    mix = Path(args.mix)
    command = [
        "--model_path", args.base,
        "--train_file", str(mix / "qwen_train.jsonl"),
        "--eval_file", str(mix / "qwen_dev.jsonl"),
        "--output_dir", args.out,
        "--batch_size", str(args.batch),
        "--grad_acc", str(args.grad_acc),
        "--lr", str(args.lr),
        "--epochs", str(args.epochs),
        "--log_steps", "20",
        "--save_strategy", "steps",
        "--save_steps", str(args.save_steps),
        "--save_total_limit", "6",
        "--warmup_ratio", "0.02",
        "--lr_scheduler_type", "cosine",
    ]
    if args.resume:
        command += ["--resume", "1"]
    script = str(ROOT / "third_party" / "qwen3_asr_sft.py")
    launcher = [sys.executable, script] if args.gpus == 1 else ["torchrun", f"--nproc_per_node={args.gpus}", script]
    env = {**os.environ, "TOKENIZERS_PARALLELISM": "false"}
    print(" ".join(launcher + command))
    raise SystemExit(subprocess.call(launcher + command, env=env))


if __name__ == "__main__":
    main()
