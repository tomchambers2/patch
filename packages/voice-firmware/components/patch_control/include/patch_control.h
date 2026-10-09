// Persistent control WSS client.
//
// Connects to wss://<daemon>/device/control with the device's EdDSA-JWT
// surface credential as a Bearer header. On open, sends `hello`. Receives
// session_start / ring / led / error frames per spec/16-voice-device.md.
//
// Reconnects with exponential backoff (1s → 2s → 5s → 10s → 30s, capped
// at 30s) per spec/12-error-and-offline.md.

#ifndef PATCH_CONTROL_H
#define PATCH_CONTROL_H

#include <stdbool.h>
#include "patch_control_frames.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const char *daemon_host;
    int daemon_port;
    bool use_tls;
    const char *device_id;
    const char *fw_version;
    const char *bearer_jwt;     // EdDSA-JWT credential, Authorization: Bearer
    void (*on_inbound)(const pcf_inbound_t *frame, void *user);
    void (*on_link_up)(void *user);
    void (*on_link_down)(void *user);
    bool (*get_muted)(void *user);
    void *user;
} patch_control_cfg_t;

void patch_control_start(const patch_control_cfg_t *cfg);

// Send a device→daemon control frame. Returns false if not connected.
bool patch_control_send_wake_detected(void);
bool patch_control_send_session_end(pcf_session_end_reason_t reason);
bool patch_control_send_ring_accepted(void);
bool patch_control_send_ring_dismissed(void);
bool patch_control_send_mute_changed(bool muted);

bool patch_control_is_linked(void);

#ifdef __cplusplus
}
#endif

#endif
