"""patch faster-whisper STT sidecar.

A long-running process the patch host spawns once at boot when
``WHISPER_BACKEND=local`` (``uv run python -m patch_whisper_sidecar``). It loads
``faster-whisper medium.en`` from ``WHISPER_MODEL_PATH`` and serves STT over a
WebSocket using the wire protocol the daemon's ``PersistentWsClient`` /
``LocalWhisperBackend`` expects:

  * inbound text frame ``{"requestId": str, "samples": int}``
  * immediately followed by one binary PCM16 frame (mono, 16 kHz, little-endian)
  * the sidecar replies with one text frame ``{"requestId": str, "text": str}``

NO FALLBACK: a missing/invalid model path aborts at startup with a clear
message rather than degrading silently.
"""

from .sidecar import WhisperSidecar, main

__all__ = ["WhisperSidecar", "main"]
