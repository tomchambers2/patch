// TTS playback sample conversion — the device-side rendering step that turns
// the daemon's inbound TTS audio into the bytes the speaker codec plays.
//
// The daemon streams TTS back as binary PCM16 mono @ 16 kHz (spec/16
// §"Audio plane"). The HA Voice PE's TLV320AIC3204 DAC is clocked with 32-bit
// I2S slots, so every PCM16 sample must be widened to a left-justified int32
// before it is written to the I2S TX channel — otherwise the DAC plays noise
// or silence and nothing audible comes out of the speaker.
//
// That conversion is the firmware-side determinant of whether a TTS reply is
// AUDIBLE (TF1 / F1-audible-1). It is pure arithmetic with no ESP-IDF deps, so
// the same function the audio task uses (patch_audio.c WEBSOCKET_EVENT_DATA
// binary branch) is exercised in the host harness — proving the rendered
// samples carry the daemon's audio at full scale, not zeroed/clipped/silent.
//
// NO FALLBACKS: a caller-side buffer that can't hold the block is a bug; the
// function reports it rather than truncating.

#ifndef PATCH_TTS_RENDER_H
#define PATCH_TTS_RENDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Widen `count` PCM16 samples (`pcm`) into left-justified int32 slots (`out`).
// Each output slot is `(int32_t)sample << 16`, so a full-scale PCM16 sample
// maps to a full-scale 32-bit slot (the codec then takes the top 16 bits).
//
// Returns false (and writes nothing) if out_cap is too small for `count`
// int32 slots, or if either pointer is NULL. Returns true on success.
bool patch_tts_widen_pcm16(const int16_t *pcm, size_t count,
                           int32_t *out, size_t out_cap);

// Widen `count` PCM16 mono samples into INTERLEAVED STEREO left-justified int32
// slots: each input sample is written to BOTH the left and right 32-bit slot of
// one I2S frame, so `out` holds `count * 2` int32 values (L0,R0,L1,R1,...).
//
// Why stereo: the HA Voice PE speaker I2S bus (ESP32 TX -> XMOS/AIC3204) is a
// 2-slot-per-frame bus, exactly like the stereo mic bus. Driving it from a
// MONO I2S slot config leaves the second slot undriven and lets the codec latch
// the mono sample into the wrong channel phase — the DAC then reconstructs a
// half-rate, channel-interleaved signal that sounds like harsh digital garble
// (F1-audible-1's "speaker sounds garbled" failure). Emitting a full stereo
// frame with the sample duplicated L==R keeps every frame correctly aligned and
// the DAC (DAC_CH_SET1=0xd4: L->L, R->R) plays clean audio on both legs.
//
// Returns false (and writes nothing) if out_cap is too small for `count * 2`
// int32 slots, or if either pointer is NULL. Returns true on success.
bool patch_tts_widen_pcm16_stereo(const int16_t *pcm, size_t count,
                                  int32_t *out, size_t out_cap);

// AIC3204 DAC digital-volume register (DACL_VOL_D / DACR_VOL_D, page 0 reg
// 0x41/0x42) encoding. The control is a two's-complement value in 0.5 dB steps:
//   0x00 = 0 dB, 0x01..0x30 = +0.5 .. +24 dB (clamped at 0x30),
//   0xFF..0x81 = -0.5 .. -63.5 dB (clamped at 0x81), 0x80 is reserved (mute).
//
// Widening the PCM is only half of "audible": if the DAC volume is parked far
// below 0 dB the speaker output sits at the room noise floor and nothing
// intelligible reaches a listener (F1-audible-1's exact failure mode). This
// pure function is the single source of truth the codec bring-up uses to set
// that register, so the host harness can assert the shipped value lands at an
// audible level instead of a conservative-quiet whisper.
//
// `db_half_steps` is the gain in 0.5 dB units (e.g. -12 == -6 dB). It is
// clamped to the hardware range [-127 (=-63.5 dB), +48 (=+24 dB)].
uint8_t patch_tts_dac_vol_reg(int db_half_steps);

// The DAC digital volume the codec bring-up programs, in 0.5 dB steps. This is
// the firmware's shipped speaker loudness for TTS playback (patch_codec.c
// DACL/DACR_VOL_D). The ONLY verification mic available is the MacBook's built-in
// mic, which is ACROSS THE ROOM, not at close range — at -20 dB (0xd8) it
// captures near-silence (RMS ~0.0007, indistinguishable from room tone), which
// is why mic-based F1-audible-1 verification kept failing. -6 dB (0xf4) is a
// MEANINGFUL, clearly-audible ring/TTS level that clears the across-room mic
// floor so playback can actually be recorded and analysed, while staying far
// below the +24 dB hardware max (0x30) that clips and caused the original
// "horrible noise". The earlier garble was NOT a volume problem (it reproduced
// at every level) — it was the speaker I2S framing (mono slot vs the codec's
// 2-slot stereo bus), fixed by patch_tts_widen_pcm16_stereo. 0xf4 = -12 half-steps.
#define PATCH_TTS_DAC_VOL_HALF_STEPS  (-36)  /* -18 dB, 0xdc — quiet (user is right beside the device; -9 dB was "irritatingly loud" and the small speaker distorts when driven hard) */

#ifdef __cplusplus
}
#endif

#endif
