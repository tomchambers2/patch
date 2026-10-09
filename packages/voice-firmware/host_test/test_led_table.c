#include "patch_led_table.h"
#include "patch_device_state.h"
#include "test_helpers.h"

#include <string.h>

static void test_every_state_has_a_row(void) {
    pds_state_t states[] = {
        PDS_STATE_DISCONNECTED, PDS_STATE_IDLE, PDS_STATE_WAKE_DETECTED,
        PDS_STATE_LISTENING, PDS_STATE_AGENT_SPEAKING, PDS_STATE_RINGING,
        PDS_STATE_MUTED,
        PDS_STATE_PAIRING_IN_PROGRESS, PDS_STATE_PAIRING_FAILED,
    };
    for (size_t i = 0; i < sizeof states / sizeof states[0]; i++) {
        plp_descriptor_t d = plp_for_state(states[i]);
        ASSERT_NOT_NULL(plp_pattern_str(d.pattern));
    }
}

static void test_spec_colours(void) {
    // From spec/16-voice-device.md §LED ring states table.
    plp_descriptor_t d;

    // Listening = blue, steady (distinct from speaking's green-breathe).
    d = plp_for_state(PDS_STATE_LISTENING);
    ASSERT_EQ_INT(d.r, 0); ASSERT_EQ_INT(d.g, 80); ASSERT_EQ_INT(d.b, 255);
    ASSERT_EQ_INT(d.pattern, PLP_STEADY_CYAN);
    ASSERT_TRUE(d.b > d.g);  // unmistakably blue

    d = plp_for_state(PDS_STATE_AGENT_SPEAKING);
    ASSERT_EQ_INT(d.pattern, PLP_PULSING_WHITE);

    d = plp_for_state(PDS_STATE_RINGING);
    ASSERT_EQ_INT(d.pattern, PLP_YELLOW_ROTATE);

    d = plp_for_state(PDS_STATE_MUTED);
    ASSERT_EQ_INT(d.r, 255); ASSERT_EQ_INT(d.g, 0); ASSERT_EQ_INT(d.b, 0);
    ASSERT_EQ_INT(d.pattern, PLP_SOLID_RED);

    d = plp_for_state(PDS_STATE_DISCONNECTED);
    ASSERT_EQ_INT(d.pattern, PLP_SLOW_RED_PULSE);

    d = plp_for_state(PDS_STATE_WAKE_DETECTED);
    ASSERT_EQ_INT(d.pattern, PLP_SINGLE_PULSE);

    // Idle = fully off (asleep), so the transition out of a coloured active
    // state is an unmistakable "back to sleep".
    d = plp_for_state(PDS_STATE_IDLE);
    ASSERT_EQ_INT(d.pattern, PLP_OFF);
    ASSERT_EQ_INT(d.r, 0); ASSERT_EQ_INT(d.g, 0); ASSERT_EQ_INT(d.b, 0);
}

static void test_pairing_states_distinct(void) {
    plp_descriptor_t in_progress = plp_for_state(PDS_STATE_PAIRING_IN_PROGRESS);
    plp_descriptor_t failed      = plp_for_state(PDS_STATE_PAIRING_FAILED);
    plp_descriptor_t disconnected = plp_for_state(PDS_STATE_DISCONNECTED);

    // Both pairing states must be visually distinct from the existing
    // slow-red-pulse "disconnected" pattern (the reason this fix exists).
    ASSERT_TRUE(in_progress.pattern != disconnected.pattern);
    ASSERT_TRUE(failed.pattern != disconnected.pattern);
    ASSERT_TRUE(in_progress.pattern != failed.pattern);

    // Pairing-in-progress: blue rotation.
    ASSERT_EQ_INT(in_progress.pattern, PLP_BLUE_ROTATE);
    ASSERT_TRUE(in_progress.b > in_progress.r);
    ASSERT_TRUE(in_progress.b > in_progress.g);
    ASSERT_EQ_STR(plp_pattern_str(in_progress.pattern), "blue-rotate");

    // Pairing-failed: magenta double-pulse (R+B both high, G zero).
    ASSERT_EQ_INT(failed.pattern, PLP_MAGENTA_DOUBLE_PULSE);
    ASSERT_EQ_INT(failed.r, 255);
    ASSERT_EQ_INT(failed.g, 0);
    ASSERT_EQ_INT(failed.b, 255);
    ASSERT_EQ_STR(plp_pattern_str(failed.pattern), "magenta-double-pulse");

    // The LED_STATE_* aliases must resolve to the same enum values so
    // patch_provision can call patch_led_set(LED_STATE_PAIRING_IN_PROGRESS).
    ASSERT_EQ_INT((int)LED_STATE_PAIRING_IN_PROGRESS, (int)PDS_STATE_PAIRING_IN_PROGRESS);
    ASSERT_EQ_INT((int)LED_STATE_PAIRING_FAILED, (int)PDS_STATE_PAIRING_FAILED);
}

