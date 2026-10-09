"""Generate a tiny PCM16 mono 16kHz fixture WAV for smoke tests."""

import math
import struct
import wave
from pathlib import Path

SR = 16000
DUR_S = 0.5
FREQ = 440.0


def main() -> None:
    out = Path(__file__).parent / "fixtures" / "tone-440-500ms.wav"
    out.parent.mkdir(exist_ok=True)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        for i in range(int(SR * DUR_S)):
            v = int(0.2 * 32767 * math.sin(2 * math.pi * FREQ * i / SR))
            w.writeframes(struct.pack("<h", v))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
