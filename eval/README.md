# Pip dictation benchmarks

This measures every change to Pip's speech stack: models, routing, cleanup rules, prompts and fine-tunes. A change ships only if it beats the current champion on its target set and costs no other language more than 0.5 WER.

```powershell
cd eval
uv sync --extra data --extra dev
uv run python prepare.py fleurs-hi fleurs-ta fleurs-te fleurs-pa fleurs-en --limit 400   # public test sets
uv run python run.py --set cleanup-seeds            # cleanup layer only (needs Pip's backend running)
uv run python run.py --set hindi,south,punjabi --force-language   # speech models (needs the speech server)
uv run python run.py --set dictation --cleanup      # the whole pipeline, Wispr-style metrics
uv run python run.py --bakeoff --set english,hindi,south,punjabi  # rank every installed model per language
uv run pytest
```

Reports go to `eval/reports/<date>-<config>-<sets>.md` (and `.json`), with each target marked ✓ or ✗.

## Metrics

| Metric | Meaning | Target |
| --- | --- | --- |
| `wer`, `cer` | errors against what was said. Punctuation and case are ignored. Nukta, chandrabindu and Indic digits are folded. Romanized Hinglish is spelling-tolerant. | Svarah ≤ 8%, Hindi ≤ 8%, Hinglish ≤ 12%, Tamil/Telugu ≤ 15% WER and ≤ 5% CER, Punjabi ≤ 12% |
| `zero_edit_rate` | typed text equals what should be typed (only a final full stop is ignored) | ≥ 90% |
| `command_accuracy` | zero-edit on items with "scratch that", corrections or spoken formatting | ≥ 95% |
| `filler_leak_rate` | outputs that still contain um/uh/hmm | ≤ 1% |
| `hallucinated_word_rate` | output words the speaker never said | ≤ 0.2% |
| `entity_accuracy` | numbers, ₹, times, emails and names typed exactly | — |
| `latency_p50/p95` | from audio sent to final text | ≤ 0.7 s / 1.5 s |

## Test sets (`datasets.yaml`)

| Set | Source | Use |
| --- | --- | --- |
| Svarah, FLEURS-en | AI4Bharat, Google | Indian-accented English |
| FLEURS, Kathbath, IndicVoices, Lahaja | Google, AI4Bharat | Hindi, Tamil, Telugu, Punjabi (Vistaar-style) |
| MUCS 2021, HiACC | challenge releases | Hinglish code-switching (manual download) |
| `pip-dictation` | `generate_dictation_set.py` | real dictation: fillers, corrections, commands, entities, noisy rooms |
| `personal` | Home → Record test set | your voice, your mic |
| `cleanup-seeds` | `seeds/*.jsonl` | the cleanup layer alone, every language, no audio |

Only test splits are used here. `training/` must never train on them; `generate_dictation_set.py --split train` makes a disjoint training set.

## Baseline (Oct 2026, cleanup rules only, no LLM)

`cleanup-seeds`, 41 utterances, scored with the backend's rules alone and the LLM pass unavailable:

- zero-edit 87.8%; command accuracy 86.4%; filler leaks 0; hallucinated words 0;
- Tamil, Telugu and Punjabi 100%.

The remaining misses are judgment calls that the qwen3:8b edit pass handles: "actually" and "matlab" corrections, context fillers like "like", and comma placement. Re-run this on your PC with Ollama up to get the full-pipeline number.

To compare with Wispr Flow, see `wispr_compare.md`.
