"""
Mock voice-device harness.

Pretends to be a flashed HA Voice PE so daemon-side iteration can proceed
without real ESP32-S3 hardware. Speaks the wire protocol from
`spec/16-voice-device.md` §Wire protocol and `packages/wire/src/audio.ts`.

Two WSS connections to the daemon:
  * Control WSS (persistent) — `<daemon>/device/control`
  * Audio   WSS (per-session) — `<daemon>/audio/<sessionId>`

Authentication: Bearer EdDSA-JWT in the `Authorization` header on the
control WSS upgrade. The token is read from `~/.patch/devices/<deviceId>.jwt`
or via `--token <file-or-literal>`. NO fallbacks — if the token is
missing the harness exits non-zero (per CLAUDE.md / spec/principles.md).

Outputs every state transition + LED hint to stderr in a grep-friendly
form: `[mock-voice-device] <event> <key=value>...`.

CI mode:
  --script <path>       run command lines from a file (one per line):
                          WAKE
                          SLEEP <seconds>
                          SESSION_END [reason]
                          MUTE / UNMUTE
                          RING_ACCEPT / RING_DISMISS
                          QUIT
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import sys
import time
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import websockets
from websockets.exceptions import (
    ConnectionClosed,
    InvalidStatus,
    InvalidStatusCode,  # older websockets versions
)

LOG_PREFIX = "[mock-voice-device]"
FW_VERSION = "mock-0.1.0"
FRAME_MS = 20
SAMPLE_RATE_MIC = 16000
SAMPLES_PER_FRAME = SAMPLE_RATE_MIC * FRAME_MS // 1000  # 320


def log(event: str, **kv: object) -> None:
    parts = [LOG_PREFIX, event]
    for k, v in kv.items():
        parts.append(f"{k}={v}")
    print(" ".join(str(p) for p in parts), file=sys.stderr, flush=True)


# ---------- token loading -------------------------------------------------


def load_token(device_id: str, token_arg: Optional[str]) -> str:
    """Load the device JWT. No fallbacks."""
    if token_arg:
        # Could be a path or a literal token
        p = Path(token_arg).expanduser()
        if p.is_file():
            tok = p.read_text().strip()
            if not tok:
                raise SystemExit(f"{LOG_PREFIX} fatal: token file {p} is empty")
            return tok
        # Treat as literal token if it's not a path
        if "." in token_arg and len(token_arg) > 20:
            return token_arg.strip()
        raise SystemExit(
            f"{LOG_PREFIX} fatal: --token {token_arg!r} is neither a file nor a JWT-shaped literal"
        )

    default_path = Path.home() / ".patch" / "devices" / f"{device_id}.jwt"
    if not default_path.is_file():
        raise SystemExit(
            f"{LOG_PREFIX} fatal: no JWT at {default_path} and no --token flag. "
            f"Mint one via the daemon's device-pairing flow (see .cadence/blocked.json B-24-3) "
            f"or pass --token <path-or-literal>."
        )
    tok = default_path.read_text().strip()
    if not tok:
        raise SystemExit(f"{LOG_PREFIX} fatal: token file {default_path} is empty")
    return tok


# ---------- WAV helpers ---------------------------------------------------


@dataclass
class MicFixture:
    samples: bytes  # raw PCM16 LE
    sample_rate: int

    @classmethod
    def load(cls, path: Path) -> "MicFixture":
        with wave.open(str(path), "rb") as w:
            if w.getnchannels() != 1:
                raise SystemExit(
                    f"{LOG_PREFIX} fatal: mic fixture {path} has {w.getnchannels()} channels, need mono"
                )
            if w.getsampwidth() != 2:
                raise SystemExit(
                    f"{LOG_PREFIX} fatal: mic fixture {path} sampwidth={w.getsampwidth()} bytes, need 2 (PCM16)"
                )
            if w.getframerate() != SAMPLE_RATE_MIC:
                raise SystemExit(
                    f"{LOG_PREFIX} fatal: mic fixture {path} rate={w.getframerate()}, need {SAMPLE_RATE_MIC}"
                )
            data = w.readframes(w.getnframes())
        return cls(samples=data, sample_rate=SAMPLE_RATE_MIC)

    def iter_frames(self) -> "list[bytes]":
        bytes_per_frame = SAMPLES_PER_FRAME * 2
        out = []
        for i in range(0, len(self.samples), bytes_per_frame):
            chunk = self.samples[i : i + bytes_per_frame]
            if len(chunk) < bytes_per_frame:
                # pad final partial frame with silence
                chunk = chunk + b"\x00" * (bytes_per_frame - len(chunk))
            out.append(chunk)
        return out


class TtsWriter:
    """Collects PCM16 frames received over the audio WSS into a WAV file."""

    def __init__(self, path: Path, sample_rate: int = 24000) -> None:
        self.path = path
        self.sample_rate = sample_rate
        self._chunks: list[bytes] = []

    def add(self, raw: bytes) -> None:
        self._chunks.append(raw)

    def finalize(self) -> None:
        if not self._chunks:
            log("tts_out_empty", path=self.path)
            return
        with wave.open(str(self.path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.sample_rate)
            w.writeframes(b"".join(self._chunks))
        log("tts_out_written", path=self.path, bytes=sum(len(c) for c in self._chunks))


# ---------- audio session -------------------------------------------------


def daemon_audio_url(daemon_url: str, session_id: str) -> str:
    base = daemon_url.rstrip("/")
    return f"{base}/audio/{session_id}"


def daemon_control_url(daemon_url: str) -> str:
    base = daemon_url.rstrip("/")
    return f"{base}/device/control"


async def run_audio_session(
    *,
    daemon_url: str,
    session_id: str,
    voice_token: str,
    device_id: str,
    account_id: str,
    chat_id: str,
    mic_fixture: Optional[MicFixture],
    tts_writer: Optional[TtsWriter],
) -> None:
    url = daemon_audio_url(daemon_url, session_id)
    log("audio_connecting", url=url)
    try:
        async with websockets.connect(url) as ws:
            log("audio_connected", session=session_id)

            start_event = {
                "type": "audio.session_start",
                "sessionId": session_id,
                "accountId": account_id,
                "surfaceId": device_id,
                "surfaceKind": "device",
                # A device session MUST carry its deviceId — the host's audio
                # server enforces the surfaceKind/deviceId coupling
                # (validateDeviceIdCoupling, spec/16) and rejects a device
                # session without it. This tags the Speakers turn
                # [voice • device:<deviceId>] and routes TTS back here.
                "deviceId": device_id,
                "chatId": chat_id,
                "role": "voice-device-conv",
                "token": voice_token,
                "voiceToken": voice_token,
                "surfaceHasAec": False,
            }
            await ws.send(json.dumps(start_event))
            log("audio_session_start_sent", session=session_id)

            mic_task = (
                asyncio.create_task(_pump_mic(ws, session_id, mic_fixture))
                if mic_fixture
                else None
            )
            try:
                async for msg in ws:
                    if isinstance(msg, (bytes, bytearray)):
                        if tts_writer:
                            tts_writer.add(bytes(msg))
                        log("audio_pcm_in", bytes=len(msg))
                        continue
                    try:
                        ev = json.loads(msg)
                    except json.JSONDecodeError:
                        log("audio_bad_json", raw_len=len(msg))
                        continue
                    et = ev.get("type", "?")
                    log("audio_event", type=et)
                    if et == "audio.error":
                        log(
                            "audio_error",
                            code=ev.get("code"),
                            message=ev.get("message"),
                        )
                    if et == "audio.session_end":
                        break
            finally:
                if mic_task:
                    mic_task.cancel()
                    try:
                        await mic_task
                    except (asyncio.CancelledError, Exception):
                        pass
    except (InvalidStatus, InvalidStatusCode) as e:
        status = getattr(e, "status_code", None) or getattr(
            getattr(e, "response", None), "status_code", None
        )
        log("audio_upgrade_failed", status=status, err=str(e))
        if status == 401:
            log(
                "audio_auth_gap",
                hint="audio WSS rejected token (HTTP 401). Surface JWT minting is "
                "blocked on .cadence/blocked.json B-24-2 — expected on bare test stack.",
            )
        raise
    except ConnectionClosed as e:
        log("audio_closed", code=e.code, reason=e.reason)


async def _pump_mic(ws, session_id: str, fixture: MicFixture) -> None:
    """Stream the fixture WAV at 20ms cadence."""
    frames = fixture.iter_frames()
    log("mic_pump_start", frames=len(frames), rate=fixture.sample_rate)
    next_t = time.monotonic()
    for i, frame in enumerate(frames):
        envelope = {
            "type": "audio.pcm16",
            "ts": int(time.time() * 1000),
            "sampleRate": SAMPLE_RATE_MIC,
            "samples": SAMPLES_PER_FRAME,
        }
        try:
            await ws.send(json.dumps(envelope))
            await ws.send(frame)
        except ConnectionClosed:
            log("mic_pump_closed", at_frame=i)
            return
        next_t += FRAME_MS / 1000.0
        delay = next_t - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
    log("mic_pump_done", session=session_id)


# ---------- control session ----------------------------------------------


@dataclass
class HarnessState:
    muted: bool = False
    in_session: bool = False
    current_session_id: Optional[str] = None
    pending_ring_chat: Optional[str] = None


async def run_control_session(args: argparse.Namespace, token: str) -> int:
    url = daemon_control_url(args.daemon)
    headers = [("Authorization", f"Bearer {token}")]
    log("control_connecting", url=url, device_id=args.device_id)

    try:
        ws = await websockets.connect(url, additional_headers=headers)
    except (InvalidStatus, InvalidStatusCode) as e:
        status = getattr(e, "status_code", None) or getattr(
            getattr(e, "response", None), "status_code", None
        )
        log("control_upgrade_failed", status=status, err=str(e))
        if status == 404:
            log(
                "control_endpoint_missing",
                hint="control upgrade returned 404 — daemon-side endpoint not "
                "yet implemented (see .cadence/blocked.json B-23-2). The harness "
                "is doing its job by surfacing this gap.",
            )
        elif status == 401:
            log(
                "control_auth_failed",
                hint="control WSS rejected JWT (HTTP 401). Mint a valid device "
                "JWT (B-24-3) — no fallback.",
            )
        return 2
    except OSError as e:
        log("control_connect_error", err=str(e))
        return 3

    state = HarnessState()
    async with ws:
        log("control_connected")
        hello = {
            "type": "hello",
            "deviceId": args.device_id,
            "fwVersion": FW_VERSION,
            "muted": state.muted,
        }
        await ws.send(json.dumps(hello))
        log("hello_sent", device_id=args.device_id)

        cmd_queue: asyncio.Queue[str] = asyncio.Queue()
        if args.script:
            cmd_task = asyncio.create_task(_run_script(args.script, cmd_queue))
        else:
            cmd_task = asyncio.create_task(_run_stdin(cmd_queue))

        recv_task = asyncio.create_task(_recv_control(ws, state, args))
        cmd_handler = asyncio.create_task(_handle_commands(ws, cmd_queue, state, args))

        done, pending = await asyncio.wait(
            {cmd_task, recv_task, cmd_handler},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc:
                log("task_error", task=t.get_name(), err=str(exc))
    return 0


async def _run_stdin(q: asyncio.Queue) -> None:
    loop = asyncio.get_running_loop()
    log("stdin_ready", hint="commands: WAKE | SESSION_END [reason] | MUTE | UNMUTE | RING_ACCEPT | RING_DISMISS | QUIT")
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            await q.put("QUIT")
            return
        await q.put(line.strip())


async def _run_script(path: str, q: asyncio.Queue) -> None:
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"{LOG_PREFIX} fatal: script {path} not found")
    log("script_start", path=path)
    for raw in p.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.upper().startswith("SLEEP "):
            secs = float(line.split()[1])
            log("script_sleep", secs=secs)
            await asyncio.sleep(secs)
            continue
        await q.put(line)
    await asyncio.sleep(0.5)
    await q.put("QUIT")


async def _handle_commands(
    ws,
    q: asyncio.Queue,
    state: HarnessState,
    args: argparse.Namespace,
) -> None:
    while True:
        cmd = await q.get()
        if not cmd:
            continue
        upper = cmd.upper()
        log("cmd", value=upper)
        if upper == "QUIT":
            await ws.close()
            return
        if upper == "WAKE":
            await ws.send(json.dumps({"type": "wake_detected"}))
            log("sent", frame="wake_detected")
        elif upper.startswith("SESSION_END"):
            parts = cmd.split(maxsplit=1)
            reason = parts[1] if len(parts) > 1 else "user-button"
            await ws.send(
                json.dumps({"type": "session_end", "reason": reason})
            )
            log("sent", frame="session_end", reason=reason)
            state.in_session = False
        elif upper == "MUTE":
            state.muted = True
            await ws.send(json.dumps({"type": "mute_changed", "muted": True}))
            log("sent", frame="mute_changed", muted=True)
        elif upper == "UNMUTE":
            state.muted = False
            await ws.send(json.dumps({"type": "mute_changed", "muted": False}))
            log("sent", frame="mute_changed", muted=False)
        elif upper == "RING_ACCEPT":
            await ws.send(json.dumps({"type": "ring_accepted"}))
            log("sent", frame="ring_accepted")
        elif upper == "RING_DISMISS":
            await ws.send(json.dumps({"type": "ring_dismissed"}))
            log("sent", frame="ring_dismissed")
        else:
            log("cmd_unknown", value=cmd)


async def _recv_control(ws, state: HarnessState, args: argparse.Namespace) -> None:
    mic_fixture = (
        MicFixture.load(Path(args.mic_fixture)) if args.mic_fixture else None
    )
    tts_writer = TtsWriter(Path(args.tts_out)) if args.tts_out else None

    try:
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                log("control_unexpected_binary", bytes=len(msg))
                continue
            try:
                ev = json.loads(msg)
            except json.JSONDecodeError:
                log("control_bad_json", raw_len=len(msg))
                continue
            et = ev.get("type")
            log("recv", type=et)
            if et == "session_start":
                session_id = ev.get("sessionId") or str(uuid.uuid4())
                voice_token = ev.get("voiceToken")
                if not voice_token:
                    log(
                        "session_start_no_voice_token",
                        hint="spec/16 requires voiceToken in session_start; "
                        "daemon must mint and forward (see B-23-3).",
                    )
                    continue
                state.in_session = True
                state.current_session_id = session_id
                # Run audio session in a task so control loop keeps reading
                asyncio.create_task(
                    run_audio_session(
                        daemon_url=args.daemon,
                        session_id=session_id,
                        voice_token=voice_token,
                        device_id=args.device_id,
                        account_id=args.account_id,
                        chat_id=ev.get("chatId", "voice-device"),
                        mic_fixture=mic_fixture,
                        tts_writer=tts_writer,
                    )
                )
            elif et == "ring":
                state.pending_ring_chat = ev.get("chatId")
                log(
                    "ring",
                    chat=ev.get("chatId"),
                    conversational=ev.get("conversational"),
                    message=ev.get("message"),
                )
            elif et == "led":
                log("led_state", state=ev.get("state"))
            else:
                log("recv_unknown", type=et)
    except ConnectionClosed as e:
        log("control_closed", code=e.code, reason=e.reason)
    finally:
        if tts_writer:
            tts_writer.finalize()


# ---------- CLI -----------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mock-voice-device", description=__doc__)
    p.add_argument("--daemon", required=True, help="Daemon WSS base URL, e.g. ws://localhost:13000")
    p.add_argument("--device-id", required=True, help="Device id this harness identifies as")
    p.add_argument(
        "--account-id",
        default="mock-account",
        help="Account id placed in audio.session_start (default: mock-account)",
    )
    p.add_argument(
        "--token",
        default=None,
        help="Path to the device EdDSA-JWT, or the JWT literal. Defaults to ~/.patch/devices/<deviceId>.jwt",
    )
    p.add_argument("--mic-fixture", default=None, help="PCM16 16kHz mono WAV to stream as mic audio")
    p.add_argument("--tts-out", default=None, help="Where to write inbound TTS PCM as a WAV file")
    p.add_argument("--script", default=None, help="Run scripted commands instead of stdin")
    return p


def cli() -> None:
    args = build_parser().parse_args()
    try:
        token = load_token(args.device_id, args.token)
    except SystemExit:
        raise
    rc = asyncio.run(run_control_session(args, token))
    sys.exit(rc)


if __name__ == "__main__":
    cli()
