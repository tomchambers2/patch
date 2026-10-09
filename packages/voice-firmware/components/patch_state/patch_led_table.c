#include "patch_led_table.h"

#include <stddef.h>

plp_descriptor_t plp_for_state(pds_state_t s) {
    plp_descriptor_t d = { 0, 0, 0, PLP_OFF };
    switch (s) {
        // NB: the PLP_* pattern names are legacy labels for the *animation* only
        // (steady / pulse / rotate); the actual colour is the r,g,b here. Scheme
        // (2026-06-22, user-approved): asleep=off, listening=blue-steady,
        // speaking=green-breathe, ringing=purple-rotate — so listening vs
        // speaking are unmistakable (no more "everything white").
        case PDS_STATE_IDLE:           d = (plp_descriptor_t){  0,  0,  0, PLP_OFF }; break;
        case PDS_STATE_WAKE_DETECTED:  d = (plp_descriptor_t){255,255,255, PLP_SINGLE_PULSE }; break;
        case PDS_STATE_LISTENING:      d = (plp_descriptor_t){  0, 80,255, PLP_STEADY_CYAN }; break;   // blue, steady
        case PDS_STATE_AGENT_SPEAKING: d = (plp_descriptor_t){  0,255, 60, PLP_PULSING_WHITE }; break;  // green, breathe
        case PDS_STATE_RINGING:        d = (plp_descriptor_t){160,  0,255, PLP_YELLOW_ROTATE }; break;   // purple, rotate
        case PDS_STATE_MUTED:          d = (plp_descriptor_t){255,  0,  0, PLP_SOLID_RED }; break;
        case PDS_STATE_DISCONNECTED:   d = (plp_descriptor_t){128,  0,  0, PLP_SLOW_RED_PULSE }; break;
        case PDS_STATE_PAIRING_IN_PROGRESS: d = (plp_descriptor_t){  0, 80,255, PLP_BLUE_ROTATE }; break;
        case PDS_STATE_PAIRING_FAILED: d = (plp_descriptor_t){255,  0,255, PLP_MAGENTA_DOUBLE_PULSE }; break;
    }
    return d;
}

const char *plp_pattern_str(plp_pattern_t p) {
    switch (p) {
        case PLP_OFF:                  return "off";
        case PLP_DIM_AMBIENT:          return "dim-ambient";
        case PLP_SINGLE_PULSE:         return "single-pulse";
        case PLP_STEADY_CYAN:          return "steady-cyan";
        case PLP_PULSING_WHITE:        return "pulsing-white";
        case PLP_YELLOW_ROTATE:        return "yellow-rotate";
        case PLP_SOLID_RED:            return "solid-red";
        case PLP_SLOW_RED_PULSE:       return "slow-red-pulse";
        case PLP_BLUE_ROTATE:          return "blue-rotate";
        case PLP_MAGENTA_DOUBLE_PULSE: return "magenta-double-pulse";
    }
    return NULL;
}

int plp_is_animated(plp_pattern_t p) {
    switch (p) {
        case PLP_OFF:
        case PLP_DIM_AMBIENT:
        case PLP_STEADY_CYAN:
        case PLP_SOLID_RED:
            return 0;
        case PLP_SINGLE_PULSE:
        case PLP_PULSING_WHITE:
        case PLP_YELLOW_ROTATE:
        case PLP_SLOW_RED_PULSE:
        case PLP_BLUE_ROTATE:
        case PLP_MAGENTA_DOUBLE_PULSE:
            return 1;
    }
    return 0;
}

// Precomputed pulse curve: 0.5 * (1 + sin(2*pi*i/N)) * 255, rounded.
// Generated once at build time from a Python one-liner; baked here so the
// renderer can avoid sinf() per tick. N = 60 = TICK_HZ, one cycle per second
// at TICK_HZ tick.
const uint8_t plp_pulse_table[PLP_PULSE_TABLE_LEN] = {
    128, 141, 154, 167, 180, 192, 203, 213, 222, 230,
    237, 243, 247, 251, 253, 254, 253, 251, 247, 243,
    237, 230, 222, 213, 203, 192, 180, 167, 154, 141,
    128, 114, 101,  88,  75,  63,  52,  42,  33,  25,
     18,  12,   8,   4,   2,   1,   2,   4,   8,  12,
     18,  25,  33,  42,  52,  63,  75,  88, 101, 114,
};
