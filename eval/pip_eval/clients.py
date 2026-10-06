"""HTTP clients for the speech server (8790) and Pip's backend (8787). Standard library only."""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any

SPEECH = os.environ.get("PIP_SPEECH_SERVER_URL", "http://127.0.0.1:8790").rstrip("/")
BACKEND = os.environ.get("PIP_BACKEND_URL", "http://127.0.0.1:8787").rstrip("/")


def _request(url: str, data: bytes | None, content_type: str, method: str = "POST", timeout: float = 120) -> Any:
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": content_type})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class SpeechClient:
    def __init__(self, base: str = SPEECH) -> None:
        self.base = base

    def health(self) -> dict[str, Any]:
        return _request(f"{self.base}/health", None, "application/json", method="GET", timeout=5)

    def transcribe(self, wav: bytes, languages: list[str], language: str | None = None, engine: str | None = None, context: list[str] | None = None) -> tuple[dict[str, Any], float]:
        query = {"languages": ",".join(languages)}
        if language:
            query["language"] = language
        if engine:
            query["engine"] = engine
        if context:
            query["context"] = ",".join(context)
        started = time.perf_counter()
        result = _request(f"{self.base}/transcribe?{urllib.parse.urlencode(query)}", wav, "audio/wav")
        return result, time.perf_counter() - started


class BackendClient:
    def __init__(self, base: str = BACKEND) -> None:
        self.base = base

    def cleanup(self, text: str, language: str | None, app: str | None = None, words: list[dict] | None = None) -> tuple[dict[str, Any], float]:
        body: dict[str, Any] = {"text": text}
        if language:
            body["language"] = language
        if app:
            body["app"] = {"process": app}
        if words:
            body["words"] = words
        started = time.perf_counter()
        result = _request(f"{self.base}/v2/dictation/cleanup", json.dumps(body).encode("utf-8"), "application/json")
        return result, time.perf_counter() - started
