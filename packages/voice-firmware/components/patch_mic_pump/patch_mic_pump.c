// Single-producer / two-consumer I2S RX pump.
//
// Why this exists: previously both patch_audio:mic_task and
// patch_wakeword:task called i2s_channel_read on the same RX channel,
// guarded only by a `s_paused` flag flipped by the session-control layer.
// That left a race window between session_start and mic_task spinup where
// both tasks could compete for DMA frames; it also meant every consumer
// re-implemented the int32->int16 packing.
//
// Now exactly one task reads the I2S DMA stream, packs 24-bit-in-32-bit
// frames to int16, and fans them out via per-consumer FreeRTOS queues.

#include "patch_mic_pump.h"
#include "patch_button.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "driver/i2s_std.h"

static const char *TAG = "patch-mic-pump";

#define FREELIST_SIZE       8       // total in-flight frames across all consumers
#define CONSUMER_QUEUE_DEPTH 4      // bounded; full queue => producer drops

struct patch_mic_frame_s {
    int16_t pcm[PATCH_MIC_PUMP_FRAME_SAMPLES];
    size_t  samples;
    int     refcount;       // # consumers currently holding this frame
};

static i2s_chan_handle_t s_rx = NULL;
static patch_mic_frame_t *s_pool = NULL;        // FREELIST_SIZE entries (PSRAM)
static QueueHandle_t s_freelist = NULL;
static QueueHandle_t s_consumer_q[PMPS_CONSUMER_COUNT] = {0};
static SemaphoreHandle_t s_state_lock = NULL;
static pmps_t s_state;
static TaskHandle_t s_task = NULL;

const int16_t *patch_mic_frame_data(const patch_mic_frame_t *f) { return f ? f->pcm : NULL; }
size_t         patch_mic_frame_samples(const patch_mic_frame_t *f) { return f ? f->samples : 0; }

void patch_mic_pump_release(const patch_mic_frame_t *cf) {
    if (!cf) return;
    patch_mic_frame_t *f = (patch_mic_frame_t *)cf;
    // Decrement refcount under the state lock; when it hits zero return to
    // the free list. portMUX would be lighter but we already need the lock
    // around state counters so reuse it.
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    f->refcount--;
    bool free_now = (f->refcount <= 0);
    xSemaphoreGive(s_state_lock);
    if (free_now) {
        // Send back to the free list. The free list is sized for the worst
        // case (every slot in flight), so this xQueueSend cannot fail in a
        // correctly-shaped system; if it does we leak a slot rather than
        // hide the symptom.
        if (xQueueSend(s_freelist, &f, 0) != pdTRUE) {
            ESP_LOGE(TAG, "freelist enqueue failed; slot leaked");
        }
    }
}

void *patch_mic_pump_subscribe(pmps_consumer_t c) {
    if ((int)c < 0 || c >= PMPS_CONSUMER_COUNT) return NULL;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    if (!s_consumer_q[c]) {
        s_consumer_q[c] = xQueueCreate(CONSUMER_QUEUE_DEPTH, sizeof(patch_mic_frame_t *));
    }
    pmps_subscribe(&s_state, c);
    QueueHandle_t q = s_consumer_q[c];
    xSemaphoreGive(s_state_lock);
    return (void *)q;
}

void patch_mic_pump_unsubscribe(pmps_consumer_t c) {
    if ((int)c < 0 || c >= PMPS_CONSUMER_COUNT) return;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    pmps_unsubscribe(&s_state, c);
    // Drain any frames still queued for this consumer so refcounts go back
    // to zero and the free list refills.
    QueueHandle_t q = s_consumer_q[c];
    xSemaphoreGive(s_state_lock);
    if (q) {
        patch_mic_frame_t *f = NULL;
        while (xQueueReceive(q, &f, 0) == pdTRUE) {
            patch_mic_pump_release(f);
        }
    }
}

void patch_mic_pump_set_muted(bool muted) {
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    pmps_set_muted(&s_state, muted);
    xSemaphoreGive(s_state_lock);
}

void patch_mic_pump_get_stats(pmps_t *out) {
    if (!out) return;
    xSemaphoreTake(s_state_lock, portMAX_DELAY);
    *out = s_state;
    xSemaphoreGive(s_state_lock);
}

static patch_mic_frame_t *acquire_slot(void) {
    patch_mic_frame_t *f = NULL;
    if (xQueueReceive(s_freelist, &f, 0) != pdTRUE) return NULL;
    f->refcount = 0;
    f->samples = 0;
    return f;
}

