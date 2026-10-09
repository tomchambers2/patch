// WS2812 LED ring driver for the HA Voice PE.
//
// 12 RGB LEDs on a single GPIO. Driven via the espressif/led_strip component
// using RMT. Renderer thread owns a periodic 60 Hz tick; pattern + colour
// come from patch_led_table given the current pds_state_t.

#ifndef PATCH_LED_H
#define PATCH_LED_H

#include "patch_device_state.h"

#ifdef __cplusplus
extern "C" {
#endif

// Initialise GPIO + RMT. Must be called before patch_led_set().
void patch_led_init(void);

// Set the LED ring to render the pattern for the given device state.
// Called from any task; cheap (just stores the state, the renderer task
// picks it up next tick).
void patch_led_set(pds_state_t state);

#ifdef __cplusplus
}
#endif

#endif
