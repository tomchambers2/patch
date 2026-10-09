// Host-side tests for the pure-C button-press classifier.
// Covers SHORT / LONG / LONG_LONG threshold semantics plus the inhibition
// rules between them. The on-device patch_button.c task glue (FreeRTOS,
// touch_pad driver, GPIO) is out of scope — only pb_press_step is exercised.

#include "patch_button.h"
#include "test_helpers.h"

// Drive the classifier across many polls; collect the last non-NONE output.
static pb_press_out_t hold_until(pb_press_state_t *s, int64_t start_ms,
                                 int64_t end_ms, int step_ms,
                                 pb_press_out_t *first_long,
                                 pb_press_out_t *first_long_long) {
    pb_press_out_t last = PB_PRESS_NONE;
    if (first_long) *first_long = PB_PRESS_NONE;
    if (first_long_long) *first_long_long = PB_PRESS_NONE;
    for (int64_t t = start_ms; t <= end_ms; t += step_ms) {
        pb_press_out_t o = pb_press_step(s, true, t);
        if (o == PB_PRESS_LONG && first_long && *first_long == PB_PRESS_NONE) {
            *first_long = o;
        }
        if (o == PB_PRESS_LONG_LONG && first_long_long && *first_long_long == PB_PRESS_NONE) {
            *first_long_long = o;
        }
        if (o != PB_PRESS_NONE) last = o;
    }
    return last;
}

static void test_short_press_on_release(void) {
    pb_press_state_t s; pb_press_init(&s);
    // Initial: idle.
    ASSERT_EQ_INT(pb_press_step(&s, false, 0), PB_PRESS_NONE);
    // Press at t=10.
    ASSERT_EQ_INT(pb_press_step(&s, true, 10), PB_PRESS_NONE);
    // Held briefly.
    ASSERT_EQ_INT(pb_press_step(&s, true, 100), PB_PRESS_NONE);
    ASSERT_EQ_INT(pb_press_step(&s, true, 300), PB_PRESS_NONE);
    // Release at t=500 (well below LONG=700).
    ASSERT_EQ_INT(pb_press_step(&s, false, 500), PB_PRESS_SHORT);
}

static void test_idle_release_emits_nothing(void) {
    pb_press_state_t s; pb_press_init(&s);
    // Never pressed.
    ASSERT_EQ_INT(pb_press_step(&s, false, 0), PB_PRESS_NONE);
    ASSERT_EQ_INT(pb_press_step(&s, false, 100), PB_PRESS_NONE);
}

static void test_long_press_fires_once_at_threshold(void) {
    pb_press_state_t s; pb_press_init(&s);
    pb_press_step(&s, true, 0);
    // Just under LONG: still NONE.
    ASSERT_EQ_INT(pb_press_step(&s, true, PB_LONG_PRESS_MS - 1), PB_PRESS_NONE);
    // At threshold: LONG fires.
    ASSERT_EQ_INT(pb_press_step(&s, true, PB_LONG_PRESS_MS), PB_PRESS_LONG);
    // Subsequent held polls: idempotent (no re-fire) until LONG_LONG.
    ASSERT_EQ_INT(pb_press_step(&s, true, PB_LONG_PRESS_MS + 100), PB_PRESS_NONE);
    ASSERT_EQ_INT(pb_press_step(&s, true, PB_LONG_PRESS_MS + 1000), PB_PRESS_NONE);
}

static void test_long_press_inhibits_short_on_release(void) {
    pb_press_state_t s; pb_press_init(&s);
    pb_press_step(&s, true, 0);
    pb_press_step(&s, true, PB_LONG_PRESS_MS);  // emits LONG
    // Release after LONG: must NOT also emit SHORT.
    ASSERT_EQ_INT(pb_press_step(&s, false, PB_LONG_PRESS_MS + 50), PB_PRESS_NONE);
}

