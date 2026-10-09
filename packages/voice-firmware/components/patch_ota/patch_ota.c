#include "patch_ota.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_timer.h"
#include "sdkconfig.h"

static const char *TAG = "patch-ota";
#define MANIFEST_URL_FMT "%s/api/firmware/voice-device/manifest.json"

// Default cadence: 1 hour between OTA manifest checks. Implemented as a
// one-shot esp_timer that re-arms itself in the callback so the cadence is
// adjustable at runtime (e.g. a future control-WSS frame can call
// patch_ota_check_now() to trigger an early check without waiting out the
// full hour).
#define OTA_POLL_INTERVAL_US ((uint64_t)60 * 60 * 1000 * 1000)

static esp_timer_handle_t s_ota_timer = NULL;
static const char *s_running_version = NULL;
static volatile bool s_check_in_flight = false;

static bool fetch_manifest(char *out, size_t cap, int *body_len) {
    char url[256];
    snprintf(url, sizeof url, MANIFEST_URL_FMT, CONFIG_PATCH_SERVER_URL);
    esp_http_client_config_t cfg = { .url = url, .method = HTTP_METHOD_GET };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;
    esp_err_t err = esp_http_client_open(c, 0);
    if (err != ESP_OK) { esp_http_client_cleanup(c); return false; }
    esp_http_client_fetch_headers(c);
    int total = 0;
    while (total < (int)cap - 1) {
        int r = esp_http_client_read(c, out + total, cap - 1 - total);
        if (r <= 0) break;
        total += r;
    }
    out[total] = '\0';
    *body_len = total;
    int status = esp_http_client_get_status_code(c);
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return status == 200;
}

static bool extract_str(const char *body, const char *key, char *out, size_t cap) {
    char needle[64];
    snprintf(needle, sizeof needle, "\"%s\":\"", key);
    const char *p = strstr(body, needle);
    if (!p) return false;
    p += strlen(needle);
    const char *q = strchr(p, '"');
    if (!q) return false;
    size_t L = (size_t)(q - p);
    if (L >= cap) return false;
    memcpy(out, p, L);
    out[L] = '\0';
    return true;
}

static void run_check(void) {
    char manifest[1024]; int blen = 0;
    if (fetch_manifest(manifest, sizeof manifest, &blen)) {
        char latest[32], firmware_url[256];
        if (extract_str(manifest, "latestVersion", latest, sizeof latest) &&
            extract_str(manifest, "url", firmware_url, sizeof firmware_url) &&
            strcmp(latest, s_running_version) != 0) {
            ESP_LOGI(TAG, "OTA upgrade %s -> %s from %s", s_running_version, latest, firmware_url);
            esp_http_client_config_t hcfg = {
                .url = firmware_url,
                .timeout_ms = 30000,
                .keep_alive_enable = true,
            };
            esp_https_ota_config_t ocfg = { .http_config = &hcfg };
            esp_err_t err = esp_https_ota(&ocfg);
            if (err == ESP_OK) {
                ESP_LOGI(TAG, "OTA success — rebooting");
                esp_restart();
            } else {
                ESP_LOGE(TAG, "OTA failed: %d", err);
            }
        }
    }
}

static void check_task(void *arg) {
    (void)arg;
    run_check();
    s_check_in_flight = false;
    // Re-arm the one-shot timer for the next poll cycle.
    if (s_ota_timer) {
        esp_err_t err = esp_timer_start_once(s_ota_timer, OTA_POLL_INTERVAL_US);
        if (err != ESP_OK) ESP_LOGE(TAG, "esp_timer_start_once failed: %d", err);
    }
    vTaskDelete(NULL);
}

static void timer_cb(void *arg) {
    (void)arg;
    if (s_check_in_flight) return;
    s_check_in_flight = true;
    // OTA work blocks on HTTPS + flash erase/write; do not run on the
    // esp_timer dispatch task. Spawn a one-shot worker; it re-arms the
    // timer when done.
    BaseType_t ok = xTaskCreate(check_task, "patch-ota", 8192, NULL, 3, NULL);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "ota worker spawn failed");
        s_check_in_flight = false;
        // Re-arm even on spawn failure so we try again next cycle.
        if (s_ota_timer) {
            esp_timer_start_once(s_ota_timer, OTA_POLL_INTERVAL_US);
        }
    }
}

void patch_ota_start(const char *running_version) {
    s_running_version = running_version;
    const esp_timer_create_args_t args = {
        .callback = timer_cb,
        .arg = NULL,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "patch-ota",
        .skip_unhandled_events = true,
    };
    esp_err_t err = esp_timer_create(&args, &s_ota_timer);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_create failed: %d", err);
        return;
    }
    err = esp_timer_start_once(s_ota_timer, OTA_POLL_INTERVAL_US);
    if (err != ESP_OK) ESP_LOGE(TAG, "esp_timer_start_once failed: %d", err);
}