static void test_animated_classification(void) {
    // Static patterns: renderer is allowed to drop tick rate / skip refresh.
    ASSERT_EQ_INT(plp_is_animated(PLP_OFF), 0);
    ASSERT_EQ_INT(plp_is_animated(PLP_DIM_AMBIENT), 0);
    ASSERT_EQ_INT(plp_is_animated(PLP_STEADY_CYAN), 0);
    ASSERT_EQ_INT(plp_is_animated(PLP_SOLID_RED), 0);
    // Animated patterns must keep ticking.
    ASSERT_EQ_INT(plp_is_animated(PLP_PULSING_WHITE), 1);
    ASSERT_EQ_INT(plp_is_animated(PLP_YELLOW_ROTATE), 1);
    ASSERT_EQ_INT(plp_is_animated(PLP_SLOW_RED_PULSE), 1);
    ASSERT_EQ_INT(plp_is_animated(PLP_SINGLE_PULSE), 1);
    ASSERT_EQ_INT(plp_is_animated(PLP_BLUE_ROTATE), 1);
    ASSERT_EQ_INT(plp_is_animated(PLP_MAGENTA_DOUBLE_PULSE), 1);
}

static void test_pulse_table(void) {
    // Sanity-check the precomputed sin curve. Endpoints must straddle the
    // mid-point and the peak must be near 255.
    ASSERT_EQ_INT(plp_pulse_table[0], 128);
    ASSERT_TRUE(plp_pulse_table[15] >= 250); // ~peak
    ASSERT_EQ_INT(plp_pulse_table[30], 128); // back through mid
    ASSERT_TRUE(plp_pulse_table[45] <= 5);   // ~trough
    // Monotonic up across [0..15].
    for (int i = 1; i <= 15; i++) {
        ASSERT_TRUE(plp_pulse_table[i] >= plp_pulse_table[i-1]);
    }
}

static void test_no_redraw_when_unchanged(void) {
    // The renderer's invariant: identical pixel buffers must compare equal,
    // so the renderer can skip led_strip_refresh.
    uint8_t a[12*3];
    uint8_t b[12*3];
    memset(a, 0, sizeof a);
    memset(b, 0, sizeof b);
    ASSERT_EQ_INT(patch_led_pixels_differ(a, b, 12), 0);

    // A single-byte change must be detected.
    b[7] = 1;
    ASSERT_TRUE(patch_led_pixels_differ(a, b, 12) != 0);

    // Equal non-zero buffers compare equal.
    memset(a, 0xAB, sizeof a);
    memset(b, 0xAB, sizeof b);
    ASSERT_EQ_INT(patch_led_pixels_differ(a, b, 12), 0);

    // Last-byte change still detected.
    b[12*3 - 1] = 0;
    ASSERT_TRUE(patch_led_pixels_differ(a, b, 12) != 0);

    // led_count == 0 is a no-op (no LEDs → nothing to compare → not different).
    ASSERT_EQ_INT(patch_led_pixels_differ(a, b, 0), 0);
}

int main(void) {
    fprintf(stderr, "test_led_table\n");
    TEST_RUN(test_every_state_has_a_row);
    TEST_RUN(test_spec_colours);
    TEST_RUN(test_pairing_states_distinct);
    TEST_RUN(test_animated_classification);
    TEST_RUN(test_pulse_table);
    TEST_RUN(test_no_redraw_when_unchanged);
    return 0;
}
