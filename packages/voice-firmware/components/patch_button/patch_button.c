#include "patch_button.h"
#include "patch_provision.h"

#include <stdbool.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "sdkconfig.h"

static const char *TAG = "patch-button";
#define MUTE_GPIO            CONFIG_PATCH_MUTE_SWITCH_GPIO
// HA Voice PE action button: plain GPIO0, active-LOW with internal pull-up
// (ESPHome `pin: { number: GPIO0, inverted: true }`). Held => level 0.
#define BUTTON_GPIO          CONFIG_PATCH_BUTTON_GPIO
#define POLL_MS              20

static patch_button_handler_t s_handler = NULL;
static void *s_user = NULL;
static volatile bool s_muted = false;

// Bench/diag override of the mute-switch read. -1 == no override (read the real
// GPIO3 line); 0/1 == force that logical level into the poll task. This exists
// because on the HA Voice PE the mute line (GPIO3) is driven by onboard logic
// (an XMOS/mute buffer), not a passive switch-to-GND, so the firmware cannot
// safely drive the pad as an output to emulate the slider without contending
// with that buffer. Overriding the *read* lets an unattended bench exercise the
// full real on-device mute response (poll-task debounce -> PB_EV_MUTE_ON ->
// daemon mute_changed frame, muted LED, wake/session suppression) on the flashed
// unit. It is not normal operation and not the host FSM — it drives the device's
// real button task + control WSS + LED driver.
static volatile int s_mute_read_override = -1;

static inline int read_mute_level(void) {
    int o = s_mute_read_override;
    return (o < 0) ? gpio_get_level(MUTE_GPIO) : o;
}

// Bench/diag override of the action-button read, same rationale as the mute
// override: a remote agent cannot physically press the button, so this forces
// the "pressed" state the poll task sees, running the genuine press classifier
// + on_button() path on the flashed unit (PTT/wake, ring accept, dismiss/end).
// -1 == no override (read real GPIO0); 0/1 == force released/pressed.
static volatile int s_button_press_override = -1;

static inline bool read_button_pressed(void) {
    int o = s_button_press_override;
    return (o < 0) ? (gpio_get_level(BUTTON_GPIO) == 0) : (o != 0);
}

static void emit(pb_event_t ev) {
    if (s_handler) s_handler(ev, s_user);
}

// Press-classification logic lives in patch_press.c (pure C, host-testable).

static void task(void *arg) {
    (void)arg;
    pb_press_state_t press;
    pb_press_init(&press);
    bool last_mute = read_mute_level() != 0;
    s_muted = last_mute;
    emit(last_mute ? PB_EV_MUTE_ON : PB_EV_MUTE_OFF);

    for (;;) {
        // Mute switch — debounced over two consecutive polls.
        bool m_now = read_mute_level() != 0;
        if (m_now != last_mute) {
            // Re-read after a short delay to debounce.
            vTaskDelay(pdMS_TO_TICKS(10));
            bool m_again = read_mute_level() != 0;
            if (m_again == m_now) {
                last_mute = m_now;
                s_muted = m_now;
                emit(m_now ? PB_EV_MUTE_ON : PB_EV_MUTE_OFF);
            }
        }

        // Action button on GPIO0 is active-LOW (inverted, internal pull-up):
        // the pin reads 0 while the button is held, 1 when released.
        bool pressed = read_button_pressed();
        int64_t now_ms = esp_timer_get_time() / 1000;
        pb_press_out_t o = pb_press_step(&press, pressed, now_ms);
        switch (o) {
            case PB_PRESS_SHORT:
                emit(PB_EV_SHORT_PRESS);
                break;
            case PB_PRESS_LONG:
                emit(PB_EV_LONG_PRESS);
                break;
            case PB_PRESS_LONG_LONG:
                ESP_LOGW(TAG, "long-long press (>=%d ms): factory-reset gesture",
                         PB_LONG_LONG_PRESS_MS);
                emit(PB_EV_LONG_LONG_PRESS);
                // Wipe the paired-credential namespace and reboot so the
                // device returns to first-boot provisioning. Per
                // spec/principles.md there is no fallback: if the erase
                // fails the call aborts via ESP_ERROR_CHECK inside
                // patch_provision_factory_reset().
                patch_provision_factory_reset();
                esp_restart();
                break;
            case PB_PRESS_NONE:
                break;
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

void patch_button_init(patch_button_handler_t handler, void *user) {
    s_handler = handler;
    s_user = user;
    // Mute switch (GPIO3) and action button (GPIO0) are both inputs with
    // internal pull-ups; the action button is active-low.
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << MUTE_GPIO) | (1ULL << BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));

    xTaskCreate(task, "patch-btn", 3072, NULL, 5, NULL);
    ESP_LOGI(TAG, "button + mute switch init (button gpio=%d active-low, mute gpio=%d)",
             BUTTON_GPIO, MUTE_GPIO);
}

bool patch_button_is_muted(void) {
    return s_muted;
}

int patch_button_read_mute_gpio(void) {
    return gpio_get_level(MUTE_GPIO);
}

int patch_button_read_button_gpio(void) {
    return gpio_get_level(BUTTON_GPIO);
}

void patch_button_force_press(int pressed) {
    // pressed: 1 = hold, 0 = release, -1 = release override back to real GPIO0.
    s_button_press_override = pressed;
    ESP_LOGW(TAG, "bench: button press override = %s",
             pressed > 0 ? "HELD" : (pressed == 0 ? "RELEASED" : "off->physical"));
}

void patch_button_force_mute_line(bool force_muted) {
    // muted == (level != 0): HIGH == muted on this unit (resting un-muted = LOW).
    // Override the level the poll task reads; the poll task then debounces it and
    // runs the genuine PB_EV_MUTE_ON/OFF path on the real device — control WSS
    // send, muted LED, wakeword pause. No synthetic event is injected and the
    // pad is never driven as an output (the line is buffer-driven on this board,
    // so driving it would contend with the onboard mute logic).
    // force_muted=true pins the read HIGH (muted); false releases the override
    // (-1) so the poll task reads the real physical line again.
    s_mute_read_override = force_muted ? 1 : -1;
    ESP_LOGW(TAG, "bench: mute read override = %s (gpio=%d)",
             force_muted ? "MUTED(HIGH)" : "RELEASED->physical-line", MUTE_GPIO);
}
