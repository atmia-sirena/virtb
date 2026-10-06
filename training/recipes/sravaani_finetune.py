"""Recipe B: the Indic specialist. Fine-tunes SraVaani-1.0 (IISc/ARTPARK, MIT,
FastConformer hybrid TDT-CTC) or IndicConformer (.nemo) on Tamil, Telugu and
Punjabi (and any other Indian languages in the mix). It becomes the final pass
wherever it beats recipe A, and its CTC head gives fast live text.

    uv sync --extra nemo
    python -m data.mix --out mix/south-v1 --languages ta,te,pa
    python -m recipes.sravaani_finetune --base models/sravaani-1.0.nemo --mix mix/south-v1 --out runs/sravaani-south-v1
    python -m evaluate_checkpoint runs/sravaani-south-v1/model.nemo --kind nemo --sets south,punjabi
    python -m export.nemo_to_sherpa runs/sravaani-south-v1/model.nemo --out runs/sravaani-south-v1/onnx
    python -m export.install_model sherpa runs/sravaani-south-v1/onnx

The tokenizer is kept as is, since SraVaani's covers the Indic scripts. Settings:

- AdamW, lr 1e-4, cosine with 2k warmup steps;
- bf16, 60k steps at batch 64 x grad-acc 2 (~1 day on the 96 GB card);
- utterances capped at 25 s;
- validation WER every 2k steps; the best checkpoint is kept.
"""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", required=True, help=".nemo checkpoint (SraVaani-1.0, IndicConformer) or an NGC/HF model name")
    parser.add_argument("--mix", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--steps", type=int, default=60000)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--grad-acc", type=int, default=2)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--max-duration", type=float, default=25.0)
    args = parser.parse_args()

    import lightning.pytorch as pl
    import nemo.collections.asr as nemo_asr
    from lightning.pytorch.callbacks import LearningRateMonitor, ModelCheckpoint
    from omegaconf import OmegaConf, open_dict

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    mix = Path(args.mix)
    if args.base.endswith(".nemo"):
        model = nemo_asr.models.ASRModel.restore_from(args.base)
    else:
        model = nemo_asr.models.ASRModel.from_pretrained(args.base)

    def data(manifest: Path, shuffle: bool) -> dict:
        return {
            "manifest_filepath": str(manifest),
            "sample_rate": 16000,
            "batch_size": args.batch if shuffle else 16,
            "shuffle": shuffle,
            "num_workers": 8,
            "pin_memory": True,
            "max_duration": args.max_duration,
            "min_duration": 0.3,
            "trim_silence": False,
            "use_start_end_token": False,
        }

    with open_dict(model.cfg):
        model.cfg.train_ds = OmegaConf.create(data(mix / "nemo_train.json", True))
        model.cfg.validation_ds = OmegaConf.create(data(mix / "nemo_dev.json", False))
        model.cfg.optim = OmegaConf.create(
            {"name": "adamw", "lr": args.lr, "betas": [0.9, 0.98], "weight_decay": 1e-3, "sched": {"name": "CosineAnnealing", "warmup_steps": 2000, "min_lr": 1e-6}}
        )
        # Light SpecAugment keeps it robust to noisy rooms without slowing convergence.
        if "spec_augment" in model.cfg and model.cfg.spec_augment is not None:
            model.cfg.spec_augment.freq_masks = 2
            model.cfg.spec_augment.time_masks = 10
    model.setup_training_data(model.cfg.train_ds)
    model.setup_multiple_validation_data(model.cfg.validation_ds)
    model.setup_optimization(model.cfg.optim)

    checkpoint = ModelCheckpoint(dirpath=out / "checkpoints", monitor="val_wer", mode="min", save_top_k=3, every_n_train_steps=2000)
    trainer = pl.Trainer(
        devices=1,
        accelerator="gpu",
        precision="bf16-mixed",
        max_steps=args.steps,
        accumulate_grad_batches=args.grad_acc,
        val_check_interval=2000,
        check_val_every_n_epoch=None,
        gradient_clip_val=1.0,
        log_every_n_steps=50,
        callbacks=[checkpoint, LearningRateMonitor()],
        default_root_dir=str(out),
        enable_checkpointing=True,
        logger=pl.loggers.CSVLogger(str(out / "logs")),
    )
    model.set_trainer(trainer)
    trainer.fit(model)
    if checkpoint.best_model_path:
        model = type(model).load_from_checkpoint(checkpoint.best_model_path)
    model.save_to(str(out / "model.nemo"))
    print(f"saved {out / 'model.nemo'} (best val WER {checkpoint.best_model_score})")


if __name__ == "__main__":
    main()
