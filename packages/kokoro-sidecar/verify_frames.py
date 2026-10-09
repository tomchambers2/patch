"""Verify the Kokoro sidecar emits real 24 kHz PCM16 frames (NO playback).

Boots the sidecar in-process, drives one synthesis request over a real WS,
and inspects the binary frames: count, byte alignment, sample rate, and that
the audio is non-silent (RMS > 0). Prints a JSON verdict.
"""

import asyncio
import json
import os
import struct
import sys

import numpy as np
import websockets

from patch_kokoro_sidecar.sidecar import KokoroSidecar


async def run() -> int:
    os.environ.setdefault(
        "KOKORO_MODEL_PATH",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "kokoro")),
    )
    sidecar = KokoroSidecar()
    host, port = "127.0.0.1", 5099
    server_task = asyncio.create_task(sidecar.serve(host, port))
    await asyncio.sleep(0.5)

    pcm_bytes = bytearray()
    frame_count = 0
    end_seen = False
    sample_rate = None
    async with websockets.connect(f"ws://{host}:{port}", max_size=None) as ws:
        await ws.send(json.dumps({"requestId": "verify-1", "text": "Hello from patch."}))
        while True:
            msg = await asyncio.wait_for(ws.recv(), timeout=120)
            if isinstance(msg, bytes):
                assert len(msg) % 2 == 0, "PCM16 frame has odd byte length"
                pcm_bytes.extend(msg)
                frame_count += 1
            else:
                obj = json.loads(msg)
                if obj.get("error"):
                    print(json.dumps({"ok": False, "error": obj["error"]}))
                    return 1
                if obj.get("end"):
                    end_seen = True
                    sample_rate = obj.get("sampleRate")
                    break

    server_task.cancel()
    samples = np.frombuffer(bytes(pcm_bytes), dtype="<i2")
    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) if samples.size else 0.0
    duration_s = samples.size / 24000.0
    verdict = {
        "ok": frame_count > 0 and end_seen and rms > 0 and sample_rate == 24000,
        "frame_count": frame_count,
        "total_samples": int(samples.size),
        "sample_rate": sample_rate,
        "duration_s": round(duration_s, 3),
        "rms": round(rms, 1),
        "peak": int(np.abs(samples).max()) if samples.size else 0,
    }
    print(json.dumps(verdict))
    return 0 if verdict["ok"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
