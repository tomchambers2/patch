# HA Voice PE (voice-firmware) — gotchas & hard-won knowledge

Everything below is specific to the **Home Assistant Voice Preview Edition**
hardware running our custom `packages/voice-firmware` (ESP-IDF, NOT ESPHome) +
the local `packages/daemon`. Most of this cost hours to (re)discover. Read it
before touching the voice device again.

Guiding principle (learned the hard way): **the hardware audio is a solved
problem in the official ESPHome HA Voice PE firmware. Copy its plumbing
verbatim; only our UX / interaction profile should be custom.** Do not reinvent
codec/I2S/buffering.

---

## 0. TL;DR — the "noisy audio" saga is SOLVED (2026-06-21)

The noisy / crackly / windy / buzzy TTS that consumed this project for weeks was
**one root cause** plus **two minor end-of-playback pops**. All fixed, all
user-confirmed clean by ear, across varied speech and all volumes. The device
is re-provisioned and **real host TTS over Wi-Fi was verified end-to-end**
(`playback gaps=0`). Fix committed as `voice-firmware: fix noisy TTS audio +
end-of-playback pop`.

1. **Noisy speech = the I2S TX clock was declared at 16 kHz while the speaker
   bus runs at 48 kHz.** Even in slave mode the IDF uses `clk_cfg.sample_rate`
   to set up the peripheral's sampling, so the wrong rate injected sampling
   noise into the audio. **FIX:** `clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SPK_RATE)`
   (48 kHz) in the TX `i2s_std_config_t` (`patch_audio.c`). See §1.
2. **End-pop #1 = stale-DMA-repeat.** When playback stops, the TX DMA underran
   and looped the last buffer. **FIX:** `tx_cfg.auto_clear = true`. See §3.
3. **End-pop #2 = amp turn-off transient.** The class-D amp pops when GPIO47
   drops. **FIX:** enable-once-and-stay-on (never power it down). See §3.

### ⚠️ THE BIG LESSON — why this took so long

The clock mismatch produces a signature that **perfectly mimics analog
intermodulation distortion**:

- a **pure tone is CLEAN** (its pitch/period are unaffected by the rate mixup),
- **two tones are "rough", speech is "crackly", and it's level-independent.**

That "tone clean / complex content noisy / level-independent" pattern screams
"memoryless analog nonlinearity downstream of the DAC", so the entire project
was spent chasing a **phantom analog IMD**: the XMOS DSP, the AIC3204 PowerTune
mode, the speaker/amp hardware, concurrent mic-uplink, acoustic IMD
measurement. It was **digital all along** — a single wrong number in the clock
config. **If audio is clean on tones but noisy on speech, suspect the I2S clock
config BEFORE you suspect anything analog.** §12 is the full graveyard of dead
ends; read it before re-opening any of them.

How it was finally cracked (the decisive ear-free splits):

- **Stock firmware plays clean on this exact speaker** → hardware is fine.
- **The exact bytes the device plays, played off a PC, sound clean** (dump the
  embedded clip to a WAV, `afplay` it) → the data is fine.
- **`auto_clear` underrun counter = 0 and playback duration = exact 48 kHz
  rate** → digital delivery is perfect.
- That left only "how the ESP drives the I2S", and the boot log literally said
  `i2s ... @ 16000 Hz`. One line.

---

## 1. Clocking & sample rates — the #1 footgun

- The **speaker I2S bus runs at 48 kHz**, clocked by the on-board **XMOS DSP**
  (the ESP32 TX is an I2S **slave / secondary**). The mic (RX) bus is a separate
  16 kHz bus. They are NOT the same rate. (`SAMPLE_RATE` = 16000 for the mic,
  `SPK_RATE` = 48000 for the speaker, in `patch_audio.c`.)

