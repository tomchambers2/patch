"""Verify the faster-whisper sidecar returns a real transcript (NO playback).

Loads a real 24 kHz speech WAV shipped with the Kokoro model, resamples to
16 kHz PCM16, feeds it to the sidecar over a real WS using the daemon's wire
protocol, and prints the transcript + a JSON verdict (non-empty transcript).
"""

import asyncio
import json
import os
import sys
import wave

import numpy as np
import websockets

from patch_whisper_sidecar.sidecar import WhisperSidecar

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _load_wav_16k(path: str) -> np.ndarray:
    with wave.open(path, "rb") as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    if sr != 16000:
        # Linear resample to 16 kHz.
        ratio = 16000 / sr
        out_len = int(round(pcm.shape[0] * ratio))
        x_old = np.linspace(0.0, 1.0, num=pcm.shape[0], endpoint=False)
        x_new = np.linspace(0.0, 1.0, num=out_len, endpoint=False)
        pcm = np.interp(x_new, x_old, pcm)
    return np.clip(pcm, -32768, 32767).astype("<i2")


async def run() -> int:
    os.environ.setdefault(
        "WHISPER_MODEL_PATH", os.path.join(ROOT, "models", "whisper", "medium.en")
    )
    wav = os.path.join(ROOT, "models", "kokoro", "samples", "af_heart_0.wav")
    pcm = _load_wav_16k(wav)

    sidecar = WhisperSidecar()
    host, port = "127.0.0.1", 5098
    server_task = asyncio.create_task(sidecar.serve(host, port))
    await asyncio.sleep(0.5)

    async with websockets.connect(f"ws://{host}:{port}", max_size=None) as ws:
        await ws.send(json.dumps({"requestId": "verify-w-1", "samples": int(pcm.shape[0])}))
        await ws.send(pcm.tobytes())
        reply = await asyncio.wait_for(ws.recv(), timeout=180)
    server_task.cancel()

    obj = json.loads(reply)
    text = obj.get("text", "")
    verdict = {
        "ok": bool(text) and len(text.strip()) > 0,
        "input_samples": int(pcm.shape[0]),
        "input_duration_s": round(pcm.shape[0] / 16000.0, 2),
        "transcript": text,
    }
    print(json.dumps(verdict))
    return 0 if verdict["ok"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
