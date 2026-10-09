#include "patch_ring_fsm.h"
#include "test_helpers.h"

static void test_ring_then_accept(void) {
    prf_t r; prf_init(&r);
    prf_on_ring(&r, 1000);
    ASSERT_EQ_INT(r.state, PRF_RINGING);
    prf_out_t o = prf_on_accept(&r);
    ASSERT_EQ_INT(o, PRF_OUT_RING_ACCEPTED);
    ASSERT_EQ_INT(r.state, PRF_ACCEPTED);
}

static void test_ring_then_user_dismiss(void) {
    prf_t r; prf_init(&r);
    prf_on_ring(&r, 0);
    prf_out_t o = prf_on_dismiss(&r);
    ASSERT_EQ_INT(o, PRF_OUT_RING_DISMISSED_USER);
    ASSERT_EQ_INT(r.state, PRF_DISMISSED);
}

static void test_ring_30s_timeout(void) {
    prf_t r; prf_init(&r);
    prf_on_ring(&r, 0);
    // Tick at 29.9s — no fire.
    ASSERT_EQ_INT(prf_tick(&r, 29999), PRF_OUT_NONE);
    ASSERT_EQ_INT(r.state, PRF_RINGING);
    // Tick at 30s — fire.
    prf_out_t o = prf_tick(&r, 30000);
    ASSERT_EQ_INT(o, PRF_OUT_RING_DISMISSED_TIMEOUT);
    ASSERT_EQ_INT(r.state, PRF_TIMED_OUT);
    // Subsequent ticks are idempotent.
    ASSERT_EQ_INT(prf_tick(&r, 60000), PRF_OUT_NONE);
}

static void test_accept_outside_ringing_ignored(void) {
    prf_t r; prf_init(&r);
    ASSERT_EQ_INT(prf_on_accept(&r), PRF_OUT_NONE);
    ASSERT_EQ_INT(r.state, PRF_IDLE);
}

static void test_re_ring_resets_timer(void) {
    prf_t r; prf_init(&r);
    prf_on_ring(&r, 0);
    prf_on_ring(&r, 20000);     // re-ring at 20s
    ASSERT_EQ_INT(prf_tick(&r, 49999), PRF_OUT_NONE);
    ASSERT_EQ_INT(prf_tick(&r, 50000), PRF_OUT_RING_DISMISSED_TIMEOUT);
}

int main(void) {
    fprintf(stderr, "test_ring_fsm\n");
    TEST_RUN(test_ring_then_accept);
    TEST_RUN(test_ring_then_user_dismiss);
    TEST_RUN(test_ring_30s_timeout);
    TEST_RUN(test_accept_outside_ringing_ignored);
    TEST_RUN(test_re_ring_resets_timer);
    return 0;
}
