// LED ring pattern table. Encodes spec/16-voice-device.md §LED ring states
// in pure data so the host tests can verify it byte-for-byte and the
// runtime renderer can stay tiny.

#ifndef PATCH_LED_TABLE_H
#define PATCH_LED_TABLE_H

#include <stdint.h>
#include "patch_device_state.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PLP_OFF = 0,
    PLP_DIM_AMBIENT,    // idle
    PLP_SINGLE_PULSE,   // wake-detected
    PLP_STEADY_CYAN,    // listening
    PLP_PULSING_WHITE,  // agent-speaking
    PLP_YELLOW_ROTATE,  // ringing
    PLP_SOLID_RED,      // muted
    PLP_SLOW_RED_PULSE, // disconnected
    PLP_BLUE_ROTATE,    // pairing-in-progress
    PLP_MAGENTA_DOUBLE_PULSE, // pairing-failed
} plp_pattern_t;

// Aliases re-exported for the provisioning component. patch_provision can
// call patch_led_set(LED_STATE_PAIRING_IN_PROGRESS) without needing to
// include patch_device_state.h directly for these visual-only states.
#define LED_STATE_PAIRING_IN_PROGRESS PDS_STATE_PAIRING_IN_PROGRESS
#define LED_STATE_PAIRING_FAILED      PDS_STATE_PAIRING_FAILED

// True if the pattern animates over time (frame-dependent rendering). The
// renderer uses this to decide whether to keep ticking at 60 Hz or fall
// back to event-driven refresh on state change only.
int plp_is_animated(plp_pattern_t p);

// Precomputed pulse curve. 60 entries (one full cycle at 60 Hz). Each entry
// is a 0..255 brightness value. Used by the renderer instead of sinf().
// Period: caller picks stride. The curve is `0.5*(1 + sin(2pi*i/PLP_PULSE_TABLE_LEN))`
// scaled to 0..255.
#define PLP_PULSE_TABLE_LEN 60
extern const uint8_t plp_pulse_table[PLP_PULSE_TABLE_LEN];

// Pixel-buffer diff. Returns non-zero if any byte of the LED_COUNT*3 buffer
// differs. Pure C — defined in patch_led_diff.c so both the firmware
// renderer and host tests share a single implementation.
int patch_led_pixels_differ(const uint8_t *a, const uint8_t *b, int led_count);

typedef struct {
    uint8_t r, g, b;
    plp_pattern_t pattern;
} plp_descriptor_t;

// Map device state → LED descriptor. Stable, exhaustive — every pds_state_t
// has a row.
plp_descriptor_t plp_for_state(pds_state_t s);

const char *plp_pattern_str(plp_pattern_t p);

#ifdef __cplusplus
}
#endif

#endif
