"""faster-whisper STT WebSocket sidecar.

Model load is eager-validated (the model directory must exist) but the actual
weights load lazily on first request so the WS port binds quickly.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

import numpy as np

logger = logging.getLogger("patch_whisper_sidecar")

SAMPLE_RATE = 16_000


def _resolve_model_path(model_path: str | None) -> str:
    if not model_path:
        raise RuntimeError(
            "WHISPER_MODEL_PATH is not set. The faster-whisper sidecar requires the "
            "medium.en model directory on disk (NO SILENT FALLBACK)."
        )
    if not os.path.isdir(model_path):
        raise RuntimeError(
            f"WHISPER_MODEL_PATH does not point at a directory on disk: {model_path} "
            "(NO SILENT FALLBACK)."
        )
    # faster-whisper CTranslate2 layout ships a model.bin.
    if not os.path.isfile(os.path.join(model_path, "model.bin")):
        raise RuntimeError(
            f"WHISPER_MODEL_PATH missing model.bin (not a faster-whisper model dir?): "
            f"{model_path} (NO SILENT FALLBACK)."
        )
    return model_path


class _Engine:
    def __init__(self, model_path: str) -> None:
        self._model_path = model_path
        self._model = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        from faster_whisper import WhisperModel

        logger.info("loading faster-whisper model from %s", self._model_path)
        # int8 on CPU is the documented real-time config for medium.en.
        self._model = WhisperModel(self._model_path, device="cpu", compute_type="int8")
        logger.info("faster-whisper model ready")

    def transcribe(self, pcm: np.ndarray) -> str:
        self._ensure_loaded()
        assert self._model is not None
        audio = pcm.astype(np.float32) / 32768.0
        segments, _info = self._model.transcribe(audio, language="en", beam_size=1)
        return "".join(seg.text for seg in segments).strip()


class WhisperSidecar:
    def __init__(self, model_path: str | None = None) -> None:
        resolved = _resolve_model_path(model_path or os.environ.get("WHISPER_MODEL_PATH"))
        self._engine = _Engine(resolved)

    async def warmup(self) -> None:
        await asyncio.to_thread(self._engine._ensure_loaded)

    async def _handle(self, websocket) -> None:  # noqa: ANN001
        pending: dict | None = None
        async for raw in websocket:
            if isinstance(raw, bytes):
                if pending is None:
                    logger.warning("whisper: binary frame with no pending request")
                    continue
                request_id = pending["requestId"]
                pending = None
                pcm = np.frombuffer(raw, dtype="<i2")
                try:
                    text = await asyncio.to_thread(self._engine.transcribe, pcm)
                    await websocket.send(json.dumps({"requestId": request_id, "text": text}))
                except Exception as exc:
                    logger.exception("whisper: transcription failed for %s", request_id)
                    await websocket.send(
                        json.dumps({"requestId": request_id, "error": str(exc)})
                    )
            else:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("whisper: dropping non-JSON text frame")
                    continue
                if "requestId" in msg:
                    pending = msg

    async def serve(self, host: str, port: int) -> None:
        import websockets

        logger.info("whisper sidecar listening on ws://%s:%d", host, port)
        async with websockets.serve(self._handle, host, port, max_size=None):
            await asyncio.Future()


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("WHISPER_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    host = os.environ.get("WHISPER_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("WHISPER_SIDECAR_PORT", "5018"))
    sidecar = WhisperSidecar()
    asyncio.run(sidecar.serve(host, port))