- **THE TX `clk_cfg` MUST declare the TRUE 48 kHz bus rate (`SPK_RATE`), NOT
  `SAMPLE_RATE` (16 kHz).** This was THE root cause of the whole "noisy" saga.
  Even though the ESP32 TX is an I2S _slave_, the IDF still uses
  `clk_cfg.sample_rate` to configure the peripheral's internal sampling. With it
  wrongly at 16 kHz while the bus clocks at 48 kHz, a **single tone survives
  intact** but **complex/aperiodic content (speech) gets sampling noise injected**
  — heard as "noisy / buzzy / harsh", _level-independent_ (see §0 for why this
  masquerades as analog distortion).
  - FIX: `.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SPK_RATE)` in the TX
    `i2s_std_config_t`. Verified clean by ear, and objectively: the embedded clip
    plays in **1599 ms for 75600 samples = exact 48 kHz** (a 16k/48k mixup would
    slow or speed it), with **0 TX underruns**.
  - **Objective rate check** (no ear needed): `speech` diag logs `embedded
speech: …` then `… done`; the delta ÷ sample-count must equal 48 kHz
    (~1575 ms for the 75600-sample clip). Use this any time you touch clocking.

- **Content must ALSO be true 48 kHz.** Our wire/Kokoro path is 16 kHz, so TTS is
  resampled to 48 kHz on the **host** (`resampleTtsTo48k` in
  `packages/daemon/src/audio/session.ts` — a 63-tap Kaiser windowed-sinc,
  zero-stuff + FIR, validated vs scipy `resample_poly`, <1 % imaging) and the
  device plays the 48 kHz raw. If you ever feed the 48 kHz bus 16 kHz samples
  directly, **everything plays 3× too fast** (a 480 Hz tone came out at 1446 Hz =
  3.01×; speech becomes fast gibberish). Do NOT do a crude on-device upsample
  (linear interp + moving-average leaves audible HF imaging — "static").

- Matches the official ESPHome config exactly: `speaker: platform: i2s_audio,
sample_rate: 48000, bits_per_sample: 32bit, i2s_mode: secondary, channel:
stereo`, resampler speakers output 48 kHz.

## 2. I2S format / pins (verified against official ESPHome)

- Speaker I2S pins: **BCLK GPIO8, WS/LRCLK GPIO7, DOUT GPIO10** (sdkconfig
  `CONFIG_PATCH_SPK_BCLK_GPIO=8 / _WS_GPIO=7 / _DOUT_GPIO=10`). Mic: DIN GPIO15,
  BCLK GPIO13, WS GPIO14.
- The speaker bus carries **two 32-bit slots per frame (STEREO)**. Driving it
  mono left the 2nd slot undriven → the codec latched half-rate channel-
  interleaved garble. We emit a full stereo frame with the mono PCM16 sample
  duplicated **L == R**, left-justified into the high 16 bits of a 32-bit slot
  (`patch_tts_widen_pcm16_stereo`: `(uint32_t)(uint16_t)pcm << 16`). Verified
  correct (the clean tone proves the widen).
- Codec is the **TLV320AIC3204**. Our `patch_codec.c` register sequence is a
  faithful, **register-for-register** port of ESPHome's `aic3204.cpp` setup()
  (NDAC/MDAC 0x82, DOSR 0x80, CODEC_IF 0x30, DAC_SIG_PROC PRB_P1, page-1 analog
  blocks, HPL/HPR/LOL/LOR routes 0x08, HP gain 0x3e/−2 dB, LO gain 0,
  OP_PWR_CTRL 0x3C, DAC_CH_SET1 0xd4). Do not drift from it.
- **PTM_P1 divergence (harmless, NOT the fix).** We set the DAC PowerTune mode to
  **PTM_P1** (page-1 0x03/0x04 = 0x08, lowest-distortion Class-AB) where stock
  uses PTM_P3/P4 (0x00). This was applied mid-hunt as a suspected IMD fix; it
  did **NOT** change the crackle (the clk bug did). It's retained because it's
  the lowest-distortion mode and harmless, but **do not believe it fixed
  anything** — if you ever want exact stock parity, reverting to 0x00 is safe.

## 3. Speaker amp (GPIO47) — "pop at the end" (TWO separate causes)

