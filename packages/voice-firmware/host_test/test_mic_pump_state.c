// Tests for the single-producer mic pump state machine. Frames flow
// producer -> two consumers (wakeword, audio); a stalled consumer must not
// stall the producer — the producer drops the frame and the drop counter
// goes up.

#include "patch_mic_pump_state.h"
#include "test_helpers.h"

static void test_init_zeroes_everything(void) {
    pmps_t s; pmps_init(&s);
    ASSERT_FALSE(s.muted);
    for (int c = 0; c < PMPS_CONSUMER_COUNT; c++) {
        ASSERT_FALSE(s.consumer[c].subscribed);
        ASSERT_EQ_INT(s.consumer[c].dropped, 0);
        ASSERT_EQ_INT(s.consumer[c].delivered, 0);
    }
    ASSERT_EQ_INT(s.i2s_read_failures, 0);
    ASSERT_EQ_INT(s.i2s_read_failures_total, 0);
}

static void test_no_publish_when_unsubscribed(void) {
    pmps_t s; pmps_init(&s);
    ASSERT_FALSE(pmps_should_publish(&s, PMPS_CONSUMER_WAKEWORD));
    ASSERT_FALSE(pmps_should_publish(&s, PMPS_CONSUMER_AUDIO));
}

static void test_subscribe_then_publish(void) {
    pmps_t s; pmps_init(&s);
    pmps_subscribe(&s, PMPS_CONSUMER_WAKEWORD);
    ASSERT_TRUE(pmps_should_publish(&s, PMPS_CONSUMER_WAKEWORD));
    ASSERT_FALSE(pmps_should_publish(&s, PMPS_CONSUMER_AUDIO));
    pmps_subscribe(&s, PMPS_CONSUMER_AUDIO);
    ASSERT_TRUE(pmps_should_publish(&s, PMPS_CONSUMER_AUDIO));
}

static void test_subscribe_is_idempotent(void) {
    pmps_t s; pmps_init(&s);
    pmps_subscribe(&s, PMPS_CONSUMER_WAKEWORD);
    pmps_subscribe(&s, PMPS_CONSUMER_WAKEWORD);
    ASSERT_TRUE(s.consumer[PMPS_CONSUMER_WAKEWORD].subscribed);
    pmps_unsubscribe(&s, PMPS_CONSUMER_WAKEWORD);
    pmps_unsubscribe(&s, PMPS_CONSUMER_WAKEWORD);
    ASSERT_FALSE(s.consumer[PMPS_CONSUMER_WAKEWORD].subscribed);
}

static void test_mute_blocks_all_consumers(void) {
    pmps_t s; pmps_init(&s);
    pmps_subscribe(&s, PMPS_CONSUMER_WAKEWORD);
    pmps_subscribe(&s, PMPS_CONSUMER_AUDIO);
    pmps_set_muted(&s, true);
    ASSERT_FALSE(pmps_should_publish(&s, PMPS_CONSUMER_WAKEWORD));
    ASSERT_FALSE(pmps_should_publish(&s, PMPS_CONSUMER_AUDIO));
    pmps_set_muted(&s, false);
    ASSERT_TRUE(pmps_should_publish(&s, PMPS_CONSUMER_WAKEWORD));
    ASSERT_TRUE(pmps_should_publish(&s, PMPS_CONSUMER_AUDIO));
}

static void test_publish_records_delivered_and_dropped(void) {
    pmps_t s; pmps_init(&s);
    pmps_subscribe(&s, PMPS_CONSUMER_WAKEWORD);
    pmps_record_publish(&s, PMPS_CONSUMER_WAKEWORD, true);
    pmps_record_publish(&s, PMPS_CONSUMER_WAKEWORD, true);
    pmps_record_publish(&s, PMPS_CONSUMER_WAKEWORD, false);  // queue was full
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_WAKEWORD].delivered, 2);
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_WAKEWORD].dropped, 1);
    // Other consumer untouched.
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_AUDIO].delivered, 0);
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_AUDIO].dropped, 0);
}