static void pump_task(void *arg) {
    (void)arg;
    // Internal-RAM scratch buffer for the int32 read — small (1.28 KB) and
    // hot, internal RAM is the right home. NOT on the stack: the stack also
    // has to host esp_websocket TLS-write paths through other tasks via
    // the queue, but here we just want predictable cache behaviour.
    // The HA Voice PE mic I2S bus is STEREO (2 × 32-bit channels per frame —
    // see patch_audio.c rx_std). We read both channels and keep channel 0 (the
    // primary processed mic), so the scratch buffer holds 2× int32 per mono
    // output sample.
    static const size_t I2S_CH = 2;
    int32_t *i32buf = heap_caps_malloc(PATCH_MIC_PUMP_FRAME_SAMPLES * I2S_CH * sizeof(int32_t),
                                       MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!i32buf) {
        ESP_LOGE(TAG, "no mem for i2s scratch buffer");
        vTaskDelete(NULL);
        return;
    }

    for (;;) {
        // Reflect hardware mute into the state machine each tick.
        patch_mic_pump_set_muted(patch_button_is_muted());

        size_t got = 0;
        esp_err_t err = i2s_channel_read(
            s_rx, i32buf, PATCH_MIC_PUMP_FRAME_SAMPLES * I2S_CH * sizeof(int32_t),
            &got, pdMS_TO_TICKS(40));

        bool ok = (err == ESP_OK) && (got > 0);
        bool log_failure;
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        log_failure = pmps_record_i2s_read(&s_state, ok);
        xSemaphoreGive(s_state_lock);
        if (!ok) {
            if (log_failure) {
                ESP_LOGW(TAG, "i2s_channel_read failed: err=%d (consecutive=%u)",
                         err, (unsigned)s_state.i2s_read_failures);
            }
            continue;
        }

        // Two interleaved int32 channels per mono output sample.
        size_t samples = (got / sizeof(int32_t)) / I2S_CH;
        if (samples > PATCH_MIC_PUMP_FRAME_SAMPLES) samples = PATCH_MIC_PUMP_FRAME_SAMPLES;

        // Decide which consumers want this frame.
        bool want[PMPS_CONSUMER_COUNT];
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        for (int c = 0; c < PMPS_CONSUMER_COUNT; c++) {
            want[c] = pmps_should_publish(&s_state, (pmps_consumer_t)c);
        }
        xSemaphoreGive(s_state_lock);
        bool any = false;
        for (int c = 0; c < PMPS_CONSUMER_COUNT; c++) if (want[c]) { any = true; break; }
        if (!any) continue;     // drain DMA, drop frame; cheap

        patch_mic_frame_t *f = acquire_slot();
        if (!f) {
            // Pool exhausted — both consumers are stalled. Treat as a drop
            // for whichever consumers wanted this frame.
            xSemaphoreTake(s_state_lock, portMAX_DELAY);
            for (int c = 0; c < PMPS_CONSUMER_COUNT; c++) {
                if (want[c]) pmps_record_publish(&s_state, (pmps_consumer_t)c, false);
            }
            xSemaphoreGive(s_state_lock);
            continue;
        }
        // Deinterleave: keep channel 0 (the XMOS primary processed mic) from
        // each stereo pair. The mic data is 24-bit left-justified in the 32-bit
        // slot, so >>16 brings it into the int16 range without clipping (>>14
        // left ~18 bits and railed loud speech at INT16_MAX, which clipped the
        // signal and gave microWakeWord garbage spectrograms -> probability 0).
        for (size_t i = 0; i < samples; i++) {
            f->pcm[i] = (int16_t)(i32buf[i * I2S_CH] >> 16);
        }
        f->samples = samples;

        // Set refcount to the number of consumers we'll hand this to BEFORE
        // posting, so the first consumer can't free it while the second is
        // mid-post.
        int n_targets = 0;
        for (int c = 0; c < PMPS_CONSUMER_COUNT; c++) if (want[c]) n_targets++;
        f->refcount = n_targets;

        for (int c = 0; c < PMPS_CONSUMER_COUNT; c++) {
            if (!want[c]) continue;
            QueueHandle_t q = s_consumer_q[c];
            bool sent = false;
            if (q) sent = (xQueueSend(q, &f, 0) == pdTRUE);
            xSemaphoreTake(s_state_lock, portMAX_DELAY);
            pmps_record_publish(&s_state, (pmps_consumer_t)c, sent);
            xSemaphoreGive(s_state_lock);
            if (!sent) {
                // Consumer queue full — undo this consumer's hold on the slot.
                xSemaphoreTake(s_state_lock, portMAX_DELAY);
                f->refcount--;
                xSemaphoreGive(s_state_lock);
                ESP_LOGW(TAG, "consumer %d queue full; dropping frame", c);
            }
        }
        // If every send failed, refcount is now zero — return slot.
        xSemaphoreTake(s_state_lock, portMAX_DELAY);
        bool free_now = (f->refcount <= 0);
        xSemaphoreGive(s_state_lock);
        if (free_now) {
            if (xQueueSend(s_freelist, &f, 0) != pdTRUE) {
                ESP_LOGE(TAG, "freelist enqueue failed (post-fanout)");
            }
        }
    }
}

void patch_mic_pump_init(void *rx_chan) {
    if (s_task) return;     // already initialised
    s_rx = (i2s_chan_handle_t)rx_chan;
    if (!s_rx) {
        ESP_LOGE(TAG, "patch_mic_pump_init called with NULL rx_chan");
        return;
    }
    s_state_lock = xSemaphoreCreateMutex();
    pmps_init(&s_state);

    // Frame slots in PSRAM — the int16 buffers add up (8 * 640 B = 5 KB);
    // keep internal RAM free for stacks and DMA descriptors.
    s_pool = heap_caps_malloc(FREELIST_SIZE * sizeof(patch_mic_frame_t),
                              MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_pool) {
        ESP_LOGE(TAG, "no PSRAM for mic frame pool");
        return;
    }
    memset(s_pool, 0, FREELIST_SIZE * sizeof(patch_mic_frame_t));
    s_freelist = xQueueCreate(FREELIST_SIZE, sizeof(patch_mic_frame_t *));
    for (int i = 0; i < FREELIST_SIZE; i++) {
        patch_mic_frame_t *p = &s_pool[i];
        xQueueSend(s_freelist, &p, 0);
    }

    // Producer pinned to core 0 (Wi-Fi/LWIP core); wakeword consumer stays
    // on core 1 so inference doesn't fight for the same scheduler slot.
    xTaskCreatePinnedToCore(pump_task, "patch-mic-pump", 4096, NULL, 7, &s_task, 0);
}
