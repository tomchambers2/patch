# @patch/voice-firmware

ESP-IDF firmware for the patch voice device — re-flashed Home Assistant
Voice Preview Edition (ESP32-S3, INMP441 mic, MAX98357A speaker, WS2812 LED
ring, capacitive touch button, hardware mute switch).

Implements every numbered firmware responsibility in
`spec/16-voice-device.md` § Firmware responsibilities:

1. on-device wake-word (microWakeWord / TFLite-Micro — interim model `hey_jarvis`)
2. persistent control WSS to the paired host
3. per-session audio WSS streaming PCM16 mic up + TTS down
4. LED ring renderer (one row per spec § LED ring states)
5. button: short-press = PTT / accept ring; long-press = end / dismiss
6. hardware mute switch (cuts wake-word + audio session, notifies host)
7. Wi-Fi auto-reconnect with exponential backoff
8. OTA updates via `esp_https_ota`

This package is OUTSIDE the pnpm/Turbo/TypeScript graph. Its tooling is
`idf.py` and a separate cmake-based host-test harness (`host_test/`) for
exercising the pure-C state machines off-device.

## Hardware target

- HA Voice Preview Edition (ESP32-S3-WROOM-1U, 16 MB flash, 8 MB PSRAM)
- **TLV320AIC3204 audio codec** (I2C control, SDA GPIO5 / SCL GPIO6, addr 0x18)
  fronted by an **XMOS DSP** that supplies the I2S audio clocks — the ESP32 I2S
  is the clock _secondary_. The board does **not** wire raw INMP441/MAX98357A to
  the ESP32. Mic ADC in over I2S input bus (BCLK GPIO13 / WS GPIO14 / DIN
  GPIO15); speaker DAC out over I2S output bus (BCLK GPIO8 / WS GPIO7 / DOUT
  GPIO10), both 32-bit slots @ 16 kHz.
- **XMOS reset** on GPIO4 (active-high pulse, then low = run; firmware persisted
  on the XMOS — reset alone boots it, no DFU upload needed).
- **Internal speaker amplifier enable** on GPIO47 (driven HIGH for the duration
  of an audio session; DAC output is silent until enabled).
- 12-LED WS2812 ring on GPIO21 (ring power rail enable on GPIO45).
- Capacitive touch button.
- Hardware mute slide switch on GPIO3.

Pin assignments + the AIC3204 register sequence are verified against the
official ESPHome config (`esphome/home-assistant-voice-pe` @ `dev`,
`home-assistant-voice.yaml`) and the upstream `esphome` `aic3204` audio_dac
driver. They are configurable via `idf.py menuconfig` → "Patch voice device" →
"GPIO".

## Toolchain

Pinned to **ESP-IDF v5.3.2** (`idf_component.yml`). Other versions are not
supported — per `spec/principles.md` (no fallbacks).

```sh
git clone -b v5.3.2 --depth 1 --recurse-submodules \
  https://github.com/espressif/esp-idf.git ~/esp/esp-idf
cd ~/esp/esp-idf && ./install.sh esp32s3
. ~/esp/esp-idf/export.sh
```

Verify: `idf.py --version` should print `ESP-IDF v5.3.2`.

## Build & flash

```sh
cd projects/patch/packages/voice-firmware
idf.py set-target esp32s3
idf.py menuconfig          # configure server URL, daemon host/port, GPIOs
idf.py build
idf.py -p /dev/cu.usbmodem* flash monitor
```

Initial bring-up: hold the mute switch off, plug in via USB, watch the
monitor. The first boot enters BLE Wi-Fi provisioning + QR-link pairing
(see § First-boot provisioning below). The LED ring shows the disconnected
slow-red-pulse pattern until the control WSS is up.

## Menuconfig keys

The "Patch voice device" menu adds:

| Key                                             | Default                     | Purpose                                                                                                      |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PATCH_SERVER_URL`                              | `https://patch.example.com` | Patch HTTPS server. Used for QR-link pairing + OTA manifest.                                                 |
| `PATCH_DAEMON_HOST`                             | `patch.example.com`         | Host for control + audio WSS. Same host as the server in v1 (single-host topology, see `spec/02-daemon.md`). |
| `PATCH_DAEMON_PORT`                             | `443`                       | Port for host WSS.                                                                                           |
| `PATCH_DAEMON_TLS`                              | `y`                         | Use `wss://` (TLS).                                                                                          |
| `PATCH_LED_GPIO`                                | `21`                        | WS2812 data line (GPIO26-32 are octal-PSRAM pads — unusable).                                                |
| `PATCH_LED_POWER_GPIO`                          | `45`                        | WS2812 ring power-rail enable (driven HIGH or the ring is dark).                                             |
| `PATCH_LED_RING_COUNT`                          | `12`                        | LED count.                                                                                                   |
| `PATCH_MIC_BCLK_GPIO` / `WS_GPIO` / `DIN_GPIO`  | `13` / `14` / `15`          | Codec ADC I2S input bus (clock secondary).                                                                   |
| `PATCH_SPK_BCLK_GPIO` / `WS_GPIO` / `DOUT_GPIO` | `8` / `7` / `10`            | Codec DAC I2S output bus (clock secondary).                                                                  |
| `PATCH_CODEC_I2C_SDA_GPIO` / `SCL_GPIO`         | `5` / `6`                   | AIC3204 codec I2C control bus.                                                                               |
| `PATCH_CODEC_I2C_ADDR`                          | `0x18`                      | AIC3204 7-bit I2C address.                                                                                   |
| `PATCH_XMOS_RESET_GPIO`                         | `4`                         | XMOS DSP reset (active-high pulse, then low = run).                                                          |
| `PATCH_SPK_AMP_EN_GPIO`                         | `47`                        | Internal speaker amplifier enable (HIGH during a session).                                                   |
| `PATCH_MUTE_SWITCH_GPIO`                        | `3`                         | Hardware mute slide switch input.                                                                            |
| `PATCH_TOUCH_CHANNEL`                           | `5`                         | Capacitive touch channel for the button.                                                                     |
| `PATCH_TOUCH_THRESHOLD_PCT`                     | `30`                        | % drop from baseline that registers as a press.                                                              |

Run `idf.py menuconfig` → "Patch voice device" → "GPIO" / top-level keys.

## First-boot provisioning

1. Plug the device in.
2. It advertises BLE service name `PATCH-VOICE-XXXXXX` (suffix = MAC tail).
3. Open the patch web UI → Settings → Devices → "Pair voice device" — it
   speaks the standard ESP-IDF Wi-Fi-provisioning protocol over BLE.
4. After Wi-Fi is up, the device generates an Ed25519 keypair (libsodium),
   `POST`s `/api/auth/pair/start` to the patch server with its public key,
   and prints the resulting pairing nonce in the logs.
5. The patch web UI shows the nonce as a QR code (or short code) tied to
   the device's public key. An already-paired surface signs the credential
   per `spec/10-auth.md`.
6. Device polls `/api/auth/pair/complete?nonce=...` (1.5 s, up to 5 min)
   until it receives the EdDSA-JWT surface credential, then persists it
   to NVS namespace `patch.cred` and proceeds to control-WSS connect.

If pairing fails the device halts (no fallback per
`spec/principles.md`). Power-cycle to retry.

## Pairing flow re-trigger

To re-pair (e.g. wiping a unit before moving it to a new account) there
are two paths — pick one:

1. **On-device gesture (no serial cable required).** Long-long-press the
   touch button — hold continuously for at least 10 seconds
   (`PB_LONG_LONG_PRESS_MS` in `components/patch_button/include/patch_button.h`).
   The firmware calls `patch_provision_factory_reset()`, which erases the
   `patch.cred` NVS namespace, then `esp_restart()`. On reboot the device
   re-enters BLE provisioning + QR-link pairing.
2. **Serial console (cred-only wipe, keeps Wi-Fi creds).** Stop the monitor
   first — `idf.py monitor` and other `idf.py` subcommands cannot share
   the serial port:
   ```sh
   # in the monitor: Ctrl-]    (exits monitor, releases the port)
   idf.py -p /dev/cu.usbmodem* erase_otadata
   idf.py -p /dev/cu.usbmodem* monitor
   ```

A nuclear `idf.py erase-flash` also works but additionally wipes Wi-Fi
provisioning, so the device drops back to BLE provisioning before
re-pairing.

## OTA updates

`patch_ota` polls `GET <PATCH_SERVER_URL>/api/firmware/voice-device/manifest.json`
once per hour. The manifest is JSON of the form:

```json
{
  "latestVersion": "0.2.0",
  "url": "https://patch.example.com/firmware/voice-device/0.2.0.bin"
}
```

When `latestVersion` differs from the running version, the device pulls
the binary via `esp_https_ota` and reboots. Image signing uses the
ESP-IDF Secure Boot v2 chain — sign the binary with `espsecure.py
sign_data` before serving.

To publish a new firmware:

```sh
idf.py build
espsecure.py sign_data --version 2 --keyfile signing.pem \
  --output build/patch-voice-device-signed.bin build/patch-voice-device.bin
# upload signed binary to the server's /firmware/voice-device/<version>.bin
# update manifest.json on the server
```

Roll-forward only — there is no on-device rollback path. The active +
inactive OTA partitions defined in `partitions.csv` (sized for 16 MB flash,
6 MB per OTA slot) handle bricked-image recovery at the bootloader level.
The custom partition table is selected by `sdkconfig.defaults` via
`CONFIG_PARTITION_TABLE_CUSTOM=y` /
`CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"`.

## Wire protocol