- `CONFIG_PATCH_SPK_AMP_EN_GPIO=47`. The end-of-playback "little pop" had **two
  independent causes**; both fixed (2026-06-21, user-confirmed clean):
  1. **Stale-DMA-repeat pop.** When playback stops writing, the TX I2S DMA
     underruns and by default _repeats the last buffer_ (stale audio) → a pop.
     FIX: `tx_cfg.auto_clear = true` (`patch_audio.c`) — the IDF then emits
     **zeros** when there's no fresh data. This also hardens mid-stream gaps.
  2. **Amp turn-OFF transient.** The class-D amp pops intrinsically when GPIO47
     drops — a hardware transient, NOT a signal step (the audio is already
     silent; soft-muting the DAC does NOT remove it). Proven: with the amp left
     ON, `auto_clear` alone killed the pop; re-enabling amp-off brought it back.
- **Resolution: ENABLE-ONCE-AND-STAY-ON.** `patch_codec_amp_enable(true)` powers
  the amp on first use; `(false)` is now a **no-op**. The device is mains-powered
  and the amp is **dead-silent at idle** (no hiss — confirmed by ear), so there
  is no reason to ever power it down, and never toggling it off means it never
  pops. The amp turn-ON is clean (DAC unmuted+silent first), so a single enable
  at first playback is glitch-free.
- Historical note: the older "flush silence then cut amp on a silent frame"
  pattern reduced the _mid-audio_ buzz but could NOT remove the end pop (that was
  causes 1+2 above). Don't reintroduce per-utterance amp-off.

## 4. Wakeword (microWakeWord "Hey Jarvis") — memory & mute