static void test_long_long_press_fires_once_at_threshold(void) {
    pb_press_state_t s; pb_press_init(&s);
    pb_press_step(&s, true, 0);
    // Walking through every 50 ms, LONG fires first at >= 700, LONG_LONG
    // fires at >= 10000.
    pb_press_out_t first_long = PB_PRESS_NONE;
    pb_press_out_t first_long_long = PB_PRESS_NONE;
    int64_t fired_long_at = -1;
    int64_t fired_long_long_at = -1;
    for (int64_t t = 50; t <= 11000; t += 50) {
        pb_press_out_t o = pb_press_step(&s, true, t);
        if (o == PB_PRESS_LONG && first_long == PB_PRESS_NONE) {
            first_long = o;
            fired_long_at = t;
        }
        if (o == PB_PRESS_LONG_LONG && first_long_long == PB_PRESS_NONE) {
            first_long_long = o;
            fired_long_long_at = t;
        }
    }
    ASSERT_EQ_INT(first_long, PB_PRESS_LONG);
    ASSERT_EQ_INT(first_long_long, PB_PRESS_LONG_LONG);
    // LONG fires at first poll >= 700ms; the 50-ms grid puts that at 700.
    ASSERT_EQ_INT(fired_long_at, PB_LONG_PRESS_MS);
    // LONG_LONG fires at first poll >= 10000ms.
    ASSERT_EQ_INT(fired_long_long_at, PB_LONG_LONG_PRESS_MS);
    // Threshold sanity: factory-reset gesture is 10 seconds.
    ASSERT_EQ_INT(PB_LONG_LONG_PRESS_MS, 10000);
}

static void test_long_long_press_just_below_threshold_no_fire(void) {
    pb_press_state_t s; pb_press_init(&s);
    pb_press_step(&s, true, 0);
    // Walk to 9999 ms — LONG must fire, LONG_LONG must NOT.
    pb_press_out_t first_long = PB_PRESS_NONE;
    pb_press_out_t first_long_long = PB_PRESS_NONE;
    hold_until(&s, 50, PB_LONG_LONG_PRESS_MS - 1, 50, &first_long, &first_long_long);
    ASSERT_EQ_INT(first_long, PB_PRESS_LONG);
    ASSERT_EQ_INT(first_long_long, PB_PRESS_NONE);
    // Release just under LONG_LONG: SHORT must NOT fire (LONG already did).
    ASSERT_EQ_INT(pb_press_step(&s, false, PB_LONG_LONG_PRESS_MS - 1), PB_PRESS_NONE);
}

static void test_long_long_press_inhibits_short_on_release(void) {
    pb_press_state_t s; pb_press_init(&s);
    pb_press_step(&s, true, 0);
    pb_press_step(&s, true, PB_LONG_PRESS_MS);            // LONG
    pb_press_step(&s, true, PB_LONG_LONG_PRESS_MS);       // LONG_LONG
    // Release: must NOT emit SHORT.
    ASSERT_EQ_INT(pb_press_step(&s, false, PB_LONG_LONG_PRESS_MS + 50), PB_PRESS_NONE);
}

static void test_release_then_re_press_resets_state(void) {
    pb_press_state_t s; pb_press_init(&s);
    pb_press_step(&s, true, 0);
    pb_press_step(&s, true, PB_LONG_PRESS_MS);  // LONG
    pb_press_step(&s, false, PB_LONG_PRESS_MS + 10);
    // New short press now.
    pb_press_step(&s, true, 5000);
    ASSERT_EQ_INT(pb_press_step(&s, false, 5200), PB_PRESS_SHORT);
}

static void test_threshold_values_match_spec(void) {
    // Documented in patch_button.h and README pairing-flow re-trigger.
    ASSERT_EQ_INT(PB_LONG_PRESS_MS, 700);
    ASSERT_EQ_INT(PB_LONG_LONG_PRESS_MS, 10000);
}

int main(void) {
    fprintf(stderr, "test_button\n");
    TEST_RUN(test_short_press_on_release);
    TEST_RUN(test_idle_release_emits_nothing);
    TEST_RUN(test_long_press_fires_once_at_threshold);
    TEST_RUN(test_long_press_inhibits_short_on_release);
    TEST_RUN(test_long_long_press_fires_once_at_threshold);
    TEST_RUN(test_long_long_press_just_below_threshold_no_fire);
    TEST_RUN(test_long_long_press_inhibits_short_on_release);
    TEST_RUN(test_release_then_re_press_resets_state);
    TEST_RUN(test_threshold_values_match_spec);
    return 0;
}
