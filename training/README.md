# Training Pip's speech for Indian languages

Everything here runs on your PC: one RTX PRO 6000 Blackwell (96 GB), open data, open models, and no API keys. The eval harness (`../eval`) decides what ships. A model is installed only if it beats the current champion on its target languages and costs no other language more than 0.5 WER points.

## Order of work

| Step | What | Command | Time on the 96 GB card |
| --- | --- | --- | --- |
| 0 | Baseline every installed model | `cd ../eval && uv run python run.py --bakeoff --set english,hindi,south,punjabi` | ~2 h |
| 1 | Download and filter training data | `uv run --extra data python -m data.prepare_asr --all --check-wer` | ~1 day (network bound) |
| 2 | Synthetic dictation for training | `cd ../eval && python generate_dictation_set.py scripts --split train` then `voice`, `augment` | ~half a day |
| 3 | Romanize Hinglish targets | `python -m data.hinglish_targets <mucs manifest> --out <...>.roman.jsonl` | minutes |
| 4 | Build the mix | `python -m data.mix --out mix/india-v1` | minutes |
| 5 | **A: Qwen3-ASR-1.7B full fine-tune** | `uv sync --extra qwen && python -m recipes.qwen3_asr_finetune --mix mix/india-v1 --out runs/qwen3-asr-india-v1` | 1.5-3 days |
| 6 | Score, install if it ships | `python -m evaluate_checkpoint runs/.../checkpoint-N --baseline <champion report>` then `python -m export.install_model qwen ...` | ~2 h |
| 7 | **B: SraVaani for Tamil, Telugu, Punjabi** | `uv sync --extra nemo && python -m recipes.sravaani_finetune ...`, then `export.nemo_to_sherpa`, `export.install_model sherpa` | ~1 day |
| 8 | **C: cleanup LLM** | `python -m data.cleanup_pairs ...` (backend running), `uv sync --extra llm && python -m recipes.cleanup_llm_lora ...`, then GGUF and `ollama create pip-cleanup` | ~6 h |
| 9 | Bake-off again | `cd ../eval && uv run python run.py --bakeoff ...` | ~2 h |
| 10 | **D: your voice** (after 100+ clips in Home) | `python -m recipes.personal_adapt --base <champion> --replay mix/india-v1 --out runs/personal-<month>` | ~1 h |

The `qwen`, `nemo` and `llm` extras pin different `transformers` versions. Install one at a time with `uv sync --extra <name>`, or keep three venvs.

## The mix (`sources.yaml`, about 6.5k hours)

| Language | Hours | From |
| --- | --- | --- |
| Hindi | ~1,900 | IndicVoices, Kathbath, Shrutilipi, FLEURS |
| Tamil | ~1,100 | IndicVoices, Kathbath, FLEURS |
| Telugu | ~1,100 | IndicVoices, Kathbath, FLEURS |
| Punjabi | ~700 | IndicVoices, Kathbath, FLEURS |
| Indian English | ~400 | IndicVoices English (or Common Voice, Indian accents) |
| Hinglish | ~90 + synthetic | MUCS 2021 with romanized targets |
| Synthetic dictation, all languages | ~300 | `generate_dictation_set.py --split train`: fillers, corrections, names, ₹, emails; noisy rooms |

Licenses are CC-BY-4.0 for the AI4Bharat and Google sets. Test splits (`../eval/datasets.yaml`) are never trained on, and the synthetic train split uses other topics and speaker descriptions than the eval split.

20% of Qwen rows carry a context prompt ("Names and terms that may appear: …") with real names from the transcript plus distractors. The speech server sends your dictionary in the same form, so the model learns to use it without copying it blindly.

## Recipes

| Recipe | Base | Why |
| --- | --- | --- |
| A: `qwen3_asr_finetune.py` | Qwen3-ASR-1.7B (Apache-2.0) | One model for code-switching that takes context. Already strong at Hindi and English; fine-tuning adds Tamil, Telugu and Punjabi and romanized Hinglish. Uses Alibaba's official SFT script (`third_party/`). lr 2e-5, 2 epochs, batch 128. |
| B: `sravaani_finetune.py` | SraVaani-1.0 (MIT) or IndicConformer (MIT) | The best open models on most Indic test sets. Becomes the Tamil, Telugu and Punjabi final pass wherever it beats A. Its CTC head gives fast live text. |
| C: `cleanup_llm_lora.py` | Qwen3-8B (Apache-2.0) | Trained on edit-op JSON, so its output can never add words. Uses DISCO plus synthetic pairs in every language. |
| D: `personal_adapt.py` | the current A champion | Your accent and vocabulary: 3× your clips plus replay data, lr 1e-5, checked on held-out clips. |

## What "done" means

See `../eval/README.md` for targets:

- Hindi and Svarah WER ≤ 8%; Hinglish ≤ 12%; Tamil and Telugu ≤ 15%; Punjabi ≤ 12%;
- zero-edit ≥ 90%; command accuracy ≥ 95%; latency p50 ≤ 0.7 s.

Run the Wispr Flow comparison (`../eval/wispr_compare.md`) on the same clips to check the "as good as Wispr" claim per language.
