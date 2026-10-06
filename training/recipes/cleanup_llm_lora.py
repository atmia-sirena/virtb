"""Recipe C: the cleanup LLM. A LoRA on Qwen3-8B, trained on edit-op examples from
data/cleanup_pairs.py:

- DISCO for English/Hindi disfluencies;
- synthetic pairs in all six languages;
- Hinglish.

It's then served by Ollama as `pip-cleanup`, so the backend needs no change.

    uv sync --extra llm
    python -m data.cleanup_pairs --pairs data/disco.jsonl <eval data>/pip-dictation-train/scripts.jsonl --out mix/cleanup-v1.jsonl
    python -m recipes.cleanup_llm_lora --data mix/cleanup-v1.jsonl --out runs/cleanup-v1
    # GGUF + Ollama (llama.cpp's converter, MIT):
    python llama.cpp/convert_hf_to_gguf.py runs/cleanup-v1/merged --outtype q8_0 --outfile runs/cleanup-v1/pip-cleanup.gguf
    ollama create pip-cleanup -f runs/cleanup-v1/Modelfile

Then score `python ../eval/run.py --set cleanup-seeds,pip-dictation --cleanup` against the base model before keeping it.

Settings:

- LoRA r=32, alpha=64, dropout 0.05, on every linear layer;
- lr 1e-4, 2 epochs, effective batch 64, sequences up to 2048 tokens;
- the loss is on the assistant's JSON only;
- thinking stays off in the chat template, as at inference (think: false).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

MODELFILE = """# Pip's fine-tuned dictation cleanup model (Qwen3-8B + LoRA, merged). Returns edit ops as JSON.
FROM ./pip-cleanup.gguf
PARAMETER num_ctx 8192
PARAMETER temperature 0
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True)
    parser.add_argument("--base", default="Qwen/Qwen3-8B")
    parser.add_argument("--out", required=True)
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--rank", type=int, default=32)
    args = parser.parse_args()

    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    out = Path(args.out)
    rows = [json.loads(line) for line in Path(args.data).read_text(encoding="utf-8").splitlines() if line.strip()]
    tokenizer = AutoTokenizer.from_pretrained(args.base)

    def render(example):
        # Prompt = the chat up to the assistant turn, exactly as Ollama renders it with think=false
        # (an empty think block); completion = the edit-op JSON. Loss is on the completion only.
        messages = example["messages"]
        prompt = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        return {"prompt": prompt, "completion": messages[-1]["content"] + "<|im_end|>"}

    dataset = Dataset.from_list(rows).map(render, remove_columns=[column for column in rows[0] if column != "language"])
    split = dataset.train_test_split(test_size=min(0.02, 200 / max(len(rows), 1)), seed=7)
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.bfloat16, attn_implementation="sdpa")
    config = SFTConfig(
        output_dir=str(out / "adapter"),
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=8,
        gradient_accumulation_steps=8,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        logging_steps=20,
        eval_strategy="steps",
        eval_steps=200,
        save_steps=400,
        save_total_limit=3,
        max_length=2048,
        completion_only_loss=True,
        dataset_kwargs={"add_special_tokens": False},
        report_to=[],
    )
    lora = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")
    trainer = SFTTrainer(model=model, args=config, train_dataset=split["train"], eval_dataset=split["test"], peft_config=lora, processing_class=tokenizer)
    trainer.train()
    trainer.save_model(str(out / "adapter"))

    merged = trainer.model.merge_and_unload()
    merged.save_pretrained(str(out / "merged"), safe_serialization=True)
    tokenizer.save_pretrained(str(out / "merged"))
    (out / "Modelfile").write_text(MODELFILE, encoding="utf-8")
    print(f"merged model -> {out / 'merged'}; convert to GGUF and `ollama create pip-cleanup -f {out / 'Modelfile'}`")


if __name__ == "__main__":
    main()
