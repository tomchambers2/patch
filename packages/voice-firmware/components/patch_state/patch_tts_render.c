// patch_tts_render — PCM16 → 32-bit-slot widening for TTS playback.
// See patch_tts_render.h. Pure arithmetic, no ESP-IDF deps.

#include "patch_tts_render.h"

bool patch_tts_widen_pcm16(const int16_t *pcm, size_t count,
                           int32_t *out, size_t out_cap) {
    if (!pcm || !out) return false;
    if (count > out_cap) return false;
    for (size_t i = 0; i < count; i++) {
        // Left-justify the 16-bit sample into the 32-bit I2S slot. The codec
        // reads the top 16 bits, so this preserves the sample at full scale.
        //
        // Shift in UNSIGNED space then reinterpret: `(int32_t)sample << 16`
        // is undefined behaviour for negative samples (UBSan flags it, and a
        // negative TTS sample is ~half of any real audio), which would crash
        // the speaker write under a sanitiser build and is technically UB on
        // device too. Widening to uint32 first is well-defined and bit-exact.
        uint32_t slot = (uint32_t)(uint16_t)pcm[i] << 16;
        out[i] = (int32_t)slot;
    }
    return true;
}

bool patch_tts_widen_pcm16_stereo(const int16_t *pcm, size_t count,
                                  int32_t *out, size_t out_cap) {
    if (!pcm || !out) return false;
    // Two output slots (L,R) per input sample.
    if (count > out_cap / 2) return false;
    for (size_t i = 0; i < count; i++) {
        // Same well-defined left-justify as the mono path, duplicated into both
        // channels of the I2S frame so the codec latches a correctly-aligned
        // stereo frame regardless of which channel it routes to the DAC.
        uint32_t slot = (uint32_t)(uint16_t)pcm[i] << 16;
        out[i * 2]     = (int32_t)slot;   // left
        out[i * 2 + 1] = (int32_t)slot;   // right
    }
    return true;
}

uint8_t patch_tts_dac_vol_reg(int db_half_steps) {
    // Hardware range: +24 dB (+48 half-steps, 0x30) down to -63.5 dB
    // (-127 half-steps, 0x81). 0x80 is reserved, so we stop at -127.
    if (db_half_steps > 48) db_half_steps = 48;
    if (db_half_steps < -127) db_half_steps = -127;
    // Two's-complement 8-bit. For db_half_steps >= 0 this is the value
    // directly (0x00..0x30); for negative it wraps (e.g. -12 -> 0xF4).
    return (uint8_t)(int8_t)db_half_steps;
}
