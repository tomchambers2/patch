#include "patch_ring_fsm.h"

#include <stddef.h>

void prf_init(prf_t *r) {
    if (!r) return;
    r->state = PRF_IDLE;
    r->started_at_ms = 0;
}

prf_out_t prf_on_ring(prf_t *r, int64_t now_ms) {
    if (!r) return PRF_OUT_NONE;
    // Re-arming a ring is allowed (daemon could re-issue if it's the same
    // chat); we just reset the timer.
    r->state = PRF_RINGING;
    r->started_at_ms = now_ms;
    return PRF_OUT_NONE;
}

prf_out_t prf_on_accept(prf_t *r) {
    if (!r) return PRF_OUT_NONE;
    if (r->state != PRF_RINGING) return PRF_OUT_NONE;
    r->state = PRF_ACCEPTED;
    return PRF_OUT_RING_ACCEPTED;
}

prf_out_t prf_on_dismiss(prf_t *r) {
    if (!r) return PRF_OUT_NONE;
    if (r->state != PRF_RINGING) return PRF_OUT_NONE;
    r->state = PRF_DISMISSED;
    return PRF_OUT_RING_DISMISSED_USER;
}

prf_out_t prf_tick(prf_t *r, int64_t now_ms) {
    if (!r) return PRF_OUT_NONE;
    if (r->state != PRF_RINGING) return PRF_OUT_NONE;
    if (now_ms - r->started_at_ms < PRF_TIMEOUT_MS) return PRF_OUT_NONE;
    r->state = PRF_TIMED_OUT;
    return PRF_OUT_RING_DISMISSED_TIMEOUT;
}
