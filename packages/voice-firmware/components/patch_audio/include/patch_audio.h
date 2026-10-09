// I2S audio in/out + per-session audio WSS client.
//
// Mic: TLV320AIC3204 codec ADC on I2S0 (RX), clock-secondary (XMOS supplies
// the clocks). 32-bit slots packed to PCM16 mono 16 kHz before transmitting,
// per spec/16-voice-device.md. See patch_codec for codec/XMOS/amp bring-up.
// Speaker: AIC3204 codec DAC on I2S1 (TX), clock-secondary. Plays back PCM16
// 16 kHz from the daemon (widened to 32-bit slots for the codec).
//
// One audio session = one WSS connection to wss://<daemon>/audio/<sessionId>.
// First frame is the JSON `audio.session_start` per packages/wire/src/audio.ts.
// Then bidirectional: out are binary PCM16 frames (~20 ms each, ~640 bytes);
// in are interleaved JSON envelopes + binary PCM16 frames.
//
// The daemon runs end-of-utterance VAD on its side and decides session end;
// the firmware also has its own button + mute interrupt that can cut the
// session locally (in which case it emits `session_end` on the *control*
// WSS, not the audio one).

#ifndef PATCH_AUDIO_H
#define PATCH_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const char *daemon_host;     // e.g. "patch.example.com"
    int daemon_port;             // 443 for wss
    bool use_tls;
    const char *session_id;
    const char *account_id;
    const char *surface_id;
    const char *device_id;       // physical voice-device id; required because
                                 // surfaceKind=="device" (wire audio.ts
                                 // validateDeviceIdCoupling rejects a device
                                 // session with no deviceId).
    const char *chat_id;
    const char *voice_token;     // daemon-minted HMAC token, pushed to the
                                 // device in the control session_start frame.
    /** Called when daemon emits `audio.tts_chunk` (start of a TTS burst). */
    void (*on_tts_started)(void *user);
    /** Called when daemon emits `audio.tts_end`. */
    void (*on_tts_ended)(void *user);
    /** Called when the WSS closes (any reason). */
    void (*on_session_closed)(void *user);
    void *user;
} patch_audio_session_cfg_t;

void patch_audio_init(void);

// Accessor for the shared I2S RX channel — used by patch_wakeword to feed
// WakeNet from the same DMA buffer the active session reads from. Returns
// NULL until patch_audio_init() has been called. The return type is opaque
// (declared as `void *`) to keep this header free of esp-idf headers, but
// callers cast to i2s_chan_handle_t.
void *patch_audio_get_rx(void);

// Start streaming the mic into a fresh audio WSS to the daemon. Caller owns
// the strings in `cfg` for the lifetime of the session.
void patch_audio_session_start(const patch_audio_session_cfg_t *cfg);

// Tear down the active audio session (if any).
void patch_audio_session_stop(const char *reason /* "vad-timeout"|"user-button"|"agent-finished" */);

bool patch_audio_session_active(void);

// Local ring tone. The "ringing" device state is otherwise LED-only (no audible
// ring), so an incoming call cannot be heard. These play / stop a clean
// two-tone chime through the speaker while a ring is pending (no audio session
// exists then, so the TX channel is free). Idempotent: start is a no-op if a
// tone is already playing or the codec is not ready; stop is a no-op if none is
// playing. The tone also doubles as a known-frequency self-test of the speaker
// path — a garbled path shows up as spectral spread/harmonics on the captured
// tone instead of clean peaks at the two chime frequencies.
void patch_audio_ringtone_start(void);
void patch_audio_ringtone_stop(void);

// LOCAL self-test: play a two-tone (fa + fb Hz, each at `amp_each` PCM16
// amplitude) directly to the speaker for `ms` milliseconds, with NO daemon /
// session / Wi-Fi. Generated on-device, widened, written straight to the TX
// channel (same path TTS uses minus the WS/stream-buffer). If fb<=0 it's a
// single tone. Blocks the caller. Lets us measure speaker IMD (clean two-tone
// vs intermod sidebands) via a host mic capture, fully offline. Requires
// patch_audio_init() first.
void patch_audio_play_test_tone(int fa, int fb, int amp_each, int ms);

// LOCAL real-speech self-test: play an embedded 48 kHz human-speech clip straight
// to the codec (no daemon/session/Wi-Fi), via the same direct path as the tone.
void patch_audio_play_embedded_speech(void);
void patch_audio_play_embedded_speech_scaled(int scale_pct);  // amplitude % (100 = native)

// Play embedded speech while capturing the device's own mic close-field; dump
// the 16 kHz capture over serial as hex (MX:... lines, MICCAP_END). Ear-free.
void patch_audio_miccap(int scale_pct);
// If set >0 before patch_audio_miccap(), it captures a two-tone instead of speech
// (for close-field IMD measurement). Reset to 0 for speech.
extern int patch_audio_miccap_tone_f1, patch_audio_miccap_tone_f2;

// Same embedded clip, but through the feeder/stream-buffer path (daemon-TTS
// path) for an A/B against the direct version above.
void patch_audio_play_embedded_speech_via_feeder(void);

#ifdef __cplusplus
}
#endif

#endif