Control WSS frames per `spec/16-voice-device.md` § Wire protocol — the
encode/decode lives in `components/patch_state/patch_control_frames.[ch]`.

Audio WSS frames per `packages/wire/src/audio.ts`. The voice token is
**pushed to the device by the host over the control WSS** as a field on
the `session_start` frame — the device never calls `POST /api/voice/token`
itself. Per `spec/16-voice-device.md` §"device only talks to the host",
the device speaks only WSS to the paired host; the host mints the
HMAC voice token internally (server-side `mintVoiceToken`) and forwards
it on the control-plane `session_start` event. The device opens the
audio WSS using that token, then streams PCM16 mono 16 kHz binary frames.

`surfaceHasAec` is always `false` from this device — host-side AEC3 is
mandatory.

## Layout

```
voice-firmware/
├── CMakeLists.txt              ← top-level ESP-IDF project file (enforces IDF v5.3.2)
├── idf_component.yml           ← pinned IDF + component versions
├── partitions.csv              ← dual-bank OTA partition table (16 MB flash)
├── sdkconfig.defaults          ← pinned Kconfig defaults (PSRAM, 1 kHz tick, perf, custom partitions)
├── main/
│   ├── CMakeLists.txt
│   ├── Kconfig.projbuild       ← "Patch voice device" menuconfig schema
│   └── main.c                  ← orchestrator: wires every component
├── components/
│   ├── patch_state/            ← pure-C FSMs + JSON encode/decode
│   │   ├── patch_control_frames.[ch]
│   │   ├── patch_device_state.[ch]
│   │   ├── patch_ring_fsm.[ch]
│   │   └── patch_led_table.[ch]
│   ├── patch_led/              ← WS2812 RMT renderer task
│   ├── patch_button/           ← touch button + mute switch GPIO
│   ├── patch_audio/            ← I2S in/out + audio WSS client
│   ├── patch_wakeword/         ← microWakeWord (TFLite-Micro) wrapper + vendored
│   │                              micro-frontend + embedded hey_jarvis.tflite
│   ├── patch_control/          ← persistent control WSS client
│   ├── patch_provision/        ← BLE Wi-Fi prov + QR-link pair
│   └── patch_ota/              ← esp_https_ota poller
└── host_test/                  ← cmake harness for the pure-C state code
```

## Host-side unit tests

The pure-C state machines (control-frame codec, device-state FSM, ring
lifecycle, LED pattern table) are testable on the dev box with no
ESP-IDF toolchain — useful for CI and rapid iteration.

```sh
cd projects/patch/packages/voice-firmware/host_test
rm -rf build
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

The `cmake --build` step is required — `ctest` does not build the test
executables itself, and skipping it produces `0% tests passed, N tests
failed` because there is nothing to run.

Tests are built with `-Wall -Wextra -Werror -fsanitize=address,undefined`.
ASan + UBSan are mandatory; any sanitiser hit fails the test.

The harness today is **7 ctest suites covering 55 individual `TEST_RUN`
cases**. Each suite is a single executable that runs its cases in order
and aborts on the first failure; `ctest` reports one row per suite.

| Suite                 | Coverage                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test_control_frames` | Encode round-trip for every device→host frame; decode for every host→device frame; reject malformed; ignore unknown future frames; JSON escapes.                                                                                                 |
| `test_device_state`   | Boot-state, mute overrides everything, link-down clears in-flight session, ring while muted ignored, full session lifecycle.                                                                                                                     |
| `test_ring_fsm`       | 30 s timeout, accept, user dismiss, accept-outside-ringing ignored, re-ring resets the timer.                                                                                                                                                    |
| `test_led_table`      | Every `pds_state_t` has a row, spec colours match the table in `spec/16-voice-device.md`.                                                                                                                                                        |
| `test_boot_check`     | Fail-loud rejection of the placeholder `PATCH_SERVER_URL`, accept of valid URLs.                                                                                                                                                                 |
| `test_mic_pump_state` | Single-producer mic queue invariants (only producer reads I2S; both wakeword + audio consume from the queue).                                                                                                                                    |
| `test_button`         | Pure-C press classifier: SHORT on release, LONG fires once at `PB_LONG_PRESS_MS` (700 ms), LONG_LONG fires once at `PB_LONG_LONG_PRESS_MS` (10 s — the factory-reset gesture), LONG/LONG_LONG inhibit SHORT, release-then-re-press resets state. |

## Cross-refs

- `spec/16-voice-device.md` — primary spec
- `spec/10-auth.md` — pairing flow
- `spec/03-wire-protocol.md` — control frame conventions
- `spec/12-error-and-offline.md` — reconnect/replay semantics
- `packages/wire/src/audio.ts` — audio WSS frame schemas
- `packages/daemon/src/audio/server.ts` — audio WSS server we connect to
- `packages/server/src/voice/token.ts` — voice token mint endpoint
