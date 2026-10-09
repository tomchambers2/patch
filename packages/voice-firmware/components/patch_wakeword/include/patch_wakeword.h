// On-device wake-word using esp-sr's WakeNet (the same model HA Assist uses
// when `use_wake_word: true` is set on the HA Voice PE; "Hey Jarvis" / "Hi
// ESP" / "Alexa" depending on the model selected via menuconfig).
//
// Runs continuously on a dedicated task. When a wake fires, the registered
// callback runs in that task context. Caller must keep the callback short
// (e.g. just dispatch onto a queue or call patch_control_send_wake_detected
// + open the audio session).
//
// While the device is muted, this task is paused — no compute, no detection.

#ifndef PATCH_WAKEWORD_H
#define PATCH_WAKEWORD_H

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*patch_wakeword_handler_t)(void *user);

void patch_wakeword_init(patch_wakeword_handler_t handler, void *user);
void patch_wakeword_pause(void);    // call on mute / session-active
void patch_wakeword_resume(void);

#ifdef __cplusplus
}
#endif

#endif
