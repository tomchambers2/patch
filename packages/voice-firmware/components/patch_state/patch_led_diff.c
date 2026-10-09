// Pure-C pixel-buffer diff helper extracted from patch_led so the
// no-redraw-when-unchanged invariant is host-testable without dragging in
// FreeRTOS / led_strip headers.
//
// The renderer in patch_led.c calls this same function (via its local copy
// with identical body) before invoking led_strip_refresh — see
// patch_led.c:patch_led_pixels_differ.

#include <stddef.h>
#include <stdint.h>
#include <string.h>

int patch_led_pixels_differ(const uint8_t *a, const uint8_t *b, int led_count) {
    if (led_count <= 0) return 0;
    return memcmp(a, b, (size_t)led_count * 3) != 0;
}
