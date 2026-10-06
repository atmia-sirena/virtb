import io
import json

import numpy as np
import soundfile

from pip_eval import run as runner
from pip_eval.manifest import Utterance, expand, load_config, load_set, read_seeds
from pip_eval.metrics import Item, align, entities, score, word_errors
from pip_eval.normalize import for_wer, for_zero_edit, romanized_key


def test_alignment_counts():
    result = align("a b c d".split(), "a x c d e".split())
    assert (result.substitutions, result.deletions, result.insertions) == (1, 0, 1)
    assert result.inserted == ["e"]


def test_indic_normalization():
    assert for_wer("क़लम ठीक है।", "hi") == for_wer("कलम ठीक है", "hi")
    assert for_wer("₹1,50,000 at 5:30!", "en") == "₹150000 at 5:30"
    assert for_wer("१२३", "hi") == "123"


def test_romanized_hinglish_is_spelling_tolerant():
    assert word_errors("nahin yaar theek hai", "nahi yar thik hai", "hinglish").errors == 0
    assert romanized_key("woh") == romanized_key("vo")
    assert word_errors("kal milte hain", "kal milenge", "hinglish").errors > 0


def test_zero_edit_ignores_only_a_final_full_stop():
    assert for_zero_edit("Kal milte hain.") == for_zero_edit("Kal milte hain")
    assert for_zero_edit("Kal milte hain") != for_zero_edit("kal milte hain")


def test_entities():
    assert entities("Pay ₹25,000 to Rahul at rahul@gmail.com by 5:30.") == ["₹25,000", "Rahul", "rahul@gmail.com", "5:30"]


def test_dictation_scores():
    items = [
        Item("1", "en", "um meet at five", "um meet at five", "Meet at five.", "Meet at five.", ["filler"]),
        Item("2", "en", "scratch that", "scratch that", "", "Scratch that.", ["command"]),
        Item("3", "en", "pay 500 rupees", "pay 500 rupees", "Pay ₹500.", "Pay ₹500 um extra.", ["entity"], latency=0.5),
    ]
    report = score(items)["overall"]
    assert report["zero_edit_rate"] == round(1 / 3, 4)
    assert report["command_accuracy"] == 0.0
    assert report["filler_leak_rate"] == round(1 / 3, 4)
    assert report["entity_accuracy"] == 1.0
    assert report["latency_p50"] == 0.5


def test_sets_and_seeds_load():
    config = load_config()
    assert "fleurs-hi" in expand(["hindi"], config)
    seeds = read_seeds()
    assert {seed.language for seed in seeds} >= {"en", "hinglish", "hi", "ta", "te", "pa"}
    assert isinstance(load_set("fleurs-hi", config), str)  # not downloaded here


class FakeSpeech:
    def __init__(self):
        self.calls = []

    def health(self):
        return {"engines": {"good": {"usable": True}, "bad": {"usable": True}, "off": {"usable": False}}}

    def transcribe(self, wav, languages, language=None, engine=None, context=None):
        self.calls.append((language, engine))
        text = "kal milte hain" if engine in (None, "good") else "kal milte"
        return {"text": text, "language": language or "hinglish", "model": engine or "good", "words": []}, 0.2 if engine == "good" else 0.1


class FakeBackend:
    def cleanup(self, text, language, app=None, words=None):
        return {"text": text[0].upper() + text[1:] + "."}, 0.05


def wav_file(tmp_path):
    path = tmp_path / "a.wav"
    soundfile.write(path, np.zeros(1600, dtype=np.float32), 16000)
    return path


def test_run_items_through_speech_and_cleanup(tmp_path):
    utterance = Utterance("u1", "hinglish", "kal milte hain", wav_file(tmp_path), final="Kal milte hain.")
    items = runner.run_items([utterance], FakeSpeech(), FakeBackend(), ["hinglish"], False, None, False)
    assert items[0].final == "Kal milte hain."
    assert abs(items[0].latency - 0.15) < 1e-9  # speech 0.1 + cleanup 0.05
    assert score(items)["overall"]["zero_edit_rate"] == 1.0


def test_bakeoff_reorders_routes(tmp_path):
    routing = {
        "engines": {"good": {"languages": ["hinglish"]}, "bad": {"languages": ["*"]}, "off": {"languages": ["*"]}},
        "routes": {"*": {"final": ["off"], "partial": [], "second": []}},
    }
    path = tmp_path / "routing.json"
    path.write_text(json.dumps(routing))
    utterances = [Utterance(f"u{i}", "hinglish", "kal milte hain", wav_file(tmp_path)) for i in range(3)]
    result = runner.bakeoff({"set": utterances}, FakeSpeech(), ["hinglish"], path)
    route = result["routes"]["hinglish"]
    assert route["final"][:2] == ["good", "bad"]
    assert route["second"][0] == "bad"
    assert result["_bakeoff"]["results"]["hinglish"]["good"]["wer"] == 0.0
