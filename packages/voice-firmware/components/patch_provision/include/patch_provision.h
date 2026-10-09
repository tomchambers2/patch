// First-boot provisioning:
//   1. Wi-Fi credentials via wifi_provisioning over BLE (HA app + esp-idf
//      provisioning protocols already speak this).
//   2. QR-link pairing with the patch host (per spec/10-auth.md):
//      - Generate Ed25519 keypair, persist to NVS.
//      - Display short pairing nonce (already-paired surface scans QR).
//      - POST /api/auth/pair/start, then poll /api/auth/pair/complete.
//      - Receive signed surface credential (EdDSA-JWT), persist.
//
// On subsequent boots, persisted Wi-Fi + JWT are used directly; no UI.

#ifndef PATCH_PROVISION_H
#define PATCH_PROVISION_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char device_id[64];     // generated on first boot, persisted thereafter
    char surface_jwt[1024]; // EdDSA-JWT bound to (deviceId, accountId)
    char daemon_host[128];  // resolved during pairing
    int  daemon_port;
    bool tls;
} patch_provision_state_t;

// Returns true if the device has Wi-Fi creds + a paired surface JWT.
bool patch_provision_load(patch_provision_state_t *out);

// Start the BLE provisioning + QR-link pairing flow. Blocks until both
// complete. On success, persists state and returns true.
bool patch_provision_run(patch_provision_state_t *out);

// Wipe the paired-credential NVS namespace ("patch.cred") so the next boot
// re-enters provisioning. Used by the on-device factory-reset gesture
// (long-long-press of the touch button, ≥10 s) and any future remote-wipe
// path. Caller is expected to esp_restart() after this returns. No fallback
// per spec/principles.md — failure to erase aborts via ESP_ERROR_CHECK.
void patch_provision_factory_reset(void);

#ifdef __cplusplus
}
#endif

#endif
