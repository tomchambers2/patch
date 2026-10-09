# Human tasks

These groups are complete except for steps only a person at the hardware can do — the workflow
cannot actuate them. Do each, then re-run the build (`pipeline-build`) to verify and auto-clear it.

- [ ] **F1/TF1** — The F1 task's on-device acceptance clause ("flash device and verify: wake word triggers session; LED transitions; mute engages; ring causes chime + audio session on accept; ring times out at 30s; audio round-trip latency ~600ms-1s with Groq STT") cannot be exercised in this environment: it needs a physical ESP32-S3 HA Voice PE board with audible speaker playback in an occupied room, a human to speak the wake word and press the capacitive button, and a live daemon + Groq STT path. All firmware-side determinants of those behaviours are built and verified in the off-device host harness (9/9 ctest suites under ASan/UBSan) and the firmware compiles to a flashable image, but the physical/audible verification itself is hardware- and human-gated.

Return "ok".
