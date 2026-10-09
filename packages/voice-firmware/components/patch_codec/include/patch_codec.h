// patch_codec — HA Voice Preview Edition audio codec + amplifier bring-up.
//
// The HA Voice PE does NOT wire raw INMP441/MAX98357A to the ESP32-S3. Audio
// flows through a TLV320AIC3204 codec (I2C control bus) fronted by an XMOS DSP
// that supplies the I2S clocks (the ESP32 I2S is clock-SECONDARY). Before any
// audio can flow:
//   1. The XMOS reset line must be released HIGH (gives us I2S clocks).
//   2. The AIC3204 DAC must be register-configured over I2C.
//   3. The internal speaker amplifier enable must be driven HIGH (GPIO47).
//
// Pinout + register sequence verified against the official ESPHome config
// (esphome/home-assistant-voice-pe @ dev, home-assistant-voice.yaml) and the
// upstream esphome `aic3204` audio_dac driver.
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Brings up the I2C bus, releases the XMOS reset, configures the AIC3204 DAC,
// and enables the speaker amplifier. Fails LOUD: if the codec does not ACK on
// I2C this logs an error and returns false (no silent fallback). Must be called
// once at boot before patch_audio_init().
bool patch_codec_init(void);

// Drive the speaker amplifier enable line. The DAC output is silent until the
// amp is enabled. Called by the audio session lifecycle so the amp is only
// powered while a session is playing TTS (matches ESPHome's restore_mode
// ALWAYS_OFF + switch.turn_on on play).
void patch_codec_amp_enable(bool on);

// True once patch_codec_init() succeeded (codec ACKed + DAC powered).
bool patch_codec_ready(void);

// Set the XMOS DSP mic-channel pipeline stages over I2C at runtime (0=NONE,
// 1=AEC, 2=IC, 3=NS, 4=AGC). Mirrors ESPHome's voice_kit. Returns false on I2C
// error. Used both at boot (ch0=AGC, ch1=NS) and for live A/B experiments.
bool patch_codec_set_xmos_pipeline(int ch0_stage, int ch1_stage);

// Set the DAC PowerTune mode at runtime (page-1 regs 0x03/0x04). 0x08 = PTM_P1
// (lowest distortion), 0x00 = PTM_P3/P4. For A/B distortion testing.
bool patch_codec_set_dac_ptm(int cfg);

// Set the DAC digital volume at runtime (page-0 regs 0x41/0x42), in half-dB
// steps (+48 = +24 dB max, negative = attenuation). For live level A/B.
bool patch_codec_set_dac_vol(int half_steps);

#ifdef __cplusplus
}
#endif
