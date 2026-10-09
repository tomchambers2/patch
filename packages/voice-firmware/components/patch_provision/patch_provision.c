// patch_provision — Wi-Fi BLE provisioning + QR-link pairing.
//
// Wi-Fi: wifi_provisioning_manager / scheme_ble. The HA companion app (and a
// generic Espressif `esp-idf-provisioning-android` build) can both drive
// this; the device shows a static Bluetooth name `PATCH-VOICE-XXXXXX` whose
// suffix doubles as the pairing-nonce display when it's also shown as a QR.
//
// QR-link pairing: implements the surface side of spec/10-auth.md §Surface
// linking. Generates Ed25519 keypair (mbedtls), POSTs the pubkey to
// /api/auth/pair/start, then a paired surface signs the credential and the
// daemon returns it via /api/auth/pair/complete; we poll.

#include "patch_provision.h"

#include <string.h>
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "nvs.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"
#include "esp_http_client.h"
#include "mbedtls/pk.h"
#include "mbedtls/base64.h"

static const char *TAG = "patch-provision";
#define NVS_NS "patch.cred"

static bool nvs_load_str(nvs_handle_t h, const char *k, char *out, size_t cap) {
    size_t len = cap;
    return nvs_get_str(h, k, out, &len) == ESP_OK;
}

bool patch_provision_load(patch_provision_state_t *out) {
    if (!out) return false;
    memset(out, 0, sizeof *out);
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;
    bool ok = true;
    ok &= nvs_load_str(h, "deviceId", out->device_id, sizeof out->device_id);
    ok &= nvs_load_str(h, "surfaceJwt", out->surface_jwt, sizeof out->surface_jwt);
    ok &= nvs_load_str(h, "daemonHost", out->daemon_host, sizeof out->daemon_host);
    int32_t port = 0;
    if (nvs_get_i32(h, "daemonPort", &port) != ESP_OK) ok = false;
    out->daemon_port = port;
    uint8_t tls = 0;
    if (nvs_get_u8(h, "tls", &tls) != ESP_OK) ok = false;
    out->tls = tls != 0;
    nvs_close(h);
    return ok;
}

static void persist(const patch_provision_state_t *s) {
    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NVS_NS, NVS_READWRITE, &h));
    ESP_ERROR_CHECK(nvs_set_str(h, "deviceId", s->device_id));
    ESP_ERROR_CHECK(nvs_set_str(h, "surfaceJwt", s->surface_jwt));
    ESP_ERROR_CHECK(nvs_set_str(h, "daemonHost", s->daemon_host));
    ESP_ERROR_CHECK(nvs_set_i32(h, "daemonPort", s->daemon_port));
    ESP_ERROR_CHECK(nvs_set_u8(h, "tls", s->tls ? 1 : 0));
    ESP_ERROR_CHECK(nvs_commit(h));
    nvs_close(h);
}

static void mac_device_id(char *out, size_t cap) {
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_efuse_mac_get_default(mac));
    snprintf(out, cap, "voice-pe-%02x%02x%02x", mac[3], mac[4], mac[5]);
}

void patch_provision_factory_reset(void) {
    ESP_LOGW(TAG, "factory reset: erasing NVS namespace '%s'", NVS_NS);
    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NVS_NS, NVS_READWRITE, &h));
    ESP_ERROR_CHECK(nvs_erase_all(h));
    ESP_ERROR_CHECK(nvs_commit(h));
    nvs_close(h);
}

bool patch_provision_run(patch_provision_state_t *out) {
    ESP_LOGI(TAG, "first-boot provisioning starting");

    // 1. Wi-Fi via BLE.
    wifi_prov_mgr_config_t prov_cfg = {
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };
    ESP_ERROR_CHECK(wifi_prov_mgr_init(prov_cfg));
    char service_name[32];
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_efuse_mac_get_default(mac));
    snprintf(service_name, sizeof service_name, "PATCH-VOICE-%02X%02X%02X", mac[3], mac[4], mac[5]);
    ESP_ERROR_CHECK(wifi_prov_mgr_start_provisioning(
        WIFI_PROV_SECURITY_1, "patch-pop", service_name, NULL));
    ESP_LOGI(TAG, "BLE provisioning advertising as %s; waiting for client", service_name);
    wifi_prov_mgr_wait();
    wifi_prov_mgr_deinit();
    ESP_LOGI(TAG, "wifi provisioned");

    // 2. QR-link pair (spec/10-auth.md §Surface linking). patch_pair_qr_link()
    // (patch_pair_qr.c) does the full flow: generate an Ed25519 keypair via the
    // libsodium component (pinned in idf_component.yml — mbedtls_pk ed25519 is
    // not in every IDF build), display the QR with the pairing nonce, POST
    // /api/auth/pair/start, and poll /api/auth/pair/complete for the
    // server-relayed subordinate surface credential.
    mac_device_id(out->device_id, sizeof out->device_id);

    extern bool patch_pair_qr_link(const char *device_id,
                                   char *daemon_host, size_t host_cap,
                                   int *daemon_port, bool *tls,
                                   char *surface_jwt, size_t jwt_cap);
    bool ok = patch_pair_qr_link(out->device_id,
                                 out->daemon_host, sizeof out->daemon_host,
                                 &out->daemon_port, &out->tls,
                                 out->surface_jwt, sizeof out->surface_jwt);
    if (!ok) {
        ESP_LOGE(TAG, "QR-link pairing failed");
        return false;
    }
    persist(out);
    ESP_LOGI(TAG, "provisioning complete: deviceId=%s daemon=%s:%d tls=%d",
             out->device_id, out->daemon_host, out->daemon_port, (int)out->tls);
    return true;
}
