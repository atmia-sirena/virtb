"""HTTP API on 127.0.0.1:8790, started by Pip's backend (PIP_SPEECH_SERVER).

POST /sessions                 {languages, language?, prior?, context?} -> {sessionId}
POST /sessions/{id}/audio      raw PCM16 16 kHz mono -> {text, language}
POST /sessions/{id}/finish     -> {text, words, language, confidence, model, timings}
DELETE /sessions/{id}
POST /transcribe?languages=..  WAV/FLAC body (or PCM16 with ?encoding=pcm_s16le) -> as finish
POST /lid                      WAV body -> {language, probabilities}
POST /xlit                     {words, source} -> {words}
GET  /health
"""

from __future__ import annotations

import argparse
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request as HttpRequest
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import xlit
from .audio import decode_file, pcm16_to_float
from .languages import base, normalize
from .registry import Registry, load_routing
from .router import Request, Router
from .sessions import Sessions


class SessionBody(BaseModel):
    languages: list[str] = Field(default_factory=lambda: ["en"])
    language: str | None = None
    prior: str | None = None
    context: list[str] = Field(default_factory=list)


class XlitBody(BaseModel):
    words: list[str]
    source: str = "hi"
    target: str = "en"


def default_device() -> str:
    if os.environ.get("PIP_SPEECH_DEVICE"):
        return os.environ["PIP_SPEECH_DEVICE"]
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


def create_app(registry: Registry | None = None, warm: list[str] | None = None, warm_languages: list[str] | None = None) -> FastAPI:
    registry = registry or Registry(load_routing(), device=default_device())
    router = Router(registry)
    sessions = Sessions(router)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # Load the champions for your languages now so the first dictation is fast.
        for engine_id in warm or []:
            await run_in_threadpool(registry.get, engine_id)
        for language in warm_languages or []:
            route = router.route_language(base(normalize(language)), Request(languages=warm_languages or []))
            for role in ("final", "partial"):
                await run_in_threadpool(registry.pick, route, role)
        for engine_id in registry.routing.get("lid", [])[:1]:
            await run_in_threadpool(registry.get, engine_id)
        yield

    app = FastAPI(title="Pip speech server", lifespan=lifespan)
    app.state.registry = registry
    app.state.router = router

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "device": registry.device, "vad": router.vad.backend, "xlit": xlit.available(), "engines": registry.status()}

    @app.post("/sessions")
    def start(body: SessionBody) -> dict[str, Any]:
        session = sessions.start(Request(**body.model_dump()))
        return {"sessionId": session.id, "sampleRate": 16000, "encoding": "pcm_s16le"}

    @app.post("/sessions/{session_id}/audio")
    async def audio(session_id: str, request: HttpRequest) -> dict[str, Any]:
        session = sessions.get(session_id)
        if session is None:
            raise HTTPException(404, "no such session")
        return sessions.append(session, await request.body())

    @app.post("/sessions/{session_id}/finish")
    async def finish(session_id: str) -> dict[str, Any]:
        try:
            result = await run_in_threadpool(sessions.finish, session_id)
        except RuntimeError as error:
            raise HTTPException(503, str(error)) from error
        if result is None:
            raise HTTPException(404, "no such session")
        return result

    @app.delete("/sessions/{session_id}")
    def cancel(session_id: str) -> dict[str, bool]:
        sessions.cancel(session_id)
        return {"ok": True}

    def parse_request(query: dict[str, str]) -> Request:
        languages = [code for code in query.get("languages", "en").split(",") if code]
        context = [term for term in query.get("context", "").split(",") if term]
        return Request(languages=languages, language=query.get("language"), prior=query.get("prior"), context=context)

    @app.post("/transcribe")
    async def transcribe(request: HttpRequest) -> dict[str, Any]:
        body = await request.body()
        query = dict(request.query_params)
        audio = pcm16_to_float(body) if query.get("encoding") == "pcm_s16le" else decode_file(body)
        try:
            return await run_in_threadpool(router.final, audio, parse_request(query))
        except RuntimeError as error:
            raise HTTPException(503, str(error)) from error

    @app.post("/lid")
    async def language_id(request: HttpRequest) -> dict[str, Any]:
        audio = decode_file(await request.body())
        language, probabilities = await run_in_threadpool(router.detect, audio, parse_request(dict(request.query_params)))
        return {"language": language, "probabilities": probabilities}

    @app.post("/xlit")
    async def transliterate(body: XlitBody) -> dict[str, Any]:
        if body.target != "en":
            raise HTTPException(400, "only native script -> Latin is supported")
        try:
            return {"words": await run_in_threadpool(xlit.to_latin, body.words, body.source)}
        except RuntimeError as error:
            raise HTTPException(503, str(error)) from error

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Pip's local speech server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIP_SPEECH_PORT", "8790")))
    parser.add_argument("--warm", default=os.environ.get("PIP_SPEECH_WARM", ""), help="comma-separated engine ids to load at start")
    parser.add_argument("--warm-languages", default="", help="load the final and live-text models for these languages at start (en,hi,hinglish,ta...)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="[speech] %(message)s")
    import uvicorn

    warm = [engine for engine in args.warm.split(",") if engine]
    warm_languages = [language for language in args.warm_languages.split(",") if language]
    uvicorn.run(create_app(warm=warm, warm_languages=warm_languages), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
