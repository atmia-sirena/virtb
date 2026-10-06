"""Push-to-talk sessions, the same shape as the backend's /v2/asr/sessions:
PCM16 chunks while the key is held, live text every ~600 ms, final at key-up."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field

import numpy as np

from .audio import SAMPLE_RATE, pcm16_to_float
from .router import Request, Router

PARTIAL_INTERVAL = 0.6
LID_AFTER_SECONDS = 1.5


@dataclass
class Session:
    id: str
    request: Request
    chunks: list[np.ndarray] = field(default_factory=list)
    samples: int = 0
    language: str | None = None
    partial_text: str = ""
    last_partial: float = 0.0
    worker: threading.Thread | None = None
    created: float = field(default_factory=time.time)

    def audio(self) -> np.ndarray:
        return np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)


class Sessions:
    def __init__(self, router: Router) -> None:
        self.router = router
        self.items: dict[str, Session] = {}
        self.lock = threading.Lock()

    def start(self, request: Request) -> Session:
        with self.lock:
            for session_id, session in list(self.items.items()):
                if time.time() - session.created > 30 * 60:
                    del self.items[session_id]
            session = Session(uuid.uuid4().hex, request)
            self.items[session.id] = session
        return session

    def get(self, session_id: str) -> Session | None:
        return self.items.get(session_id)

    def _update(self, session: Session) -> None:
        try:
            audio = session.audio()
            # Decide the language once there's enough speech, then keep it for the session.
            if session.language is None and audio.size >= SAMPLE_RATE * LID_AFTER_SECONDS:
                session.language = self.router.detect(audio, session.request)[0]
            result = self.router.partial(audio, session.request, session.language)
            if result is not None:
                session.partial_text = result.text
        except Exception as error:  # live text is best effort
            session.partial_text = session.partial_text or ""
            print(f"[speech] partial failed: {error}")

    def append(self, session: Session, pcm16: bytes) -> dict:
        samples = pcm16_to_float(pcm16)
        session.chunks.append(samples)
        session.samples += samples.size
        now = time.monotonic()
        busy = session.worker is not None and session.worker.is_alive()
        if not busy and now - session.last_partial >= PARTIAL_INTERVAL:
            session.last_partial = now
            session.worker = threading.Thread(target=self._update, args=(session,), daemon=True)
            session.worker.start()
        return {"text": session.partial_text, "language": session.language}

    def finish(self, session_id: str, language: str | None = None) -> dict | None:
        with self.lock:
            session = self.items.pop(session_id, None)
        if session is None:
            return None
        if session.worker is not None:
            session.worker.join(timeout=5)
        if language:
            # The user switched language mid-utterance (Pip's language-cycle hotkey).
            session.request.language = language
        # Language ID runs again on the whole utterance unless it was forced.
        return self.router.final(session.audio(), session.request)

    def cancel(self, session_id: str) -> None:
        with self.lock:
            self.items.pop(session_id, None)
