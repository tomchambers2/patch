"""patch Kokoro TTS sidecar.

A long-running process the patch host spawns once at boot
(`uv run python -m patch_kokoro_sidecar`). It loads the Kokoro v1 model from
``KOKORO_MODEL_PATH`` (a directory containing ``config.json``,
``kokoro-v1_0.pth`` and a ``voices/`` dir) and serves TTS over a WebSocket
using the wire protocol the daemon's ``PersistentWsClient`` expects:

  * inbound text frame ``{"requestId": str, "text": str}`` -> synthesize
  * the sidecar streams binary PCM16 frames (mono, 24 kHz, little-endian)
  * terminates the request with a text frame ``{"requestId": str, "end": true}``
  * an out-of-band ``{"requestId": str, "cancel": true}`` aborts an in-flight
    synth; the sidecar still emits the ``end`` frame so the socket stays usable.

NO FALLBACK: a missing/invalid model path aborts at startup with a clear
message rather than degrading silently.
"""

from .sidecar import KokoroSidecar, main

__all__ = ["KokoroSidecar", "main"]
