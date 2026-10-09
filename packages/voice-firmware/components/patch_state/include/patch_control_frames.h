// Control WSS frame encode/decode for the patch voice device.
//
// Wire shape per spec/16-voice-device.md §Wire protocol. Pure C, no ESP-IDF
// deps, so it builds and runs in a host-side unit-test harness too.
//
// JSON encode is hand-rolled (no cJSON dep) — frames are tiny and fixed-shape.
// Decode uses a forgiving but strict-on-required-fields parser hand-coded for
// the four daemon→device frames we care about: session_start, ring, led, error.
//
// NO FALLBACKS: parse failures return PCF_ERR_*, never silently coerce.

#ifndef PATCH_CONTROL_FRAMES_H
#define PATCH_CONTROL_FRAMES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PCF_DEVICE_ID_MAX 64
#define PCF_SESSION_ID_MAX 64
#define PCF_ACCOUNT_ID_MAX 64
#define PCF_CHAT_ID_MAX 128
#define PCF_FW_VERSION_MAX 32
#define PCF_MESSAGE_MAX 256
#define PCF_REASON_MAX 32
// Daemon-minted per-session voice token, pushed to the device in the
// control-plane session_start frame (spec/16 §Wire protocol "Voice-token
// delivery"). It is a base64url JWT carrying accountId/surfaceId/sessionId/
// chatId/exp/jti — ~350 bytes in practice, so the old 256-byte cap truncated
// it and pcf_decode rejected the frame with PCF_ERR_PARSE, blocking the audio
// session from ever opening after a wake. 1024 matches main.c's s_voice_token.
#define PCF_VOICE_TOKEN_MAX 1024

typedef enum {
    PCF_OK = 0,
    PCF_ERR_BUFFER = -1,
    PCF_ERR_PARSE = -2,
    PCF_ERR_MISSING = -3,
    PCF_ERR_TYPE = -4,
    PCF_ERR_UNKNOWN_FRAME = -5,
} pcf_status_t;

typedef enum {
    PCF_FRAME_UNKNOWN = 0,
    PCF_FRAME_SESSION_START,
    PCF_FRAME_RING,
    PCF_FRAME_LED,
    PCF_FRAME_ERROR,
} pcf_frame_kind_t;

typedef enum {
    PCF_LED_IDLE = 0,
    PCF_LED_LISTENING,
    PCF_LED_AGENT_SPEAKING,
    PCF_LED_RINGING,
} pcf_led_hint_t;

typedef enum {
    PCF_SESSION_END_VAD_TIMEOUT = 0,
    PCF_SESSION_END_USER_BUTTON,
    PCF_SESSION_END_AGENT_FINISHED,
} pcf_session_end_reason_t;

typedef struct {
    pcf_frame_kind_t kind;
    // session_start
    char session_id[PCF_SESSION_ID_MAX];
    // session_start: daemon-minted voice token the device replays as the
    // audio.session_start `token` field (spec/16 §Wire protocol). Required on
    // session_start — pcf_decode returns PCF_ERR_MISSING if absent.
    char voice_token[PCF_VOICE_TOKEN_MAX];
    // session_start: the accountId the device must declare on audio.session_start
    // so its identity matches the token's claims (the daemon hands it over so
    // the device never has to decode the opaque token). Required on
    // session_start.
    char account_id[PCF_ACCOUNT_ID_MAX];
    // ring + session_start: target chatId. On session_start the daemon sends the
    // chat the token is bound to (e.g. thread_speakers); the device replays it.
    char chat_id[PCF_CHAT_ID_MAX];
    char message[PCF_MESSAGE_MAX];
    bool has_message;
    bool conversational;
    // led
    pcf_led_hint_t led_hint;
    // error
    char error_message[PCF_MESSAGE_MAX];
} pcf_inbound_t;

// ---- Encoders (device → daemon) ----

// Encode { type:"hello", deviceId, fwVersion, muted }
pcf_status_t pcf_encode_hello(char *out, size_t out_cap, size_t *written,
                              const char *device_id, const char *fw_version,
                              bool muted);

// Encode { type:"wake_detected" }
pcf_status_t pcf_encode_wake_detected(char *out, size_t out_cap, size_t *written);

// Encode { type:"session_end", reason }
pcf_status_t pcf_encode_session_end(char *out, size_t out_cap, size_t *written,
                                    pcf_session_end_reason_t reason);

// Encode { type:"ring_accepted" }
pcf_status_t pcf_encode_ring_accepted(char *out, size_t out_cap, size_t *written);

// Encode { type:"ring_dismissed" }
pcf_status_t pcf_encode_ring_dismissed(char *out, size_t out_cap, size_t *written);

// Encode { type:"mute_changed", muted }
pcf_status_t pcf_encode_mute_changed(char *out, size_t out_cap, size_t *written,
                                     bool muted);

// ---- Audio-plane session-start envelope (device → daemon, audio WSS) ----
//
// The first frame the device sends after the per-session audio WSS connects.
// Wire shape per packages/wire/src/audio.ts `AudioSessionStartEvent`:
//
//   { "type":"audio.session_start", "sessionId", "accountId", "surfaceId",
//     "surfaceKind":"device", "deviceId", "chatId", "role":"voice-device-conv",
//     "token", "surfaceHasAec":false }
//
// This is the wire-contract heart of spec/16 §"Voice-token delivery":
//   - `token` is the daemon-pushed per-session voice token (from the
//     session_start CONTROL frame). The device NEVER mints or fetches it and
//     never calls the server's voice-token endpoint — it replays verbatim.
//   - `surfaceKind` is hard-coded "device" (never web/desktop/mobile).
//   - `surfaceHasAec` is hard-coded false (no hardware AEC; daemon runs AEC3).
//   - surfaceKind=="device" REQUIRES a non-empty deviceId (wire
//     validateDeviceIdCoupling); a missing/empty deviceId is a config bug, so
//     this returns PCF_ERR_MISSING rather than emitting an invalid frame.
//   - an empty token is likewise a config bug (the device must have received
//     the daemon's token first) and returns PCF_ERR_MISSING.
//
// Pure C, no ESP-IDF deps, so the exact bytes the device puts on the wire are
// exercised by the host-side unit harness (TF1 F1-11) — the same function the
// firmware's audio task calls, so there is no test/ship drift.
pcf_status_t pcf_encode_audio_session_start(char *out, size_t out_cap,
                                            size_t *written,
                                            const char *session_id,
                                            const char *account_id,
                                            const char *surface_id,
                                            const char *device_id,
                                            const char *chat_id,
                                            const char *voice_token);

// ---- Decoder (daemon → device) ----

// Parse a JSON control frame. Returns PCF_ERR_UNKNOWN_FRAME for type we
// don't recognise (caller should ignore-with-log per spec/principles).
pcf_status_t pcf_decode(const char *json, size_t len, pcf_inbound_t *out);

// Stringify the session-end reason exactly as the spec requires.
const char *pcf_session_end_reason_str(pcf_session_end_reason_t r);

#ifdef __cplusplus
}
#endif

#endif
