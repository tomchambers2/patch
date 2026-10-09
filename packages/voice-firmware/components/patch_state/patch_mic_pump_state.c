#include "patch_mic_pump_state.h"

#include <string.h>

void pmps_init(pmps_t *s) {
    memset(s, 0, sizeof(*s));
}

void pmps_subscribe(pmps_t *s, pmps_consumer_t c) {
    if ((int)c < 0 || c >= PMPS_CONSUMER_COUNT) return;
    s->consumer[c].subscribed = true;
}

void pmps_unsubscribe(pmps_t *s, pmps_consumer_t c) {
    if ((int)c < 0 || c >= PMPS_CONSUMER_COUNT) return;
    s->consumer[c].subscribed = false;
}

void pmps_set_muted(pmps_t *s, bool muted) {
    s->muted = muted;
}

bool pmps_should_publish(const pmps_t *s, pmps_consumer_t c) {
    if ((int)c < 0 || c >= PMPS_CONSUMER_COUNT) return false;
    if (s->muted) return false;
    return s->consumer[c].subscribed;
}

void pmps_record_publish(pmps_t *s, pmps_consumer_t c, bool ok) {
    if ((int)c < 0 || c >= PMPS_CONSUMER_COUNT) return;
    if (ok) s->consumer[c].delivered++;
    else    s->consumer[c].dropped++;
}

bool pmps_record_i2s_read(pmps_t *s, bool ok) {
    if (ok) {
        bool was_failing = s->i2s_read_failures > 0;
        s->i2s_read_failures = 0;
        // No log on recovery; caller can read the totals if it wants to.
        (void)was_failing;
        return false;
    }
    s->i2s_read_failures++;
    s->i2s_read_failures_total++;
    // Log on the very first failure, then every 100th consecutive failure.
    if (s->i2s_read_failures == 1) return true;
    if ((s->i2s_read_failures % 100) == 0) return true;
    return false;
}
