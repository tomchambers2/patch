// Pure-C contract for the single-producer I2S mic pump.
//
// The firmware has exactly ONE task that reads from the I2S RX channel: the
// mic-pump producer. Multiple consumers (wakeword inference, audio-session
// WS-sender) subscribe to receive 20 ms PCM frames via their own bounded
// queues. This file is the host-testable state model:
//
//   - `pmps_t` tracks subscription state and drop counters per consumer.
//   - `pmps_publish` decides, for each consumer, whether the producer should
//     attempt to enqueue this frame (consumer is subscribed AND not muted).
//   - `pmps_record_drop` is called when a consumer's queue was full when
//     the producer tried to enqueue.
//
// We never block the producer on a full consumer queue. A blocked consumer
// MUST NOT stall the I2S DMA — that's how we get audio gaps. Instead the
// producer drops the frame and increments the drop counter; the firmware
// surfaces the counter via a rate-limited log on the producer side.
//
// The two consumers are explicit (not generic indices) because there will
// only ever be these two on this device. Adding a third would mean adding
// a third enum value.

#ifndef PATCH_MIC_PUMP_STATE_H
#define PATCH_MIC_PUMP_STATE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PMPS_CONSUMER_WAKEWORD = 0,
    PMPS_CONSUMER_AUDIO = 1,
    PMPS_CONSUMER_COUNT = 2,
} pmps_consumer_t;

typedef struct {
    bool subscribed;
    uint32_t dropped;       // frames the producer could not enqueue (queue full)
    uint32_t delivered;     // frames the producer successfully enqueued
} pmps_consumer_state_t;

typedef struct {
    pmps_consumer_state_t consumer[PMPS_CONSUMER_COUNT];
    bool muted;             // hardware mute — producer still reads but no consumer receives
    uint32_t i2s_read_failures;     // consecutive I2S read failures
    uint32_t i2s_read_failures_total;
} pmps_t;

void pmps_init(pmps_t *s);

// Subscribe / unsubscribe a consumer. Idempotent.
void pmps_subscribe(pmps_t *s, pmps_consumer_t c);
void pmps_unsubscribe(pmps_t *s, pmps_consumer_t c);

// Set mute state. While muted, `pmps_should_publish` returns false for all
// consumers (we still drain I2S to avoid DMA backpressure, but nothing is
// enqueued on consumer queues).
void pmps_set_muted(pmps_t *s, bool muted);

// Returns true if the producer should attempt to enqueue this frame for
// consumer `c`.
bool pmps_should_publish(const pmps_t *s, pmps_consumer_t c);

// Called by the producer after attempting an enqueue. `ok=true` on success,
// `ok=false` when the consumer queue was full (drop).
void pmps_record_publish(pmps_t *s, pmps_consumer_t c, bool ok);

// Called by the producer for the I2S read result. Returns true if the
// failure should be logged (rate limited: every 100 consecutive failures
// AND the very first failure in a new run of failures).
bool pmps_record_i2s_read(pmps_t *s, bool ok);

#ifdef __cplusplus
}
#endif

#endif
