#include "patch_control.h"

#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_websocket_client.h"

static const char *TAG = "patch-control";

static patch_control_cfg_t s_cfg = {0};
static esp_websocket_client_handle_t s_ws = NULL;
static volatile bool s_linked = false;
static SemaphoreHandle_t s_lock = NULL;
static char *s_auth_header = NULL;  // heap-allocated "Authorization: Bearer <jwt>\r\n"; references s_cfg.bearer_jwt content once

static bool send_text_frame(const char *json, size_t len) {
    if (!s_ws || !esp_websocket_client_is_connected(s_ws)) return false;
    int sent = esp_websocket_client_send_text(s_ws, json, len, pdMS_TO_TICKS(200));
    return sent >= 0;
}

static void send_hello(void) {
    char buf[256];
    size_t n = 0;
    bool muted = s_cfg.get_muted ? s_cfg.get_muted(s_cfg.user) : false;
    pcf_status_t st = pcf_encode_hello(buf, sizeof buf, &n,
                                       s_cfg.device_id, s_cfg.fw_version, muted);
    if (st != PCF_OK) {
        ESP_LOGE(TAG, "encode hello failed: %d", (int)st);
        return;
    }
    if (!send_text_frame(buf, n)) ESP_LOGW(TAG, "hello send failed");
}

static void on_event(void *handler_args, esp_event_base_t base,
                     int32_t event_id, void *event_data) {
    (void)handler_args; (void)base;
    esp_websocket_event_data_t *d = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            ESP_LOGI(TAG, "control ws connected");
            s_linked = true;
            send_hello();
            if (s_cfg.on_link_up) s_cfg.on_link_up(s_cfg.user);
            break;
        case WEBSOCKET_EVENT_DATA: {
            if (d->op_code != 0x1 || d->data_len <= 0) break;  // text only
            pcf_inbound_t inb;
            pcf_status_t st = pcf_decode((const char *)d->data_ptr, d->data_len, &inb);
            if (st == PCF_ERR_UNKNOWN_FRAME) {
                ESP_LOGI(TAG, "ignoring unknown control frame");
                break;
            }
            if (st != PCF_OK) {
                ESP_LOGW(TAG, "control decode err=%d body=%.*s",
                         (int)st, (int)d->data_len, (const char *)d->data_ptr);
                break;
            }
            if (s_cfg.on_inbound) s_cfg.on_inbound(&inb, s_cfg.user);
            break;
        }
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
        case WEBSOCKET_EVENT_ERROR:
            if (s_linked) {
                ESP_LOGW(TAG, "control ws lost (event=%d)", (int)event_id);
                s_linked = false;
                if (s_cfg.on_link_down) s_cfg.on_link_down(s_cfg.user);
            }
            break;
        default: break;
    }
}

void patch_control_start(const patch_control_cfg_t *cfg) {
    if (!s_lock) s_lock = xSemaphoreCreateMutex();
    s_cfg = *cfg;

    static char uri[256];
    snprintf(uri, sizeof uri, "%s://%s:%d/device/control",
             cfg->use_tls ? "wss" : "ws",
             cfg->daemon_host, cfg->daemon_port);

    // Build the Authorization header once. We do not copy the JWT into a
    // BSS buffer — the JWT lives in s_cfg.bearer_jwt (which itself references
    // the provisioned credential owned by the caller). esp_websocket_client
    // only needs a single contiguous header string, so we heap-allocate
    // exactly the size required.
    if (s_auth_header) { free(s_auth_header); s_auth_header = NULL; }
    static const char kPrefix[] = "Authorization: Bearer ";
    static const char kSuffix[] = "\r\n";
    size_t jwt_len = cfg->bearer_jwt ? strlen(cfg->bearer_jwt) : 0;
    size_t hdr_len = sizeof(kPrefix) - 1 + jwt_len + sizeof(kSuffix) - 1 + 1;
    s_auth_header = (char *)malloc(hdr_len);
    if (!s_auth_header) {
        ESP_LOGE(TAG, "auth header alloc failed (%u bytes)", (unsigned)hdr_len);
        return;
    }
    snprintf(s_auth_header, hdr_len, "%s%s%s", kPrefix,
             cfg->bearer_jwt ? cfg->bearer_jwt : "", kSuffix);

    // Jittered initial reconnect: 1000–3000 ms. esp_websocket_client doubles
    // this up to network_timeout_ms (30 s) on subsequent failures, so a
    // fleet that loses power simultaneously will not synchronise its
    // reconnect attempts. Cap is bounded by network_timeout_ms below.
    const int kReconnectMinMs = 1000;
    const int kReconnectMaxMs = 3000;
    int reconnect_ms = kReconnectMinMs +
        (int)(esp_random() % (uint32_t)(kReconnectMaxMs - kReconnectMinMs + 1));

    esp_websocket_client_config_t wsc = {
        .uri = uri,
        .headers = s_auth_header,
        .reconnect_timeout_ms = reconnect_ms, // jittered initial; client doubles up to network_timeout_ms
        .network_timeout_ms = 30000,          // upper bound on backoff (spec/12)
        .ping_interval_sec = 20,
        .pingpong_timeout_sec = 10,
        .buffer_size = 2048,
        .disable_auto_reconnect = false,
        // Match the audio WSS: the default 4 KB websocket_task stack is tight
        // once the inbound handler decodes a session_start frame (which now
        // carries a ~350-byte voice-token JWT). 8 KB is safe headroom.
        .task_stack = 8192,
    };
    s_ws = esp_websocket_client_init(&wsc);
    if (!s_ws) {
        ESP_LOGE(TAG, "control ws init failed");
        return;
    }
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, on_event, NULL);
    ESP_ERROR_CHECK(esp_websocket_client_start(s_ws));
    ESP_LOGI(TAG, "control ws started uri=%s", uri);
}

bool patch_control_send_wake_detected(void) {
    char buf[64]; size_t n = 0;
    if (pcf_encode_wake_detected(buf, sizeof buf, &n) != PCF_OK) return false;
    return send_text_frame(buf, n);
}

bool patch_control_send_session_end(pcf_session_end_reason_t reason) {
    char buf[128]; size_t n = 0;
    if (pcf_encode_session_end(buf, sizeof buf, &n, reason) != PCF_OK) return false;
    return send_text_frame(buf, n);
}

bool patch_control_send_ring_accepted(void) {
    char buf[64]; size_t n = 0;
    if (pcf_encode_ring_accepted(buf, sizeof buf, &n) != PCF_OK) return false;
    return send_text_frame(buf, n);
}

bool patch_control_send_ring_dismissed(void) {
    char buf[64]; size_t n = 0;
    if (pcf_encode_ring_dismissed(buf, sizeof buf, &n) != PCF_OK) return false;
    return send_text_frame(buf, n);
}

bool patch_control_send_mute_changed(bool muted) {
    char buf[64]; size_t n = 0;
    if (pcf_encode_mute_changed(buf, sizeof buf, &n, muted) != PCF_OK) return false;
    return send_text_frame(buf, n);
}

bool patch_control_is_linked(void) {
    return s_linked;
}
