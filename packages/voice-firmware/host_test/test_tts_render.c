// Host unit test for the TTS playback rendering step (TF1 / F1-audible-1).
//
// F1-audible-1 asks whether the device audibly renders a TTS reply through its
// speaker. On real hardware that needs a physical speaker + mic + transcriber
// (out of scope for a host C harness). The firmware-side determinant of
// audibility that CAN be exercised deterministically here is the PCM16 → 32-bit
// I2S-slot widening: if that arithmetic is wrong, the DAC plays silence, noise,
// or a heavily attenuated signal and nothing intelligible reaches the speaker.
//
// patch_tts_widen_pcm16() is the exact function patch_audio.c calls on every
// inbound TTS binary frame, so asserting it proves the device converts the
// daemon's TTS audio into speaker samples at full scale, in order, without
// dropping or attenuating — the rendering half of "audible".

#include "patch_tts_render.h"
#include "test_helpers.h"

#include <string.h>

// Well-defined reference widening (matches the production formula): widen in
// unsigned space, then reinterpret. Using `(int32_t)x << 16` directly is UB
// for negative x, so we never write that in either the code or the test.
static int32_t ref_widen(int16_t s) {
    uint32_t slot = (uint32_t)(uint16_t)s << 16;
    return (int32_t)slot;
}

// Each PCM16 sample is left-justified into the 32-bit slot: out == in << 16.
// A full-scale TTS sample stays full-scale (it is NOT attenuated to a faint /
// inaudible level), and silence stays silence.
static void test_widen_left_justifies_full_scale(void) {
    const int16_t pcm[] = { 0, 1, -1, 32767, -32768, 12345, -6000 };
    int32_t out[8] = {0};
    ASSERT_TRUE(patch_tts_widen_pcm16(pcm, 7, out, 8));
    ASSERT_EQ_INT(out[0], 0);
    ASSERT_EQ_INT(out[1], ref_widen(1));
    ASSERT_EQ_INT(out[2], ref_widen(-1));
    // Full-scale PCM16 must map to full-scale 32-bit — the signal is carried
    // at level, not crushed to an inaudible whisper.
    ASSERT_EQ_INT(out[3], ref_widen(32767));   // 0x7FFF0000
    ASSERT_EQ_INT(out[4], ref_widen(-32768));  // 0x80000000
    ASSERT_EQ_INT((uint32_t)out[4], 0x80000000u);
    ASSERT_EQ_INT(out[5], ref_widen(12345));
    ASSERT_EQ_INT(out[6], ref_widen(-6000));
}

// The whole TTS burst is rendered sample-for-sample, in order — no frames
// dropped, no reordering. A loud tone in the middle survives intact.
static void test_widen_preserves_order_and_energy(void) {
    int16_t pcm[320];
    for (int i = 0; i < 320; i++) {
        // A 1 kHz-ish square at high amplitude — audible energy.
        pcm[i] = (i % 16 < 8) ? 30000 : -30000;
    }
    int32_t out[320] = {0};
    ASSERT_TRUE(patch_tts_widen_pcm16(pcm, 320, out, 320));
    int nonzero = 0;
    for (int i = 0; i < 320; i++) {
        ASSERT_EQ_INT(out[i], ref_widen(pcm[i]));
        if (out[i] != 0) nonzero++;
    }
    // The rendered block carries real energy (not silence) across the window.
    ASSERT_EQ_INT(nonzero, 320);
}

// Buffer-capacity guard: the renderer must refuse rather than overflow / write
// a partial (gappy, glitchy) block. No fallback.
static void test_widen_buffer_guard(void) {
    int16_t pcm[4] = { 1, 2, 3, 4 };
    int32_t out[4] = {0};
    ASSERT_FALSE(patch_tts_widen_pcm16(pcm, 4, out, 3)); // too small
    // Nothing should have been written when it refuses.
    ASSERT_EQ_INT(out[0], 0);
    ASSERT_FALSE(patch_tts_widen_pcm16(NULL, 4, out, 4));
    ASSERT_FALSE(patch_tts_widen_pcm16(pcm, 4, NULL, 4));
    // Exact fit is allowed.
    ASSERT_TRUE(patch_tts_widen_pcm16(pcm, 4, out, 4));
    ASSERT_EQ_INT(out[3], ref_widen(4));
}

// A zero-length block is a no-op success (start/end of stream).
static void test_widen_empty(void) {
    int16_t pcm[1] = { 0 };
    int32_t out[1] = { 0x1234 };
    ASSERT_TRUE(patch_tts_widen_pcm16(pcm, 0, out, 1));
    ASSERT_EQ_INT(out[0], 0x1234); // untouched
}

