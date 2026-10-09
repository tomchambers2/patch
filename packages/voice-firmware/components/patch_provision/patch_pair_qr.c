// QR-link pairing — surface side of spec/10-auth.md.
//
// Flow:
//   1. Generate Ed25519 keypair (libsodium), persist private key to NVS.
//   2. POST /api/auth/pair/start  body: { surfacePublicKey, surfaceKind:"voice-device", deviceId, label }
//      → receives a short pairing nonce. Display it (LED ring colour code +
//      log it; the user prints it from the daemon's UI to confirm). The QR
//      itself is rendered on the daemon's web UI side; the device's role
//      here is to publish its pubkey + nonce and wait.
//   3. Poll /api/auth/pair/complete?nonce=...  every 1.5s for up to 5 min,
//      until the body returns the signed credential.
//   4. Persist `surface_jwt`, `daemon_host`, `daemon_port`, `tls`.

#include "patch_provision.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_client.h"
#include "nvs.h"
#include "sodium.h"
#include "mbedtls/base64.h"
#include "sdkconfig.h"

static const char *TAG = "patch-pair";
#define NVS_NS "patch.cred"

static bool b64url(const uint8_t *in, size_t in_len, char *out, size_t cap) {
    size_t olen = 0;
    int rc = mbedtls_base64_encode((unsigned char *)out, cap, &olen, in, in_len);
    if (rc != 0) return false;
    // base64url: strip trailing '=', replace '+' '/' with '-' '_'.
    while (olen && out[olen - 1] == '=') olen--;
    out[olen] = '\0';
    for (size_t i = 0; i < olen; i++) {
        if (out[i] == '+') out[i] = '-';
        else if (out[i] == '/') out[i] = '_';
    }
    return true;
}

static bool generate_or_load_keypair(uint8_t *pub /*32*/, uint8_t *priv /*64*/) {
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    size_t plen = 64;
    if (nvs_get_blob(h, "ed25519priv", priv, &plen) == ESP_OK && plen == 64) {
        size_t qlen = 32;
        if (nvs_get_blob(h, "ed25519pub", pub, &qlen) == ESP_OK && qlen == 32) {
            nvs_close(h);
            return true;
        }
    }
    crypto_sign_keypair(pub, priv);
    ESP_ERROR_CHECK(nvs_set_blob(h, "ed25519pub", pub, 32));
    ESP_ERROR_CHECK(nvs_set_blob(h, "ed25519priv", priv, 64));
    ESP_ERROR_CHECK(nvs_commit(h));
    nvs_close(h);
    return true;
}

static esp_err_t http_collect(esp_http_client_handle_t c, char *out, size_t cap, int *body_len) {
    esp_err_t err = esp_http_client_open(c, 0);
    if (err != ESP_OK) return err;
    esp_http_client_fetch_headers(c);
    int total = 0;
    while (total < (int)cap - 1) {
        int r = esp_http_client_read(c, out + total, cap - 1 - total);
        if (r <= 0) break;
        total += r;
    }
    out[total] = '\0';
    *body_len = total;
    esp_http_client_close(c);
    return ESP_OK;
}

static bool pair_start(const char *base_url, const char *pubkey_b64,
                       const char *device_id, char *nonce, size_t nonce_cap) {
    char url[256];
    snprintf(url, sizeof url, "%s/api/auth/pair/start", base_url);
    char body[512];
    int n = snprintf(body, sizeof body,
        "{\"surfacePublicKey\":\"%s\",\"surfaceKind\":\"voice-device\","
        "\"label\":\"%s\"}", pubkey_b64, device_id);
    if (n <= 0 || n >= (int)sizeof body) return false;

    esp_http_client_config_t cfg = { .url = url, .method = HTTP_METHOD_POST };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    esp_http_client_set_post_field(c, body, n);
    char resp[512]; int rlen = 0;
    esp_err_t err = http_collect(c, resp, sizeof resp, &rlen);
    int status = esp_http_client_get_status_code(c);
    esp_http_client_cleanup(c);
    if (err != ESP_OK || status != 200) {
        ESP_LOGE(TAG, "pair/start status=%d body=%s", status, resp);
        return false;
    }
    // Strict parse: extract "nonce":"..."
    const char *p = strstr(resp, "\"nonce\":\"");
    if (!p) return false;
    p += strlen("\"nonce\":\"");
    const char *q = strchr(p, '"');
    if (!q) return false;
    size_t L = (size_t)(q - p);
    if (L >= nonce_cap) return false;
    memcpy(nonce, p, L);
    nonce[L] = '\0';
    return true;
}

static bool pair_poll_complete(const char *base_url, const char *nonce,
                               char *jwt, size_t jwt_cap) {
    char url[256];
    snprintf(url, sizeof url, "%s/api/auth/pair/complete?nonce=%s", base_url, nonce);
    for (int i = 0; i < 200; i++) {
        esp_http_client_config_t cfg = { .url = url, .method = HTTP_METHOD_GET };
        esp_http_client_handle_t c = esp_http_client_init(&cfg);
        char resp[1280]; int rlen = 0;
        esp_err_t err = http_collect(c, resp, sizeof resp, &rlen);
        int status = esp_http_client_get_status_code(c);
        esp_http_client_cleanup(c);
        if (err == ESP_OK && status == 200) {
            const char *p = strstr(resp, "\"credential\":\"");
            if (p) {
                p += strlen("\"credential\":\"");
                const char *q = strchr(p, '"');
                if (q) {
                    size_t L = (size_t)(q - p);
                    if (L >= jwt_cap) return false;
                    memcpy(jwt, p, L);
                    jwt[L] = '\0';
                    return true;
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
    return false;
}

bool patch_pair_qr_link(const char *device_id,
                        char *daemon_host, size_t host_cap,
                        int *daemon_port, bool *tls,
                        char *surface_jwt, size_t jwt_cap) {
    if (sodium_init() < 0) {
        ESP_LOGE(TAG, "sodium_init failed");
        return false;
    }
    uint8_t pub[32], priv[64];
    if (!generate_or_load_keypair(pub, priv)) return false;
    char pub_b64[64];
    if (!b64url(pub, sizeof pub, pub_b64, sizeof pub_b64)) return false;

    // Server URL is a compile-time constant for v1 — the device knows its
    // patch server because the user flashed it with their PATCH_SERVER_URL.
    const char *base = CONFIG_PATCH_SERVER_URL;
    char nonce[96];
    if (!pair_start(base, pub_b64, device_id, nonce, sizeof nonce)) return false;
    ESP_LOGI(TAG, "pairing nonce ready: %s — confirm from a paired surface", nonce);

    if (!pair_poll_complete(base, nonce, surface_jwt, jwt_cap)) return false;

    // Daemon host = same host as the patch server in v1 (single-host topology
    // per spec/02-daemon.md and spec/11-deployment.md). Port + TLS from
    // Kconfig.
    snprintf(daemon_host, host_cap, "%s", CONFIG_PATCH_DAEMON_HOST);
    *daemon_port = CONFIG_PATCH_DAEMON_PORT;
    // CONFIG_PATCH_DAEMON_TLS is a Kconfig bool: defined as 1 when enabled,
    // entirely UNDEFINED when disabled (not 0). Guard with #ifdef so the
    // TLS=n configuration still compiles.
#ifdef CONFIG_PATCH_DAEMON_TLS
    *tls = true;
#else
    *tls = false;
#endif
    return true;
}
