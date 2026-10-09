// Action button + hardware mute switch GPIO handling.
//
// HA Voice Preview Edition has:
//   - One action button on GPIO0, active-low (short press = PTT / accept
//     ring; long press = dismiss ring / end session). NOT a capacitive pad.
//   - One mute switch (hardware level — when on, the I2S mic line is cut
//     by the audio codec, but firmware also detects the GPIO state to
//     drive LEDs and inform the daemon).
//
// Events are dispatched via a registered callback (`patch_button_handler_t`)
// from a dedicated FreeRTOS task; the callback runs in that task context, not
// in ISR.

#ifndef PATCH_BUTTON_H
#define PATCH_BUTTON_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PB_EV_SHORT_PRESS = 0,
    PB_EV_LONG_PRESS,
    // Long-long press (≥10 s hold) — used as the on-device factory-reset
    // gesture. Wires to patch_provision_factory_reset() inside the button
    // task; consumers do not need to handle this event themselves.
    PB_EV_LONG_LONG_PRESS,
    PB_EV_MUTE_ON,
    PB_EV_MUTE_OFF,
} pb_event_t;

// Press-duration thresholds, in milliseconds. Exposed for host-side tests.
#define PB_LONG_PRESS_MS       700
#define PB_LONG_LONG_PRESS_MS  10000

// Pure-C press-classifier state. Used both by the on-device task and by the
// host-test suite — no FreeRTOS / ESP-IDF dependencies. Drive it by feeding
// each poll's (pressed, now_ms) into pb_press_step().
typedef struct {
    bool was_pressed;
    bool long_emitted;
    bool long_long_emitted;
    int64_t press_start_ms;
} pb_press_state_t;

typedef enum {
    PB_PRESS_NONE = 0,
    PB_PRESS_SHORT,      // emitted on release before LONG threshold
    PB_PRESS_LONG,       // emitted while held, once LONG threshold crosses
    PB_PRESS_LONG_LONG,  // emitted while held, once LONG_LONG threshold crosses
} pb_press_out_t;

void pb_press_init(pb_press_state_t *s);
pb_press_out_t pb_press_step(pb_press_state_t *s, bool pressed, int64_t now_ms);

typedef void (*patch_button_handler_t)(pb_event_t ev, void *user);

void patch_button_init(patch_button_handler_t handler, void *user);

// Returns the current hardware mute switch state.
bool patch_button_is_muted(void);

// --- On-device bench actuation of the physical mute-switch line ---------------
//
// The mute switch is on CONFIG_PATCH_MUTE_SWITCH_GPIO (GPIO3). On the HA Voice
// PE this line is driven by onboard mute logic (an XMOS/mute buffer), not a
// passive switch-to-GND — the firmware reads muted == (gpio_get_level != 0)
// (resting un-muted == LOW). A remote agent cannot move the slider, and the
// pad must NOT be driven as an output (it would contend with the onboard
// buffer). So to exercise the *real* on-device mute response without a human,
// this overrides the level the poll task reads:
//
//   force=true  -> the poll task reads HIGH (muted). It debounces and runs the
//                  genuine PB_EV_MUTE_ON path on the flashed unit: control WSS
//                  mute_changed{muted:true}, muted LED, wakeword pause, in-flight
//                  session drop.
//   force=false -> release the override; the poll task reads the real GPIO3
//                  line again (PB_EV_MUTE_OFF when it returns to un-muted).
//
// This is a serial-console test seam, idle in normal operation. It runs the
// device's real button task + control client + LED driver — it is NOT the host
// FSM and substitutes only the single sensor read.
void patch_button_force_mute_line(bool force_muted);

// Reads the raw level on the mute-switch GPIO (0 == LOW, 1 == HIGH). Bench/diag
// only — used to confirm the resting polarity of the physical line.
int patch_button_read_mute_gpio(void);

// Reads the raw level on the action-button GPIO (GPIO0; 0 == LOW == pressed,
// 1 == HIGH == released, active-low with pull-up). Bench/diag only — used to
// confirm that a real physical press is actually reaching the firmware.
int patch_button_read_button_gpio(void);

// Bench/diag: override the action-button read so an unattended bench can drive
// genuine SHORT/LONG presses through the real press classifier + on_button path
// on the flashed unit (PTT/wake, ring accept, dismiss/end). 1 = hold the
// button, 0 = release it (this is what emits SHORT on a brief hold->release),
// -1 = release the override back to the physical GPIO0. Serial-console test
// seam; idle in normal operation.
void patch_button_force_press(int pressed);

#ifdef __cplusplus
}
#endif

#endif
