// OTA via esp_https_ota. Polls the patch server's
// `GET /api/firmware/voice-device/manifest.json` once per hour, compares
// `latestVersion` to the running firmware, and pulls + applies a new image
// when present. Verifies image signature using the secure-boot v2 chain.

#ifndef PATCH_OTA_H
#define PATCH_OTA_H

#ifdef __cplusplus
extern "C" {
#endif

void patch_ota_start(const char *running_version);

#ifdef __cplusplus
}
#endif

#endif
