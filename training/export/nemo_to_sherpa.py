"""Exports a NeMo ASR checkpoint (SraVaani, IndicConformer, Parakeet, your fine-tunes)
to the ONNX layout sherpa-onnx loads. The speech server runs it on the GPU (or CPU)
with no NeMo install. Follows sherpa-onnx's scripts/nemo exporters (Apache-2.0).

    python -m export.nemo_to_sherpa runs/sravaani-south-v1/model.nemo --out runs/sravaani-south-v1/onnx [--ctc]

Default: the transducer (TDT/RNNT) branch, giving encoder/decoder/joiner(.int8).onnx and
tokens.txt. --ctc exports the CTC head instead (model(.int8).onnx), for fast live text.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def add_meta_data(filename: Path, meta_data: dict) -> None:
    import onnx

    model = onnx.load(str(filename))
    while len(model.metadata_props):
        model.metadata_props.pop()
    for key, value in meta_data.items():
        entry = model.metadata_props.add()
        entry.key = key
        entry.value = str(value)
    if filename.name.startswith("encoder") and not filename.name.endswith("int8.onnx"):
        onnx.save(model, str(filename), save_as_external_data=True, all_tensors_to_one_file=True, location="encoder.weights")
    else:
        onnx.save(model, str(filename))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("checkpoint")
    parser.add_argument("--out", required=True)
    parser.add_argument("--ctc", action="store_true")
    args = parser.parse_args()

    import nemo.collections.asr as nemo_asr
    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model = nemo_asr.models.ASRModel.restore_from(args.checkpoint, map_location="cpu")
    model.eval()
    os.chdir(out)

    vocabulary = model.joint.vocabulary if hasattr(model, "joint") and not args.ctc else model.decoder.vocabulary
    with open("tokens.txt", "w", encoding="utf-8") as handle:
        for index, token in enumerate(vocabulary):
            handle.write(f"{token} {index}\n")
        handle.write(f"<blk> {len(vocabulary)}\n")

    normalize_type = model.cfg.preprocessor.get("normalize", "")
    normalize_type = "" if normalize_type == "NA" else normalize_type
    subsampling = int(model.cfg.encoder.get("subsampling_factor", 8))
    feat_dim = int(model.cfg.preprocessor.get("features", 80))
    with torch.no_grad():
        if args.ctc:
            if hasattr(model, "change_decoding_strategy"):
                try:
                    model.change_decoding_strategy(decoder_type="ctc")
                except TypeError:
                    pass
            model.set_export_config({"decoder_type": "ctc"})
            model.export("model.onnx")
            meta = {"vocab_size": len(vocabulary), "normalize_type": normalize_type, "subsampling_factor": subsampling, "model_type": "EncDecHybridRNNTCTCBPEModel", "version": "1", "model_author": "NeMo", "comment": "CTC branch, exported by Pip", "feat_dim": feat_dim}
            add_meta_data(Path("model.onnx"), meta)
            quantize_dynamic(model_input="model.onnx", model_output="model.int8.onnx", weight_type=QuantType.QUInt8)
        else:
            if hasattr(model, "set_export_config"):
                model.set_export_config({"decoder_type": "rnnt"})
            model.encoder.export("encoder.onnx")
            model.decoder.export("decoder.onnx")
            model.joint.export("joiner.onnx")
            meta = {
                "vocab_size": model.decoder.vocab_size,
                "normalize_type": normalize_type,
                "pred_rnn_layers": model.decoder.pred_rnn_layers,
                "pred_hidden": model.decoder.pred_hidden,
                "subsampling_factor": subsampling,
                "model_type": "EncDecRNNTBPEModel",
                "version": "2",
                "model_author": "NeMo",
                "comment": "Transducer branch, exported by Pip",
                "feat_dim": feat_dim,
            }
            for name in ["encoder", "decoder", "joiner"]:
                quantize_dynamic(model_input=f"{name}.onnx", model_output=f"{name}.int8.onnx", weight_type=QuantType.QUInt8 if name == "encoder" else QuantType.QInt8)
            add_meta_data(Path("encoder.int8.onnx"), meta)
            add_meta_data(Path("encoder.onnx"), meta)
    print(f"exported to {out}: {sorted(path.name for path in out.iterdir())}")


if __name__ == "__main__":
    main()
