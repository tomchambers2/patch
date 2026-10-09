#include "patch_led.h"
#include "patch_led_table.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "led_strip.h"
#include "sdkconfig.h"

static const char *TAG = "patch-led";
#define LED_COUNT CONFIG_PATCH_LED_RING_COUNT
#define LED_GPIO  CONFIG_PATCH_LED_GPIO
#define TICK_HZ   60

static led_strip_handle_t s_strip = NULL;
static volatile pds_state_t s_state = PDS_STATE_DISCONNECTED;

// Shadow pixel buffers — `cur` is the buffer just rendered into via
// led_strip_set_pixel for this tick; `prev` is what was last pushed onto
// the wire. Comparing them lets us skip `led_strip_refresh` when the frame
// is identical (RMT bus would otherwise hold the line ~30 µs/LED). See
// pixels_differ() for the pure-C diff used here and in host tests.
static uint8_t s_cur[LED_COUNT][3];
static uint8_t s_prev[LED_COUNT][3];

static uint8_t scale(uint8_t v, uint8_t k_q8) {
    // k_q8 is 0..255. Round-half-up.
    return (uint8_t)(((unsigned)v * (unsigned)k_q8 + 127u) / 255u);
}

static void put(int idx, uint8_t r, uint8_t g, uint8_t b) {
    if (idx < 0 || idx >= LED_COUNT) return;
    s_cur[idx][0] = r;
    s_cur[idx][1] = g;
    s_cur[idx][2] = b;
}

static void render_solid(uint8_t r, uint8_t g, uint8_t b) {
    for (int i = 0; i < LED_COUNT; i++) put(i, r, g, b);
}

static void render_off(void) { render_solid(0, 0, 0); }

static void render_rotate(uint8_t r, uint8_t g, uint8_t b, int frame) {
    render_off();
    int head = frame % LED_COUNT;
    static const uint8_t trail_k[3] = { 255, 153, 61 }; // 1.0, 0.6, 0.24
    for (int i = 0; i < 3; i++) {
        int idx = (head + i) % LED_COUNT;
        put(idx, scale(r, trail_k[i]), scale(g, trail_k[i]), scale(b, trail_k[i]));
    }
}

// Pulse using the precomputed table. period_frames must be a multiple of
// PLP_PULSE_TABLE_LEN's period (we just stride through the table). min_k is
// 0..255 — mapped onto the trough of the curve.
static void render_pulse(uint8_t r, uint8_t g, uint8_t b, int frame, uint8_t min_k_q8, int period_frames) {
    int n = PLP_PULSE_TABLE_LEN;
    int idx = ((frame * n) / period_frames) % n;
    uint8_t curve = plp_pulse_table[idx];
    // map curve [0..255] onto [min_k_q8..255]
    unsigned k = min_k_q8 + ((255u - min_k_q8) * curve + 127u) / 255u;
    if (k > 255) k = 255;
    render_solid(scale(r, (uint8_t)k), scale(g, (uint8_t)k), scale(b, (uint8_t)k));
}

// Magenta double-pulse: two short pulses then quiet. 1.5 s period.
// Frames 0..15: pulse 1 up/down; 16..31: pulse 2; 32..89: off.
static void render_double_pulse(uint8_t r, uint8_t g, uint8_t b, int frame) {
    const int period = 90; // 1.5 s @ 60 Hz
    int p = frame % period;
    int k_q8 = 0;
    if (p < 16) {
        // triangle 0..255..0 over 16 frames
        k_q8 = (p < 8) ? (p * 32) : ((15 - p) * 32);
    } else if (p < 32) {
        int q = p - 16;
        k_q8 = (q < 8) ? (q * 32) : ((15 - q) * 32);
    }
    if (k_q8 < 0) k_q8 = 0;
    if (k_q8 > 255) k_q8 = 255;
    render_solid(scale(r, (uint8_t)k_q8), scale(g, (uint8_t)k_q8), scale(b, (uint8_t)k_q8));
}

static void push_to_strip(void) {
    for (int i = 0; i < LED_COUNT; i++) {
        led_strip_set_pixel(s_strip, i, s_cur[i][0], s_cur[i][1], s_cur[i][2]);
    }
    led_strip_refresh(s_strip);
    memcpy(s_prev, s_cur, sizeof s_cur);
}

