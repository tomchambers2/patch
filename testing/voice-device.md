# Voice device testing

Two paths: a host-side mock harness for host-side iteration, and a real flashed ESP32-S3 for full-stack verification.

## Mock harness

`packages/voice-firmware/mock/` is a Python script (`mock-voice-device`) that
opens the same control + audio WSS as a real device. Use it to iterate on
daemon-side voice code without re-flashing.

```bash
cd projects/patch
pnpm --filter @patch/voice-firmware-mock mock \
  --daemon ws://localhost:13000 \
  --device-id mock-kitchen \
  --token ~/.patch/devices/mock-kitchen.jwt \
  --mic-fixture tests/fixtures/audio/mock-utterance-1.wav \
  --tts-out /tmp/mock-tts-out.wav
```

Or invoke directly:

```bash
cd packages/voice-firmware/mock
uv run python -m mock_voice_device --daemon ws://localhost:13000 --device-id mock-kitchen
```

Behaviour:

- Opens the control WSS at `<host>/device/control` with a Bearer EdDSA-JWT
  in the `Authorization` header (no fallbacks — missing token = exit 1).
- Sends `hello` immediately, identifies as the configured `--device-id`.
- Stdin commands map onto control frames per `spec/16-voice-device.md`
  §Wire protocol: `WAKE` → `wake_detected`, `SESSION_END [reason]`,
  `MUTE` / `UNMUTE` → `mute_changed`, `RING_ACCEPT` / `RING_DISMISS`.
- Logs every inbound `ring` / `session_start` / `led` frame to **stderr**.
- On inbound `session_start` (which now carries `voiceToken` per the
  spec/16 wire protocol resolution of B-23-3), opens the audio WSS at
  `<host>/audio/<sessionId>` and sends a spec-correct
  `audio.session_start` envelope with `surfaceKind: 'device'`.
- Streams the `--mic-fixture` WAV (PCM16 16 kHz mono) at 20 ms cadence as
  the mic, and writes inbound PCM TTS frames into `--tts-out`.
- Non-interactive CI mode: `--script path/to/scenario.txt` runs commands
  with `SLEEP <seconds>` for cadence.

See `packages/voice-firmware/mock/README.md` for the full CLI surface and
the list of gaps the harness deliberately surfaces (B-23-2 control endpoint
404, B-24-2 audio auth 401) rather than papers over.

## Real device

When iterating on firmware itself:

```bash
cd projects/patch/packages/voice-firmware
. $HOME/esp/esp-idf/export.sh
idf.py build flash monitor    # Ctrl+] to exit monitor
```

Smoke checks once the device reconnects:

- LED ring goes solid cyan.
- `patch surfaces list` shows the deviceId with `lastSeen` < 60 s.
- Press the button: LED → cyan listening → white speaking. Host appends a turn to the Speakers thread.

## OTA testing

The firmware HTTP client polls
`GET <PATCH_SERVER_URL>/api/firmware/voice-device/manifest.json` and pulls
the binary from `<PATCH_SERVER_URL>/firmware/voice-device/<version>.bin`
(see `packages/voice-firmware/README.md` §OTA updates — that is the
canonical scheme). The server's on-disk layout under
`/srv/patch/data/firmware/...` is just where the host stores artefacts
before serving them; do not write paths in that layout into the manifest.

To publish a build for OTA testing, sign it then upload via the host
admin API (which writes into the served `/firmware/voice-device/` tree
and rewrites `manifest.json` atomically):

```bash
VERSION=$(git rev-parse --short HEAD)
espsecure.py sign_data --version 2 --keyfile signing.pem \
  --output build/patch-voice-device-signed.bin build/patch-voice-device.bin
patch firmware publish \
  --device voice-device \
  --version "$VERSION" \
  --bin build/patch-voice-device-signed.bin
```

Wait up to an hour or force a poll by power-cycling the device. Verify:

```bash
patch surfaces list | grep voice-device
# firmwareVersion should be the new VERSION
patch logs --surface <deviceId> --tail 100 | grep "ota_complete"
```

## Limitations

- Audio output quality (was the user understandable?) — can't be programmatically verified.
- Hardware mute switch behaviour — can be partly verified (firmware logs `mute_on/off`) but the actual electrical disconnect requires touching the device.
- Multi-device routing (kitchen vs bedroom) — needs at least two physical devices or two parallel mock instances.
