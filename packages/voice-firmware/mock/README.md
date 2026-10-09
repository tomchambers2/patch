# mock-voice-device

A Python WSS harness that pretends to be a flashed HA Voice Preview Edition.
Lets host-side voice code be exercised without a real ESP32-S3.

It speaks the wire protocol from `spec/16-voice-device.md` §Wire protocol and
`packages/wire/src/audio.ts` exactly — same `hello`/`wake_detected`/
`session_end`/`ring_accepted`/`ring_dismissed`/`mute_changed` frames a real
device sends, and the same `audio.session_start` JSON envelope on the
audio WSS, with `surfaceKind: 'device'` and the daemon-supplied
`voiceToken`.

Closes ledger entry **B-24-1**.

## Run

```bash
# from repo root
pnpm --filter @patch/voice-firmware-mock mock \
  --daemon ws://localhost:13000 \
  --device-id mock-kitchen \
  --token ~/.patch/devices/mock-kitchen.jwt \
  --mic-fixture tests/fixtures/audio/mock-utterance-1.wav \
  --tts-out /tmp/mock-tts-out.wav
```

Or directly via `uv`:

```bash
cd packages/voice-firmware/mock
uv run python -m mock_voice_device \
  --daemon ws://localhost:13000 \
  --device-id mock-kitchen \
  --token ~/.patch/devices/mock-kitchen.jwt
```

## Auth

Bearer EdDSA-JWT in the `Authorization` header on the control WSS upgrade.
Read from `~/.patch/devices/<deviceId>.jwt` by default, or via `--token`.

**No fallback.** If the token is missing, the harness exits non-zero. If
the host's control endpoint is missing (B-23-2 still open) the harness
reports `control_endpoint_missing` with a hint and exits non-zero. If the
audio WSS rejects the token (B-24-2 still open) the harness reports
`audio_auth_gap` and exits non-zero.

## CLI flags

| flag             | meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `--daemon URL`   | WSS base URL (control becomes `URL/device/control`)            |
| `--device-id ID` | identity sent in the `hello` frame                             |
| `--account-id`   | accountId placed in audio.session_start (default mock-account) |
| `--token PATH`   | JWT file path or literal JWT — overrides default location      |
| `--mic-fixture`  | PCM16 16 kHz mono WAV streamed at 20 ms cadence on session     |
| `--tts-out PATH` | write inbound PCM TTS audio to this WAV file                   |
| `--script PATH`  | non-interactive: read commands from a file (CI mode)           |

## Stdin commands (interactive)

One command per line:

```
WAKE                  send wake_detected (daemon should reply with session_start)
SESSION_END [reason]  reasons: vad-timeout | user-button | agent-finished
MUTE                  hardware mute switch flipped on
UNMUTE                hardware mute switch flipped off
RING_ACCEPT           accept an inbound ring frame
RING_DISMISS          dismiss an inbound ring frame
QUIT                  close the control WSS and exit
```

## Script format (CI)

Same commands, plus `SLEEP <seconds>` for cadence. Lines starting with
`#` are comments. Example:

```
# scenario: wake, brief utterance, session ends naturally
WAKE
SLEEP 3.5
SESSION_END agent-finished
```

## Output

Every state transition + LED hint is printed to **stderr** in a
grep-friendly form so a CI test can match it:

```
[mock-voice-device] control_connecting url=ws://localhost:13000/device/control device_id=mock-kitchen
[mock-voice-device] control_endpoint_missing hint=control upgrade returned 404 — daemon-side endpoint not yet implemented (see .cadence/blocked.json B-23-2). The harness is doing its job by surfacing this gap.
```

The command channel (stdin) and binary audio do **not** go to stderr.

## Known gaps it surfaces (not papers over)

These belong to other ledger entries — the harness just reports them
loudly:

- `control_endpoint_missing` (HTTP 404 on `/device/control`) → B-23-2
- `audio_auth_gap` (HTTP 401 on `/audio/<sessionId>`) → B-24-2
- `session_start_no_voice_token` (host sent `session_start` without
  `voiceToken`) → B-23-3