static void renderer_task(void *arg) {
    (void)arg;
    int frame = 0;
    int single_pulse_at = -1;
    pds_state_t last = (pds_state_t)-1;
    // First push: ensure the strip is cleared and prev matches.
    memset(s_prev, 0xFF, sizeof s_prev); // force first push to differ
    for (;;) {
        pds_state_t cur = s_state;
        if (cur != last) {
            single_pulse_at = (cur == PDS_STATE_WAKE_DETECTED) ? frame : -1;
            last = cur;
        }
        plp_descriptor_t d = plp_for_state(cur);
        switch (d.pattern) {
            case PLP_OFF:            render_off(); break;
            case PLP_DIM_AMBIENT:    render_solid(d.r, d.g, d.b); break;
            case PLP_SINGLE_PULSE: {
                int dt = frame - single_pulse_at;
                if (dt < 0 || dt > TICK_HZ / 4) {
                    render_off();
                } else {
                    // Linear ramp down from 255 to 0 over TICK_HZ/4 frames.
                    int k_q8 = 255 - (dt * 255 / (TICK_HZ / 4));
                    if (k_q8 < 0) k_q8 = 0;
                    render_solid(scale(d.r, (uint8_t)k_q8), scale(d.g, (uint8_t)k_q8), scale(d.b, (uint8_t)k_q8));
                }
                break;
            }
            case PLP_STEADY_CYAN:    render_solid(d.r, d.g, d.b); break;
            // 1.5 s period @ 60 Hz = 90 frames. min_k ~ 0.15 → 38/255.
            case PLP_PULSING_WHITE:  render_pulse(d.r, d.g, d.b, frame, 38, 90); break;
            case PLP_YELLOW_ROTATE:  render_rotate(d.r, d.g, d.b, frame / 4); break;
            case PLP_SOLID_RED:      render_solid(d.r, d.g, d.b); break;
            // 3 s period = 180 frames. min_k ~ 0.05 → 13/255.
            case PLP_SLOW_RED_PULSE: render_pulse(d.r, d.g, d.b, frame, 13, 180); break;
            case PLP_BLUE_ROTATE:    render_rotate(d.r, d.g, d.b, frame / 4); break;
            case PLP_MAGENTA_DOUBLE_PULSE: render_double_pulse(d.r, d.g, d.b, frame); break;
        }
        // Skip the RMT refresh entirely if nothing changed since last push.
        if (patch_led_pixels_differ(&s_cur[0][0], &s_prev[0][0], LED_COUNT)) {
            push_to_strip();
        }
        // Static patterns can tick at half-rate — we still need to wake to
        // notice s_state changes promptly, but 30 Hz is plenty for that.
        int delay_ms = plp_is_animated(d.pattern) ? (1000 / TICK_HZ) : (1000 / (TICK_HZ / 2));
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
        frame++;
    }
}

void patch_led_init(void) {
#if CONFIG_PATCH_LED_POWER_GPIO >= 0
    // The HA Voice PE LED ring sits behind a power-enable rail (GPIO45 by
    // default). Without driving it HIGH the ring has no power and stays dark
    // even with a correct data pin — this was the cause of "no light".
    gpio_config_t pwr = {
        .pin_bit_mask = 1ULL << CONFIG_PATCH_LED_POWER_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&pwr));
    gpio_set_level(CONFIG_PATCH_LED_POWER_GPIO, 1);
    ESP_LOGI(TAG, "led ring power rail enabled: gpio=%d", CONFIG_PATCH_LED_POWER_GPIO);
#endif
    led_strip_config_t strip_cfg = {
        .strip_gpio_num = LED_GPIO,
        .max_leds = LED_COUNT,
        .led_model = LED_MODEL_WS2812,
        // led_strip 2.5.5 (pinned in idf_component.yml) uses led_pixel_format;
        // the color_component_format field only exists in 3.x. WS2812 is GRB.
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
    };
    led_strip_rmt_config_t rmt_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
        .flags = { .with_dma = false },
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip));
    led_strip_clear(s_strip);
    xTaskCreate(renderer_task, "patch-led", 4096, NULL, 4, NULL);
    ESP_LOGI(TAG, "led ring init: gpio=%d count=%d", LED_GPIO, LED_COUNT);
}

void patch_led_set(pds_state_t state) {
    s_state = state;
}
