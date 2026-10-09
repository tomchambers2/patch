# Voice testing

Latency budgets and assertion thresholds for the host-side voice
pipeline (Whisper STT → SDK turn → Kokoro TTS). Referenced from
`testing-strategy.md ## Voice testing`.

## Latency budgets

The host stamps each `audio.transcript_final` with `sttLatencyMs`
(VAD-end → final transcript) and each first `audio.tts_chunk` with
`firstFrameLatencyMs` (SDK-reply → first PCM chunk). Acceptance
thresholds:

| Path                     | Budget    |
| ------------------------ | --------- |
| Groq Whisper STT         | < 800 ms  |
| Local faster-whisper STT | < 1500 ms |
| Kokoro TTS first frame   | < 600 ms  |
| End-to-end mic→speaker   | < 2.5 s   |

These are the budgets a normal turn must hit on the test compose stack
running on Tom's Mac. The deployed Hetzner stack should be at parity or
better. Group 14's perf hardening (zero-copy PCM views, persistent
sidecar WebSockets, AEC inner-loop optimisations) targets the first
three.

## Fixtures

Fixture audio for the host unit tests lives in
`packages/daemon/test/fixtures/audio/`. Mock backends in
`docker-compose.test.yml` make these self-contained:

- `WHISPER_BACKEND=mock` echoes a synthetic transcript whose ms-duration
  is encoded into the text — tests assert on the prefix `[mock-transcript`.
- `KOKORO_BACKEND=mock` emits eight 240-sample chunks @ 24 kHz, with
  the chunk index encoded in the first sample so order can be asserted.

## Latency-budget vitest

```bash
pnpm --filter @patch/daemon test:latency
```

(currently shipping as part of `audio-session.test.ts` — measured via
the `firstFrameLatencyMs` and `sttLatencyMs` fields on emitted events).

## Smoke

After a `docker compose -f docker-compose.test.yml up -d --build`:

1. Open a WSS connection from a fixture client.
2. Send `audio.session_start` with a freshly minted token.
3. Stream a fixture utterance as binary PCM16 frames (16 kHz mono).
4. Assert: `audio.transcript_final` arrives, then `audio.tts_chunk`
   frames + binary PCM, then `audio.tts_end`. Latencies inside the
   budgets above.