- Engine: **microWakeWord** (TFLite-Micro, HA's), NOT ESP-SR WakeNet. Model
  `model/hey_jarvis.tflite`. Feature scaling: `int8 = round(frontend/25.6 /
input_scale) + zp` (input_scale 0.101961, zp −128) — the v2 path. The v1
  ESPHome `(v*256+333)/666-128` formula maps everything to INT8_MIN → peak stuck
  at 0. Don't regress that.
- It WORKS: the real phrase hits `peak_prob=255/255` (cutoff 247) → `wake word
detected! ('Hey Jarvis')`. `peak_prob=0` with loud ambient is CORRECT (ambient
  ≠ the wake phrase). The user's live voice triggers more reliably than `afplay`.
  To open a session WITHOUT speaking, use the **`wake` diag command** (§10) which
  fires the same `wake_detected` control frame.
- **MEMORY: the TFLite arena needs ~28 KB of INTERNAL RAM at boot.** If you grow
  other internal-RAM allocations (big I2S DMA, FreeRTOS stream buffers, task
  stacks) the arena alloc fails → `microWakeWord model setup failed; wake word
DISABLED` → "Hey Jarvis does nothing" with NO crash. Mitigations: keep the **TX
  DMA small** (`dma_frame_num` MUST be ≤ 511 — IDF silently clamps; 4×480 ≈ 40 ms
  is plenty), and put the **playback jitter buffer in PSRAM**
  (`heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` + `xStreamBufferCreateStatic`).
- The **mute switch (GPIO3)** pauses the wakeword (`muted:true` on the host). A
  muted device produces NO wakeword diag and won't wake — check `muted` before
  assuming a hang. The **action button (GPIO0)**, active-low/inverted, is for
  ring-accept (NOT push-to-talk; a button press does not open a voice session —
  use wakeword or the `wake` diag).

## 5. Playback buffering & the data path (all real bugs, all fixed)

These were genuine bugs fixed during the hunt. They were necessary for a correct
data path but, on their own, did NOT cure the "noisy" verdict (that was the §1
clock bug). They ARE correct and must stay.

- **WS continuation-fragment drop.** The host sends TTS as multi-KB binary WS
  frames. ESP-IDF's websocket client delivers a frame larger than its RX buffer
  as SEVERAL `WEBSOCKET_EVENT_DATA` callbacks: the first carries the real
  `op_code` (0x2 binary), each CONTINUATION carries `op_code 0x0`. The handler
  only acted on `op_code == 0x2`, so every continuation was DROPPED — splicing a
  chunk out of each frame on a stream that stayed contiguous (so the underrun
  metric never fired). FIX: track the frame opcode (`s_rx_frame_op`); treat
  `op_code 0x0` continuations as part of the in-progress binary frame.
- **Per-block silence splicing.** The feeder padded each DMA block with silence
  on the FIRST short stream-buffer read; since WS data arrives in bursts most
  blocks got `[some real][silence pad]`. FIX: HA-style **fill-then-pad** — loop
  reads to gather a FULL DMA block over a ~10 ms budget (< the DMA cushion), pad
  only the genuine remainder. Also **preload every TX DMA descriptor with
  silence** before `i2s_channel_enable` so the pipeline starts full.
- **Architecture** (matches ESPHome i2s_audio `buffer_duration: 100ms`): a
  **PSRAM stream buffer + dedicated feeder task** drains to the DAC; the host
  **bursts** frames (no real-time pacing) so the device backpressures and fills a
  cushion; the feeder prebuffers then drains and never silence-pads mid-stream
  (only on a true underrun). See `play_feeder_task` in `patch_audio.c`.
- Diag seams: firmware logs `tts rx diag: … rxsum=… rxcnt=…` (per-session, reset
  on `audio ws connected`) and `playback: gaps=… partials=… frames=… occ=…`. A
  real end-to-end host TTS run now logs `gaps=0 partials=0`.

## 6. Device↔host session lifecycle

- A playback (TTS) needs an **open audio session**. Sessions open on **wake**
  (`wake_detected` control frame) or **ring-accept**; the device then opens a
  per-session audio WSS to `ws://<lan>:3023/audio/<sessionId>`. The "listening"
  LED lights on the control `session_start`, which is BEFORE the audio WS
  connects — fire `diag-speak` only after `audio ws connected`, or you get
  `404 "no active session for surfaceId"`.
- **Open a session on demand without speaking:** the **`wake` diag command**
  (§10) sends `wake_detected` over the control WS → host opens a session →
  then POST diag-speak. This is the autonomous end-to-end test path. Confirmed
  working: `wake` → `session_start` → `led: agent-speaking` → TTS frames →
  `playback gaps=0`.
- **Diag speak**: `POST http://127.0.0.1:3023/internal/diag/voice-device/speak`
  (header `X-Patch-Internal-Token: dev-internal-token-0123456789`, body
  `{surfaceId:"voice-pe-07138c", text}`). `{ok:true}` if a session is open, 404
  otherwise. Bypasses the agent/LLM (pure Kokoro→device), so it's how to test
  AUDIO without a working conversation/login.
- Historical "sessions die in ~250–400 ms": that was the **expired Claude login**
  (§7) tearing real-mode sessions down, NOT a firmware bug. With creds valid (or
  `SDK_BACKEND=mock`) sessions hold.

## 7. Host environment — must be healthy or nothing works

The F1 host runs on this Mac (Node listening on `*:3023`; `daemonHost` baked
into the device creds is this Mac's LAN IP, currently `192.168.68.79`). Known
degradations that break voice:

- **Claude OAuth expired** → `runQuery refused: Claude OAuth not available (NO
API-key fallback)`. The agent can't reply, so wake→ask→reply produces nothing
  and the real-mode session collapses in ~400 ms. Needs a human `claude login` on
  the Mac (creds live in the macOS Keychain, NOT `~/.claude.json`). No API-key
  fallback.
- **`SDK_BACKEND=mock`** bypasses the login: the agent is a deterministic no-op
  that succeeds with no Claude auth, so **sessions stay open ~5 s** and TTS
  plays — good for audio testing. Launcher uses
  `export SDK_BACKEND="${SDK_BACKEND:-real}"`; run
  `SDK_BACKEND=mock ./.tmp/f1-prov/launch-f1-daemon-real.sh`. ⚠️ mock auto-replies
  `"[mock] echo: …"` which gets SPOKEN — if you ALSO fire diag-speak you get two
  overlapping TTS streams (garble + ~2× frame count). `session.speak` intercepts
  `[mock]` text to suppress/replace it; keep that.
- **Kokoro sidecar (:5019)** synthesises TTS; ~15–20 s cold start (model load),
  first request after a restart can `ECONNREFUSED :5019`. It can crash with a
  NATIVE torch segfault mid-inference (silence, not an exception) — its
  stdout/stderr are now tailed into the exit log. Pre-warm with a throwaway
  diag-speak.
- **faster-whisper STT sidecar** can crash/respawn → STT destabilises. Only
  matters for real wake→ask→reply, not for diag-speak audio tests.
- Restart: kill the listener on :3023 + `pkill -f daemon/src/index.ts`, re-run
  the launch script. The device then needs a DTR/RTS reset to reconnect (§9).

## 8. Provisioning / NVS restore

The device stores Wi-Fi creds (`nvs.net80211`) + the host pairing
(`patch.cred`: deviceId, surfaceJwt, daemonHost, daemonPort, tls) in the **NVS
partition at 0x9000 (size 0x6000), PLAINTEXT** (the `nvs_keys` partition exists
but NVS is not encrypted). The pairing JWT in `.tmp/f1-prov/device-cred.json`
has **no `exp` claim** — it does not expire.

- **⚠️ Flashing the stock factory.bin at 0x0 WIPES NVS** → device loses Wi-Fi +
  pairing and drops to first-boot **BLE provisioning** (advertises as
  `PATCH-VOICE-07138C`; boot log: `no provisioning creds — entering BLE
provisioning`). There is no Wi-Fi password baked into the firmware.
- **Fastest re-provision (no BLE, no password re-entry):** flash the saved NVS
  image back:
  ```
  python -m esptool --chip esp32s3 -p /dev/cu.usbmodemXXXX -b 460800 \
    --before default_reset --after hard_reset write_flash \
    --flash_mode dio --flash_size 16MB --flash_freq 80m \
    0x9000 .tmp/f1-prov/nvs/nvs_patched.bin
  ```
  `nvs_patched.bin` = a live device NVS dump (with the Wi-Fi station creds) +
  the injected `patch.cred` (see `.tmp/f1-prov/inject_cred.py`). It is plaintext;
  verify with `strings nvs_patched.bin | grep -E 'net80211|sta.ssid'`. Confirmed
  to restore Wi-Fi ("fritz wifi") + pairing in one flash: boot then shows `wifi
got ip` → `control ws connected` → `led: idle`.
- Only valid while the Wi-Fi network is unchanged (same SSID/password) and the
  Mac/daemon is on the `daemonHost` IP in the image (192.168.68.79). If the
  network changed, you must use the BLE provisioning flow with the new password.
- App-partition reflashes (`0x20000`, what `idf.py flash` / a targeted app write
  does) do NOT touch NVS, so provisioning survives normal firmware iteration.

## 9. Serial / reconnect recipes

- Port: `ls /dev/cu.usbmodem*` — it **flips between `…1101` and `…2101`** on
  re-enumeration, never hardcode. Read with
  `~/.espressif/python_env/idf5.3_py3.14_env/bin/python` + pyserial @115200.
- **Opening the port with default DTR/RTS resets the ESP32.** To READ without
  resetting: `dtr=False; rts=False` before `open()` (and again after). To
  deliberately reset/reconnect (e.g. after a host restart): `dtr=False;
rts=True; open(); sleep .1; rts=False`. Two readers on one port garble output.
- Build/flash: `. ~/esp/esp-idf/export.sh` then `idf.py build`; flash just the
  app (fast, lowest wedge risk) with esptool at `0x20000`
  (`build/patch-voice-device.bin`). Full flash adds bootloader 0x0 / parttable
  0x8000 / ota 0xf000.
- **HARD WEDGE — software cannot recover it.** After many DTR/RTS reset cycles in
  a tight loop, the ESP32-S3's native USB-Serial/JTAG can wedge: `read()` returns
  0 bytes AND esptool fails ("No serial data received") even though the port
  enumerates. NOTHING remote recovers it (not DTR/RTS, not `usb_reset`, not a
  flash). Needs a **physical USB-C replug** (or hold BOOT while replugging for
  download mode). Don't burn time on reset loops once you see 0 serial bytes +
  "No serial data received" — ask the human to replug. Avoid rapid repeated
  DTR/RTS pulses.

## 10. Diag command reference (serial console)

Type these over the serial console (newline-terminated). The console + audio +
codec come up BEFORE provisioning, so tones/speech work with no daemon/Wi-Fi.

| Command                                        | Effect                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `tone [amp [fa fb]]`                           | Local tone to the speaker, no host. One freq, or two (`fa`+`fb`) for a two-tone. e.g. `tone 9000 440 0`, `tone 6000 500 1300`. |
| `speech [pct]`                                 | Play the embedded speech clip (direct path), amplitude `pct` %. Logs duration + TX-underrun count.                             |
| `speechfeed`                                   | Same clip through the feeder/stream-buffer path (A/B vs `speech`).                                                             |
| `dacvol <half_steps>`                          | Runtime DAC digital volume in ½-dB steps (+48 = +24 dB max, −36 = −18 dB default, negative = attenuation). Live level A/B.     |
| `amp <0\|1>`                                   | Force amp on (off is a no-op by design — see §3).                                                                              |
| `wake`                                         | Send `wake_detected` → opens a real host session without speaking (then POST diag-speak).                                      |
| `ptm <hex>`                                    | Runtime DAC PowerTune (page-1 0x03/0x04). `0x08`=PTM_P1, `0x00`=PTM_P3/4.                                                      |
| `xmos <ch0> <ch1>`                             | Set XMOS mic-pipeline stages (0=NONE…4=AGC). Mic-side only; no effect on playback.                                             |
| `miccap [pct]` / `tonecap [f1 f2]`             | Capture the device's own mic during playback, dump 16 kHz hex (close-field; see §11 caveats).                                  |
| `mute on\|off`, `button down\|up\|read\|trace` | Mute switch / action-button simulation + GPIO probing.                                                                         |

(The `dacvol`, `amp`, `wake` commands and a TX-underrun counter were added while
fixing the audio; they're harmless and useful — keep them.)

## 11. Testing audio quality — only the ear

- **Only the human's ear judges audio quality, and only BINARY (clean / not
  clean).** Do not tune against "better/worse" or against any automated metric.
- **Automated acoustic measurement is unreliable here — proven repeatedly.** The
  Mac built-in mic has its own AGC (two identical captures differ ~12 dB); room
  reverb decorrelates; a quiet device sits at the noise floor; whisper
  hallucinates ("Thanks for watching") on low-level audio. FFT/THD/correlation/
  transcription/level-sweep all disagreed with what the user actually heard.
  **Don't claim "clean" from a capture.**
- **The ear-free tools that DO work** (use these to localise, then ask the human
  ONCE for the verdict):
  - **Play the device's exact bytes off a PC** — dump the embedded clip / the
    host's `out48` to a WAV and `afplay` it. Clean on PC ⇒ data is fine ⇒ bug
    is in the device path. (This is what isolated the §1 clk bug.)
  - **On-device generated tone** (`tone` diag) — bypasses WS/feeder/resample;
    isolates the analog/codec chain from the transport.
  - **In-vs-out checksum** — device sums received PCM (`rxsum`/`rxcnt`); host
    sums `out48`. Equal ⇒ transit is bit-perfect.
  - **TX-underrun counter + playback-duration** — proves the DMA delivery is
    glitch-free and at the correct rate (see §1).
  - **A/B against stock firmware by ear** — the ultimate hardware-vs-firmware
    decider. Stock plays clean on this unit ⇒ any defect is in our firmware.

## 12. Dead ends — rabbit holes that were NOT the cause (DO NOT re-open)

The "noisy" hunt generated a huge pile of plausible-but-wrong theories. **All of
the following were chased, some at great length, and NONE was the cause — the
cause was the §1 clock config.** Recorded so nobody re-walks them.

- **"It's analog intermodulation distortion."** The whole edifice. "Single tone
  clean, two-tone rough, speech crackly, level-independent" was read as a
  memoryless analog nonlinearity downstream of the DAC. It was the clk-mismatch
  sampling noise (which has the identical perceptual signature). **This is the
  trap; see §0.**
- **The XMOS XU316 DSP.** Suspected as the "unconfigured DSP distorting complex
  audio". We confirmed its firmware is **1.3.1, identical to stock**, replicated
  stock's `voice_kit` config (I2C 0x42, RESID 241, ch0=AGC ch1=NS) and A/B'd
  AGC/NS vs NONE — **no effect on playback** (mic-side only). Not it.
- **DAC PowerTune mode (PTM_P1).** Switched PTM_P3/4 → PTM_P1 (lowest distortion)
  as a "fix". User verdict after: still crackly. **Did not fix anything** (kept
  only because it's harmless; see §2).
- **The speaker/amp hardware.** Concluded (wrongly) it was this unit's analog
  output being marginal. Disproved: **stock firmware plays clean on this exact
  speaker**, and the device's own bytes play clean off a PC.
- **Output level / overdrive.** Speech at 0.4× and a full `dacvol` sweep
  (−24/−15/−6/0/+6 dB) were ALL equally noisy → level-independent → not clipping.
- **Concurrent mic-uplink during playback.** We stream mic up while TTS plays
  (for barge-in); stock doesn't. Gated the uplink off during playback (`ws
send_bin failed` 2+ → 0) → crackle unchanged. Not it.
- **The data path (resampler / WS transport / feeder / widen).** Made bit-perfect
  (`rxsum == out48` checksum, `gaps=0 partials=0`) — and the user STILL heard
  noise. `resampleTtsTo48k` FFT-tested clean (<1 % imaging); it SMOOTHS the
  signal (max sample-jump drops). The WS-fragment and silence-splice bugs (§5)
  were real and fixed, but were NOT the noise. **Lesson: a bit-perfect digital
  path proves the bytes arrive correctly, NOT that they're clocked out
  correctly** — the clk bug corrupts on the way OUT of the DMA, invisible to any
  receive-side checksum.
- **The embedded clip / Kokoro.** A known-clean human WAV through the pipeline
  was also crackly ⇒ not Kokoro-specific. The embedded clip itself is clean
  (verified: peak −8.8 dBFS, 0 clipped samples, smooth) and plays clean off a PC.
- **Host-mic acoustic IMD measurement.** Eight different instruments (spectral
  IMD, level sweep, differential HF, THD, source-correlation, close-field
  capture, transcription, runtime PTM switching) — all unreliable here (§11). Do
  not tune against them.
- **The gap/underrun metric as a proxy for "clean".** `gaps=0` was achieved
  repeatedly while the user still heard noise; it's blind to whole-frame WS-drop
  and sub-block silence-pad and (critically) to clock-out corruption.
- **Misc traps:** stale `static` diag counters that never reset across boot (a
  stale `peak=32761` triggered a phantom "4× gain bug" detour); a one-off `-D
PATCH_FEEDER_SINE_TEST` persisting in `build/CMakeCache.txt` so a debug tone
  "wouldn't turn off" (fix: `idf.py fullclean`); a "lossless ingress" loop that
  added a 76-underrun burst (reverted).

**The one note in this file that actively caused harm:** an earlier §1 claimed
"setting `clk_cfg` to 48000 made playback 0.43× slow, so leave it at
SAMPLE_RATE." That was wrong / from a stale state and it explicitly warned future
debuggers AWAY from the actual fix, costing weeks. The fix is exactly to set it
to 48 kHz. **If a gotcha tells you not to try the obvious thing, verify it
yourself with a measurement before trusting it.**
