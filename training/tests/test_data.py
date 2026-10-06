import json
import random

from data.cleanup_pairs import derive_ops, words_and_marks
from data.mix import CONTEXT_PREFIX, context_prompt, qwen_row


def test_ops_for_a_hinglish_correction():
    words, marks = words_and_marks("Kal meeting 5 baje hai matlab 6 baje hai.")
    ops = derive_ops(words, marks, "Kal meeting 6 baje hai.")
    assert ops == {"delete": [[2, 5]]}


def test_ops_for_punctuation_case_and_digits():
    words, marks = words_and_marks("send it to serena by twenty five march")
    ops = derive_ops(words, marks, "Send it to Serena by 25 March.")
    assert ops["capitalize"] == [0, 3, 7]
    assert ops["replace"] == [{"from": 5, "to": 6, "with": "25"}]
    assert ops["punctuation"] == [{"after": 7, "mark": "."}]


def test_pairs_that_need_new_words_are_dropped():
    words, marks = words_and_marks("kal aana")
    assert derive_ops(words, marks, "Kal zaroor aana.") is None
    assert derive_ops(words, marks, "Parso aana.") is None


def test_nothing_to_change_is_an_empty_object():
    words, marks = words_and_marks("Theek hai, kal milte hain.")
    assert derive_ops(words, marks, "Theek hai, kal milte hain.") == {}


def test_qwen_rows_carry_language_and_context():
    row = qwen_row({"audio": "a.wav", "text": "Rahul se baat karo", "language": "hinglish"}, "Names and terms that may appear: Rahul, Pip")
    assert row["text"] == "language Hinglish<asr_text>Rahul se baat karo"
    assert row["prompt"].startswith(CONTEXT_PREFIX)
    prompt = context_prompt("Call Priya about Zomato", ["Rahul", "Swiggy", "Delhi"], random.Random(1))
    assert prompt.startswith(CONTEXT_PREFIX) and ("Priya" in prompt or "Zomato" in prompt)
    assert json.dumps(row, ensure_ascii=False)


def test_ship_rule():
    from evaluate_checkpoint import ship_decision

    baseline = {"hi": {"wer": 0.10}, "ta": {"wer": 0.20}, "en": {"wer": 0.08}}
    ok, _ = ship_decision({"hi": {"wer": 0.08}, "ta": {"wer": 0.18}, "en": {"wer": 0.083}}, baseline, {"hi", "ta"})
    assert ok
    ok, reasons = ship_decision({"hi": {"wer": 0.08}, "ta": {"wer": 0.18}, "en": {"wer": 0.09}}, baseline, {"hi", "ta"})
    assert not ok and "en" in reasons[0]


def test_install_keeps_the_previous_model(tmp_path, monkeypatch):
    from export.install_model import install

    monkeypatch.setenv("PIP_MODELS_DIR", str(tmp_path / "models"))
    first = tmp_path / "ckpt1"
    first.mkdir()
    (first / "model.safetensors").write_text("v1")
    (first / "optimizer.pt").write_text("big")
    target = install("qwen", first)
    assert (target / "model.safetensors").read_text() == "v1" and not (target / "optimizer.pt").exists()
    second = tmp_path / "ckpt2"
    second.mkdir()
    (second / "model.safetensors").write_text("v2")
    install("qwen", second)
    assert (target / "model.safetensors").read_text() == "v2"
    assert (target.with_name(target.name + ".previous") / "model.safetensors").read_text() == "v1"
