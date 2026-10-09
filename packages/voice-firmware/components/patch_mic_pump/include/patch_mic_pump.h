// Single-producer mic pump.
//
// Owns the I2S RX channel handle (set externally via patch_mic_pump_attach).
// Spawns ONE task pinned to core 0 that reads 20 ms PCM frames from the
// channel and fans out to subscribed consumers via per-consumer queues.
//
// Consumers (wakeword, audio) MUST NOT call i2s_channel_read themselves.
// They subscribe and dequeue frames from their own queue. The producer
// never blocks on a full consumer queue — it drops the frame and rate-
// limits a warning log.
//
// Frame format: int16 PCM, mono, 16 kHz, 320 samples per frame (20 ms).
// Buffers are owned by a small free-list inside the producer; consumers get
// const pointers and call patch_mic_pump_release(buf) when done. This keeps
// the queue O(1) without a per-frame malloc.

#ifndef PATCH_MIC_PUMP_H
#define PATCH_MIC_PUMP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "patch_mic_pump_state.h"

#ifdef __cplusplus
extern "C" {
#endif

#define PATCH_MIC_PUMP_FRAME_SAMPLES   320       // 20 ms @ 16 kHz mono
#define PATCH_MIC_PUMP_FRAME_BYTES     (PATCH_MIC_PUMP_FRAME_SAMPLES * sizeof(int16_t))

// Opaque borrowed frame. Consumer holds it for the duration of its work,
// then must call patch_mic_pump_release.
typedef struct patch_mic_frame_s patch_mic_frame_t;

// Returns the int16 PCM pointer + sample count for a borrowed frame.
const int16_t *patch_mic_frame_data(const patch_mic_frame_t *f);
size_t patch_mic_frame_samples(const patch_mic_frame_t *f);

// Initialise the pump. Pass the I2S RX channel handle (cast from
// i2s_chan_handle_t). Must be called once after patch_audio_init.
void patch_mic_pump_init(void *rx_chan);

// Subscribe / unsubscribe a consumer. Returns the consumer's queue handle
// (cast from QueueHandle_t). Items posted are `patch_mic_frame_t *`.
void *patch_mic_pump_subscribe(pmps_consumer_t c);
void  patch_mic_pump_unsubscribe(pmps_consumer_t c);

// Hardware-mute hint — while muted, the producer drains I2S but doesn't
// publish to any consumer.
void patch_mic_pump_set_muted(bool muted);

// Release a borrowed frame back to the free list.
void patch_mic_pump_release(const patch_mic_frame_t *f);

// Diagnostic counters (snapshot).
void patch_mic_pump_get_stats(pmps_t *out);

#ifdef __cplusplus
}
#endif

#endif