static void test_i2s_read_failure_logging_is_rate_limited(void) {
    pmps_t s; pmps_init(&s);
    // First failure -> log.
    ASSERT_TRUE(pmps_record_i2s_read(&s, false));
    ASSERT_EQ_INT(s.i2s_read_failures, 1);
    // Failures 2..99 -> no log.
    for (int i = 0; i < 98; i++) {
        ASSERT_FALSE(pmps_record_i2s_read(&s, false));
    }
    ASSERT_EQ_INT(s.i2s_read_failures, 99);
    // 100th -> log.
    ASSERT_TRUE(pmps_record_i2s_read(&s, false));
    ASSERT_EQ_INT(s.i2s_read_failures, 100);
    // 101..199 -> no log.
    for (int i = 0; i < 99; i++) {
        ASSERT_FALSE(pmps_record_i2s_read(&s, false));
    }
    // 200th -> log.
    ASSERT_TRUE(pmps_record_i2s_read(&s, false));
    // Recovery resets the counter (no log on recovery).
    ASSERT_FALSE(pmps_record_i2s_read(&s, true));
    ASSERT_EQ_INT(s.i2s_read_failures, 0);
    // After recovery the next failure again logs (it's a "first" failure).
    ASSERT_TRUE(pmps_record_i2s_read(&s, false));
    ASSERT_TRUE(s.i2s_read_failures_total > 200);
}

static void test_only_producer_publishes_invariant(void) {
    // The state model itself enforces: consumers cannot read from I2S — they
    // only consume what the producer enqueues. We assert this by showing
    // that with no producer activity, delivered counts stay zero even when
    // consumers are subscribed (i.e. nothing happens automatically).
    pmps_t s; pmps_init(&s);
    pmps_subscribe(&s, PMPS_CONSUMER_WAKEWORD);
    pmps_subscribe(&s, PMPS_CONSUMER_AUDIO);
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_WAKEWORD].delivered, 0);
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_AUDIO].delivered, 0);
}

static void test_full_consumer_does_not_stall_other(void) {
    // If wakeword's queue is full and audio's is not, the producer drops the
    // wakeword frame and successfully delivers to audio. The two counters
    // are independent.
    pmps_t s; pmps_init(&s);
    pmps_subscribe(&s, PMPS_CONSUMER_WAKEWORD);
    pmps_subscribe(&s, PMPS_CONSUMER_AUDIO);
    for (int i = 0; i < 10; i++) {
        if (pmps_should_publish(&s, PMPS_CONSUMER_WAKEWORD)) {
            // Simulate every other wakeword publish failing (queue full).
            pmps_record_publish(&s, PMPS_CONSUMER_WAKEWORD, (i % 2) == 0);
        }
        if (pmps_should_publish(&s, PMPS_CONSUMER_AUDIO)) {
            pmps_record_publish(&s, PMPS_CONSUMER_AUDIO, true);
        }
    }
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_WAKEWORD].delivered, 5);
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_WAKEWORD].dropped, 5);
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_AUDIO].delivered, 10);
    ASSERT_EQ_INT(s.consumer[PMPS_CONSUMER_AUDIO].dropped, 0);
}

int main(void) {
    fprintf(stderr, "test_mic_pump_state\n");
    TEST_RUN(test_init_zeroes_everything);
    TEST_RUN(test_no_publish_when_unsubscribed);
    TEST_RUN(test_subscribe_then_publish);
    TEST_RUN(test_subscribe_is_idempotent);
    TEST_RUN(test_mute_blocks_all_consumers);
    TEST_RUN(test_publish_records_delivered_and_dropped);
    TEST_RUN(test_i2s_read_failure_logging_is_rate_limited);
    TEST_RUN(test_only_producer_publishes_invariant);
    TEST_RUN(test_full_consumer_does_not_stall_other);
    return 0;
}
