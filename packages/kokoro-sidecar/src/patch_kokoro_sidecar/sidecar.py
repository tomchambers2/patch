"""Kokoro TTS WebSocket sidecar implementation.

The synthesis engine is loaded lazily on the first request so the process can
bind its WS port quickly; the model load (~a few seconds) does not block the
listening socket. Model-path validation, however, is eager — a missing model
directory aborts at construct time (NO SILENT FALLBACK, spec/07 § Python
sidecar lifecycle).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger("patch_kokoro_sidecar")

# Kokoro models are natively 24 kHz mono.
SAMPLE_RATE = 24_000
# Stream PCM in ~40 ms chunks (960 samples) so the host can begin playback
# (and the orchestrator can interleave barge-in detection) before the whole
# utterance is synthesised.
CHUNK_SAMPLES = 960
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")


def _float_to_pcm16(audio: np.ndarray) -> bytes:
    """Convert a float32 [-1, 1] mono waveform to little-endian PCM16 bytes."""
    clipped = np.clip(audio, -1.0, 1.0)
    ints = (clipped * 32767.0).astype("<i2")
    return ints.tobytes()


@dataclass
class _ModelPaths:
    root: str
    config: str
    weights: str
    voices: str


def _resolve_model_paths(model_path: str | None) -> _ModelPaths:
    if not model_path:
        raise RuntimeError(
            "KOKORO_MODEL_PATH is not set. The Kokoro sidecar requires the "
            "kokoro-v1 model directory on disk (NO SILENT FALLBACK)."
        )
    if not os.path.isdir(model_path):
        raise RuntimeError(
            f"KOKORO_MODEL_PATH does not point at a directory on disk: {model_path} "
            "(NO SILENT FALLBACK)."
        )
    config = os.path.join(model_path, "config.json")
    # The HF kokoro repo ships the weights as kokoro-v1_0.pth.
    weights = os.path.join(model_path, "kokoro-v1_0.pth")
    voices = os.path.join(model_path, "voices")
    for label, p in (("config.json", config), ("kokoro-v1_0.pth", weights)):
        if not os.path.isfile(p):
            raise RuntimeError(
                f"KOKORO_MODEL_PATH missing required file {label}: {p} "
                "(NO SILENT FALLBACK)."
            )
    if not os.path.isdir(voices):
        raise RuntimeError(
            f"KOKORO_MODEL_PATH missing voices/ directory: {voices} (NO SILENT FALLBACK)."
        )
    return _ModelPaths(root=model_path, config=config, weights=weights, voices=voices)


class _Engine:
    """Wraps kokoro.KPipeline configured against the on-disk model.

    Supports per-request voice selection. Voice packs are loaded lazily and
    cached so switching voices across requests has no per-pack reload cost
    after the first use.
    """

    def __init__(self, paths: _ModelPaths, default_voice: str) -> None:
        self._paths = paths
        self._default_voice = default_voice
        self._pipeline = None
        # Cache of already-loaded voice packs keyed by voice name.
        self._voice_packs: dict[str, object] = {}

    def _ensure_pipeline(self) -> None:
        if self._pipeline is not None:
            return
        import torch  # pulled in by kokoro; imported early for a clear error
        from kokoro import KModel, KPipeline

        # Leave a core for the event loop, so streaming and the host's
        # requests keep moving while a long utterance synthesizes.
        torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))

        logger.info("loading Kokoro model from %s", self._paths.root)
        model = KModel(config=self._paths.config, model=self._paths.weights)
        model = model.eval()
        # lang_code 'a' = American English; the host only synthesises English.
        self._pipeline = KPipeline(lang_code="a", model=model)
        logger.info("Kokoro pipeline ready")

    def _load_voice_pack(self, voice: str) -> object:
        if voice in self._voice_packs:
            return self._voice_packs[voice]
        import torch

        voice_file = os.path.join(self._paths.voices, f"{voice}.pt")
        if not os.path.isfile(voice_file):
            raise RuntimeError(
                f"Kokoro voice '{voice}' not found at {voice_file} (NO SILENT FALLBACK)."
            )
        pack = torch.load(voice_file, weights_only=True)
        self._voice_packs[voice] = pack
        logger.info("loaded voice pack: %s", voice)
        return pack

    def _ensure_loaded(self, voice: str | None = None) -> None:
        self._ensure_pipeline()
        target = voice or self._default_voice
        self._load_voice_pack(target)

    def synthesize(self, text: str, voice: str | None = None) -> np.ndarray:
        """Synthesize the full utterance, returning a float32 mono waveform."""
        self._ensure_pipeline()
        assert self._pipeline is not None
        target = voice or self._default_voice
        voice_pack = self._load_voice_pack(target)
        chunks: list[np.ndarray] = []
        for result in self._pipeline(text, voice=voice_pack):
            audio = result.audio
            if audio is None:
                continue
            chunks.append(np.asarray(audio.detach().cpu().numpy(), dtype=np.float32))
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(chunks)


class KokoroSidecar:
    def __init__(self, model_path: str | None = None, default_voice: str = DEFAULT_VOICE) -> None:
        self._paths = _resolve_model_paths(model_path or os.environ.get("KOKORO_MODEL_PATH"))
        self._engine = _Engine(self._paths, default_voice)
        # requestId -> asyncio.Event signalling cancellation.
        self._cancelled: dict[str, bool] = {}

    async def warmup(self) -> None:
        """Force the model load up front (optional)."""
        await asyncio.to_thread(self._engine._ensure_loaded)

    async def _handle(self, websocket) -> None:  # noqa: ANN001 — websockets connection
        async for raw in websocket:
            if isinstance(raw, bytes):
                # The protocol is text-driven for TTS; ignore stray binary.
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("kokoro: dropping non-JSON text frame")
                continue
            request_id = msg.get("requestId")
            if msg.get("cancel") is True and request_id is not None:
                self._cancelled[request_id] = True
                continue
            text = msg.get("text")
            if request_id is None or not isinstance(text, str):
                continue
            # Optional per-request voice override (added for voice-in-settings).
            voice = msg.get("voice") if isinstance(msg.get("voice"), str) else None
            await self._synthesize_and_stream(websocket, request_id, text, voice)

    async def _synthesize_and_stream(self, websocket, request_id: str, text: str, voice: str | None = None) -> None:  # noqa: ANN001
        self._cancelled.pop(request_id, None)
        try:
            audio = await asyncio.to_thread(self._engine.synthesize, text, voice)
            total = audio.shape[0]
            sent = 0
            for start in range(0, total, CHUNK_SAMPLES):
                if self._cancelled.get(request_id):
                    break
                chunk = audio[start : start + CHUNK_SAMPLES]
                await websocket.send(_float_to_pcm16(chunk))
                sent += chunk.shape[0]
        except Exception as exc:  # surface loudly, then end the request cleanly
            logger.exception("kokoro: synthesis failed for %s", request_id)
            await websocket.send(
                json.dumps({"requestId": request_id, "error": str(exc)})
            )
        finally:
            self._cancelled.pop(request_id, None)
            await websocket.send(
                json.dumps({"requestId": request_id, "end": True, "sampleRate": SAMPLE_RATE})
            )

    async def serve(self, host: str, port: int) -> None:
        import websockets

        logger.info("kokoro sidecar listening on ws://%s:%d", host, port)
        # No keepalive pings: the only client is this host's own host over
        # loopback, which already learns of a dead sidecar from the process
        # exiting. With pings on, a CPU-heavy synthesis on a busy host starved
        # the event loop past the 20 s ping timeout and websockets tore the
        # connection down mid-reply (1011 "keepalive ping timeout").
        async with websockets.serve(self._handle, host, port, max_size=None, ping_interval=None):
            await asyncio.Future()


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("KOKORO_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    host = os.environ.get("KOKORO_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("KOKORO_SIDECAR_PORT", "5019"))
    sidecar = KokoroSidecar(default_voice=DEFAULT_VOICE)
    asyncio.run(sidecar.serve(host, port))


# Re-export the PCM helper for unit tests.
float_to_pcm16 = _float_to_pcm16