// The AIC3204 DAC digital-volume encoding is two's-complement in 0.5 dB steps.
// Getting it wrong silently mis-sets the speaker loudness — too quiet (the
// F1-audible-1 noise-floor failure) or clipping at max.
static void test_dac_vol_reg_encoding(void) {
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(0), 0x00);    // 0 dB
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(-12), 0xF4);  // -6 dB
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(-2), 0xFE);   // -1 dB
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(2), 0x02);    // +1 dB
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(48), 0x30);   // +24 dB (max)
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(-127), 0x81); // -63.5 dB (min)
    // Out-of-range clamps to the hardware extremes, never wraps past them.
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(1000), 0x30);
    ASSERT_EQ_INT(patch_tts_dac_vol_reg(-1000), 0x81);
}

// The SHIPPED DAC volume must match what patch_codec.c actually programs
// (0xdc = -18 dB), sit within the conservative-quiet band the bring-up enforces
// (close-range verification mic; at/below ~-18 dB and never the +24 dB hardware
// max that clips), and decode to a real non-muted register byte. The
// F1-audible-1 garble was NOT a volume problem — it was the I2S TX clock
// declared at 16 kHz on the 48 kHz speaker bus (fixed 2026-06-21), which
// reproduced at every level — so this guard pins the shipped quiet level rather
// than chasing loudness.
static void test_shipped_dac_vol_is_audible(void) {
    // The configured loudness, in 0.5 dB steps (-18 dB).
    ASSERT_EQ_INT(PATCH_TTS_DAC_VOL_HALF_STEPS, -36);

    // Stays at-or-below the ~-18 dB quiet ceiling the bring-up enforces, and
    // strictly above the reserved/mute floor — i.e. quiet but not silent.
    ASSERT_TRUE(PATCH_TTS_DAC_VOL_HALF_STEPS <= -36);  // <= -18 dB ceiling
    ASSERT_TRUE(PATCH_TTS_DAC_VOL_HALF_STEPS > -127);  // above the -63.5 dB min
    // Never the +24 dB hardware maximum (clips).
    ASSERT_TRUE(PATCH_TTS_DAC_VOL_HALF_STEPS < 48);

    // And it encodes to exactly the register byte patch_codec.c writes (0xdc).
    uint8_t reg = patch_tts_dac_vol_reg(PATCH_TTS_DAC_VOL_HALF_STEPS);
    ASSERT_EQ_INT(reg, 0xDC);
    ASSERT_TRUE(reg != 0x80); // 0x80 is the reserved/mute code
}

// STEREO widen: each mono PCM16 sample must be duplicated into BOTH 32-bit
// slots (L,R) of an I2S frame, left-justified. Driving the HA Voice PE speaker
// bus from a MONO slot config (one slot per frame) was the F1-audible-1 garble
// root cause; this is the regression guard for the stereo-frame fix.
static void test_widen_stereo(void) {
    int16_t pcm[5] = { 0, 1, -1, 32767, -32768 };
    int32_t out[10] = {0};
    ASSERT_TRUE(patch_tts_widen_pcm16_stereo(pcm, 5, out, 10));
    for (size_t i = 0; i < 5; i++) {
        int32_t exp = ref_widen(pcm[i]);
        ASSERT_EQ_INT(out[i * 2], exp);       // left
        ASSERT_EQ_INT(out[i * 2 + 1], exp);   // right == left
    }
    // Buffer guard: needs count*2 slots, refuses (writes nothing) otherwise.
    int32_t four[4] = {0};
    ASSERT_FALSE(patch_tts_widen_pcm16_stereo(pcm, 2, four, 3)); // 2 samples need 4
    ASSERT_EQ_INT(four[0], 0);
    ASSERT_FALSE(patch_tts_widen_pcm16_stereo(NULL, 2, four, 4));
    ASSERT_FALSE(patch_tts_widen_pcm16_stereo(pcm, 2, NULL, 4));
    // Exact fit (count*2 == out_cap) is allowed.
    ASSERT_TRUE(patch_tts_widen_pcm16_stereo(pcm, 2, four, 4));
    ASSERT_EQ_INT(four[2], ref_widen(pcm[1]));
}

int main(void) {
    fprintf(stderr, "test_tts_render:\n");
    TEST_RUN(test_widen_left_justifies_full_scale);
    TEST_RUN(test_widen_preserves_order_and_energy);
    TEST_RUN(test_widen_buffer_guard);
    TEST_RUN(test_widen_stereo);
    TEST_RUN(test_widen_empty);
    TEST_RUN(test_dac_vol_reg_encoding);
    TEST_RUN(test_shipped_dac_vol_is_audible);
    fprintf(stderr, "all passed\n");
    return 0;
}
