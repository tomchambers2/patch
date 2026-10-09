// Ring lifecycle state machine for incoming patch calls.
//
// Per spec/16-voice-device.md §Patch-initiated calls (ringing):
//
//   1. Daemon sends `ring`. Device plays chime + LED rotation.
//   2. User presses button → `ring_accepted` → daemon sends `session_start`.
//   3. Or 30s elapses with no input → `ring_dismissed`, daemon falls through
//      to voicemail.
//
// Pure C, host-testable. Time is injected by the caller (`now_ms`) so the
// 30 s timeout can be exercised deterministically in unit tests.

#ifndef PATCH_RING_FSM_H
#define PATCH_RING_FSM_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PRF_TIMEOUT_MS 30000

typedef enum {
    PRF_IDLE = 0,
    PRF_RINGING,
    PRF_ACCEPTED,
    PRF_DISMISSED,
    PRF_TIMED_OUT,
} prf_state_t;

typedef enum {
    PRF_OUT_NONE = 0,
    PRF_OUT_RING_ACCEPTED,
    PRF_OUT_RING_DISMISSED_TIMEOUT,
    PRF_OUT_RING_DISMISSED_USER,
} prf_out_t;

typedef struct {
    prf_state_t state;
    int64_t started_at_ms;
} prf_t;

void prf_init(prf_t *r);

// Called when a ring frame arrives.
prf_out_t prf_on_ring(prf_t *r, int64_t now_ms);

// Called on button accept.
prf_out_t prf_on_accept(prf_t *r);

// Called on explicit user dismiss (long-press / mute / etc.).
prf_out_t prf_on_dismiss(prf_t *r);

// Called from a periodic tick. Returns PRF_OUT_RING_DISMISSED_TIMEOUT on
// the tick that crosses 30 s.
prf_out_t prf_tick(prf_t *r, int64_t now_ms);

#ifdef __cplusplus
}
#endif

#endif
