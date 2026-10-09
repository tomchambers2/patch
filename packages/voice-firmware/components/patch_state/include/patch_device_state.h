// Master device state machine for the patch voice device.
//
// One state per row in spec/16-voice-device.md §LED ring states. The state is
// driven by external events (wake-detected, audio session up/down, daemon
// link up/down, mute switch, ring lifecycle) and emits the LED pattern to
// render.
//
// Pure C, host-testable.

#ifndef PATCH_DEVICE_STATE_H
#define PATCH_DEVICE_STATE_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PDS_STATE_DISCONNECTED = 0,  // No control WSS — slow red pulse.
    PDS_STATE_IDLE,              // Waiting for wake word — off / dim ambient.
    PDS_STATE_WAKE_DETECTED,     // Just fired — single pulse (transient).
    PDS_STATE_LISTENING,         // User speaking — steady cyan.
    PDS_STATE_AGENT_SPEAKING,    // TTS playing — pulsing white.
    PDS_STATE_RINGING,           // Incoming patch call — yellow rotation.
    PDS_STATE_MUTED,             // Hardware mute switch on — solid red.
    PDS_STATE_PAIRING_IN_PROGRESS, // QR/BLE pairing handshake running — blue rotation.
    PDS_STATE_PAIRING_FAILED,    // Pairing handshake failed — magenta double pulse.
} pds_state_t;

// Inputs.
typedef enum {
    PDS_EV_LINK_UP = 0,
    PDS_EV_LINK_DOWN,
    PDS_EV_MUTE_ON,
    PDS_EV_MUTE_OFF,
    PDS_EV_WAKE_FIRED,
    PDS_EV_AUDIO_SESSION_OPENED,    // local mic-up streaming
    PDS_EV_AUDIO_SESSION_CLOSED,
    PDS_EV_TTS_STARTED,             // first daemon→device PCM frame for this session
    PDS_EV_TTS_ENDED,               // daemon finished or barge-in
    PDS_EV_RING_RECEIVED,
    PDS_EV_RING_ACCEPTED,
    PDS_EV_RING_DISMISSED,
    PDS_EV_RING_TIMEOUT,
} pds_event_t;

typedef struct {
    pds_state_t state;
    bool muted;
    bool linked;        // control WSS up
    bool ringing;
    bool session_open;  // audio WSS open
    bool agent_speaking;
} pds_t;

void pds_init(pds_t *s);
void pds_dispatch(pds_t *s, pds_event_t ev);
const char *pds_state_str(pds_state_t s);

#ifdef __cplusplus
}
#endif

#endif
