import numpy as np

from conftest import routing, tone
from pip_speech import lid
from pip_speech.audio import Segment, chunk, energy_segments
from pip_speech.engines.sherpa import merge_tokens
from pip_speech.languages import latin_share, normalize
from pip_speech.registry import Registry
from pip_speech.router import Request, Router


def test_language_codes():
    assert normalize("en-IN") == "en"
    assert normalize("hi-Latn") == "hinglish"
    assert normalize("TA") == "ta"
    assert latin_share("kal meeting 5 baje hai") == 1.0
    assert latin_share("कल meeting है") == 1 / 3


def test_lid_is_restricted_to_your_languages_and_folds_urdu_into_hindi():
    restricted = lid.restrict({"hi": 0.5, "ur": 0.3, "en": 0.1, "fr": 0.1}, ["en", "hinglish"])
    assert set(restricted) == {"hi", "en"}
    assert restricted["hi"] > 0.85


def test_prior_tips_a_close_call():
    probabilities = {"hi": 0.45, "en": 0.55}
    assert lid.choose(lid.apply_prior(probabilities, "hinglish", 2.0), ["en", "hinglish"], "hinglish") == "hi"
    assert lid.choose({}, ["ta", "en"], "ta") == "ta"


def test_hinglish_decision():
    assert lid.hinglish_or_hindi("kal meeting hai", [], ["hi", "hinglish"], None, 0.15) == "hinglish"
    assert lid.hinglish_or_hindi("कल मिलते हैं", [], ["hi", "hinglish"], None, 0.15) == "hi"
    assert lid.hinglish_or_hindi("कल मिलते हैं", ["hi", "en"], ["hi", "hinglish"], None, 0.15) == "hinglish"
    assert lid.hinglish_or_hindi("कल मिलते हैं", [], ["en", "hinglish"], None, 0.15) == "hinglish"


def test_routes_skip_engines_that_are_not_installed(registry):
    router = Router(registry)
    result = router.final(tone(1.5, 0.5), Request(languages=["en"]))
    assert result["model"] == "qwen"
    assert result["text"] == "see you tomorrow"
    assert "missing" not in registry.loaded


def test_hindi_audio_routes_to_hinglish_when_you_use_it(registry):
    router = Router(registry)
    result = router.final(tone(2.0), Request(languages=["en", "hinglish"]))
    assert result["language"] == "hinglish"
    assert result["text"] == "kal meeting 5 baje hai"
    assert result["probabilities"]["hi"] > result["probabilities"]["en"]


def test_forced_language_skips_lid(registry):
    router = Router(registry)
    result = router.final(tone(2.0), Request(languages=["en", "hinglish", "ta"], language="ta"))
    assert result["language"] == "ta"
    assert "lid" not in registry.loaded


def test_low_confidence_asks_a_second_model(registry):
    router = Router(registry)
    result = router.final(tone(2.0), Request(languages=["ta"]))
    assert result["model"] == "sravaani"
    assert result["detail"]["replaced"] == "conformer"


def test_silence_returns_nothing(registry):
    router = Router(registry)
    assert router.final(np.zeros(16000, dtype=np.float32), Request(languages=["en"]))["text"] == ""


def test_word_times_are_offset_by_trimmed_silence(registry):
    router = Router(registry)
    audio = np.concatenate([np.zeros(16000, dtype=np.float32), tone(1.0)])
    result = router.final(audio, Request(languages=["en"]))
    assert result["words"][0]["start"] >= 0.8


def test_long_audio_is_chunked_at_pauses():
    config = routing()
    config["routes"]["en"]["final"] = ["fast"]
    router = Router(Registry(config, device="cpu"))
    audio = np.concatenate([tone(15, 1.0), tone(15, 1.0)])
    result = router.final(audio, Request(languages=["en"]))
    assert result["text"] == "live text live text"
    assert result["words"][-1]["start"] > 15


def test_energy_vad_and_chunking():
    segments = energy_segments(np.concatenate([tone(1, 1), tone(1)]))
    assert len(segments) == 2
    merged = chunk([Segment(0, 16000 * 8), Segment(16000 * 9, 16000 * 16), Segment(16000 * 17, 16000 * 30)], max_seconds=20)
    assert [(piece.start // 16000, piece.end // 16000) for piece in merged] == [(0, 16), (17, 30)]


def test_sherpa_token_merge():
    words = merge_tokens(["▁kal", "▁mee", "ting", "▁hai"], [0.0, 0.4, 0.6, 0.9])
    assert [word.w for word in words] == ["kal", "meeting", "hai"]
    assert words[1].start == 0.4 and words[1].end == 0.9
