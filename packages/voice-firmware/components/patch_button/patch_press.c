// Pure-C button-press classifier. Split out from patch_button.c so the
// host-test harness can exercise the LONG / LONG_LONG threshold logic
// without pulling in FreeRTOS / ESP-IDF / driver headers.
//
// Semantics (per spec/16-voice-device.md §Button + fixes-23 #2):
//   - Short press     : emitted on release, only if neither LONG nor
//                       LONG_LONG fired during the hold.
//   - Long press      : emitted exactly once while held, when the duration
//                       first crosses PB_LONG_PRESS_MS. Inhibits SHORT.
//   - Long-long press : emitted exactly once while held, when the duration
//                       first crosses PB_LONG_LONG_PRESS_MS. Inhibits SHORT.
// One step = one poll. now_ms must be monotonic.

#include "patch_button.h"

void pb_press_init(pb_press_state_t *s) {
    s->was_pressed = false;
    s->long_emitted = false;
    s->long_long_emitted = false;
    s->press_start_ms = 0;
}

pb_press_out_t pb_press_step(pb_press_state_t *s, bool pressed, int64_t now_ms) {
    pb_press_out_t out = PB_PRESS_NONE;
    if (pressed && !s->was_pressed) {
        s->press_start_ms = now_ms;
        s->long_emitted = false;
        s->long_long_emitted = false;
    } else if (pressed && s->was_pressed) {
        int64_t held = now_ms - s->press_start_ms;
        if (!s->long_long_emitted && held >= PB_LONG_LONG_PRESS_MS) {
            s->long_long_emitted = true;
            // Ensure long_emitted is also set so that any subsequent release
            // does not fire SHORT.
            s->long_emitted = true;
            out = PB_PRESS_LONG_LONG;
        } else if (!s->long_emitted && held >= PB_LONG_PRESS_MS) {
            s->long_emitted = true;
            out = PB_PRESS_LONG;
        }
    } else if (!pressed && s->was_pressed) {
        if (!s->long_emitted && !s->long_long_emitted) {
            out = PB_PRESS_SHORT;
        }
    }
    s->was_pressed = pressed;
    return out;
}
