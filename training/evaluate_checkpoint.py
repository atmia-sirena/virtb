"""Scores a fine-tuned checkpoint on the held-out eval sets, without the speech
server, and applies the ship rule: beat the champion on the target languages
and lose no more than 0.5 WER points on any other.

    python -m evaluate_checkpoint runs/qwen3-asr-india-v1/checkpoint-36000 --sets hindi,south,punjabi,english
    python -m evaluate_checkpoint runs/... --kind nemo --sets south --baseline ../eval/reports/<champion>.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "eval"))

from pip_eval.manifest import expand, load_config, load_set  # noqa: E402
from pip_eval.metrics import Item, score  # noqa: E402

QWEN_FORCE = {"en": "English", "hi": "Hindi"}


def transcriber(kind: str, checkpoint: str):
    import numpy as np
    import soundfile

    if kind == "qwen":
        import torch
        from qwen_asr import Qwen3ASRModel

        model = Qwen3ASRModel.from_pretrained(checkpoint, dtype=torch.bfloat16, device_map="cuda:0", max_new_tokens=448)

        def run(path: Path, language: str) -> str:
            audio, _ = soundfile.read(path, dtype="float32")
            return model.transcribe(audio=(audio, 16000), language=QWEN_FORCE.get(language))[0].text

        return run
    import nemo.collections.asr as nemo_asr

    model = nemo_asr.models.ASRModel.restore_from(checkpoint, map_location="cuda")
    model.eval()

    def run(path: Path, language: str) -> str:
        audio, _ = soundfile.read(path, dtype="float32")
        output = model.transcribe([np.asarray(audio, dtype=np.float32)], batch_size=1)
        hypothesis = output[0][0] if isinstance(output, tuple) else output[0]
        return getattr(hypothesis, "text", str(hypothesis))

    return run


def ship_decision(candidate: dict, baseline: dict, targets: set[str]) -> tuple[bool, list[str]]:
    reasons, improved = [], False
    for language, values in candidate.items():
        before = baseline.get(language, {}).get("wer")
        if before is None:
            continue
        change = values["wer"] - before
        if language in targets and change < 0:
            improved = True
        if change > 0.005:
            reasons.append(f"{language}: WER {before:.3f} -> {values['wer']:.3f} (regression > 0.5 points)")
    if not improved:
        reasons.append("no target language improved")
    return (improved and not any("regression" in reason for reason in reasons)), reasons


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("checkpoint")
    parser.add_argument("--kind", choices=["qwen", "nemo"], default="qwen")
    parser.add_argument("--sets", default="hindi,south,punjabi,english")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--baseline", help="a previous report from this script or eval/run.py (per-language WER)")
    parser.add_argument("--targets", default="hi,hinglish,ta,te,pa,en")
    parser.add_argument("--personal-held-out", help="held_out.jsonl from recipes/personal_adapt.py (clips never trained on)")
    args = parser.parse_args()

    run = transcriber(args.kind, args.checkpoint)
    config = load_config()
    items: list[Item] = []
    for name in expand(args.sets.split(","), config):
        utterances = load_set(name, config)
        if isinstance(utterances, str):
            print(f"{name}: {utterances}")
            continue
        for utterance in utterances[: args.limit or None]:
            if utterance.audio is not None:
                items.append(Item(utterance.id, utterance.language, utterance.text, run(utterance.audio, utterance.language)))
    if args.personal_held_out:
        from data.common import read_jsonl, state_dir

        personal = state_dir() / "eval" / "personal"
        for clip in read_jsonl(Path(args.personal_held_out)):
            language = clip.get("language", "en").split("-")[0] if clip.get("language") != "hinglish" else "hinglish"
            items.append(Item(clip["id"], language, clip["reference"], run(personal / clip["audio"], language)))
    report = score(items)
    out = Path(args.checkpoint) / "eval.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    for language, values in report["languages"].items():
        print(f"{language}: WER {values['wer']:.3f}  CER {values['cer']:.3f}  ({values['utterances']} utterances)")
    if args.baseline:
        baseline_report = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        baseline = baseline_report.get("languages") or next((body["languages"] for body in baseline_report.get("sets", {}).values() if isinstance(body, dict)), {})
        ok, reasons = ship_decision(report["languages"], baseline, set(args.targets.split(",")))
        print("SHIP" if ok else "DON'T SHIP", *reasons, sep="\n  ")


if __name__ == "__main__":
    main()
