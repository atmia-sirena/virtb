import io

import numpy as np
import soundfile
from fastapi.testclient import TestClient

from conftest import pcm16, tone
from pip_speech import sessions as sessions_module
from pip_speech.server import create_app


def client(registry):
    return TestClient(create_app(registry))


def test_health_lists_engines(registry):
    body = client(registry).get("/health").json()
    assert body["ok"] is True
    assert body["engines"]["qwen"]["usable"] is True
    assert body["engines"]["missing"]["usable"] is False


def test_push_to_talk_session(registry, monkeypatch):
    monkeypatch.setattr(sessions_module, "PARTIAL_INTERVAL", 0.0)
    http = client(registry)
    session = http.post("/sessions", json={"languages": ["en", "hinglish"], "prior": "hinglish", "context": ["Pip"]}).json()
    audio = tone(2.0, 0.3)
    for start in range(0, audio.size, 3200):
        live = http.post(f"/sessions/{session['sessionId']}/audio", content=pcm16(audio[start : start + 3200])).json()
    assert "text" in live
    final = http.post(f"/sessions/{session['sessionId']}/finish").json()
    assert final["text"] == "kal meeting 5 baje hai"
    assert final["language"] == "hinglish"
    assert final["words"][0]["w"] == "kal"
    assert http.post(f"/sessions/{session['sessionId']}/finish").status_code == 404


def test_transcribe_a_wav_file(registry):
    buffer = io.BytesIO()
    soundfile.write(buffer, tone(1.5), 16000, format="WAV")
    body = client(registry).post("/transcribe?languages=ta&language=ta", content=buffer.getvalue()).json()
    assert body["language"] == "ta"
    assert body["text"] == "நாளைக்கு வருவேன்"


def test_xlit_reports_when_indicxlit_is_missing(registry):
    response = client(registry).post("/xlit", json={"words": ["नमस्ते"], "source": "hi"})
    assert response.status_code in (200, 503)


def test_warms_models_for_your_languages(registry):
    with TestClient(create_app(registry, warm_languages=["en", "hinglish", "ta"])):
        pass
    assert {"qwen", "fast", "conformer", "lid"} <= registry.loaded


def test_transcribe_with_a_forced_engine(registry):
    buffer = io.BytesIO()
    soundfile.write(buffer, tone(1.5), 16000, format="WAV")
    http = client(registry)
    body = http.post("/transcribe?languages=ta&language=ta&engine=conformer", content=buffer.getvalue()).json()
    assert body["model"] == "conformer"
    assert http.post("/transcribe?languages=ta&engine=missing", content=buffer.getvalue()).status_code == 503
