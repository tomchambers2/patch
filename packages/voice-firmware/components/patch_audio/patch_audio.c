// patch_audio — I2S RX/TX bring-up + per-session WSS audio client.
//
// The mic-capture path used to read I2S itself; that competed with the
// wakeword task on the same RX channel. Now patch_mic_pump owns the I2S
// reader and we subscribe as a consumer (PMPS_CONSUMER_AUDIO) to receive
// PCM16 frames via a queue.
//
// Architecture inside this file:
//   - mic_consumer_task: dequeues frames from the pump and posts them to
//     the WS sender's queue (non-blocking — drops on overflow with a
//     metric).
//   - ws_sender_task:     dequeues frames and calls
//     esp_websocket_client_send_bin. This task can block in TLS for tens
//     of ms without dropping audio because the upstream queue absorbs the
//     jitter.
//   - session_start_task: a one-shot worker that performs the WS connect
//     so the WS event-loop task isn't blocked by it.
//   - text_dispatch_task: classifier + dispatcher pulled out of the WS
//     event handler so on_ws_event returns immediately.

#include "patch_audio.h"
#include "patch_button.h"
#include "patch_mic_pump.h"
#include "patch_codec.h"
#include "patch_control_frames.h"
#include "patch_tts_render.h"

#include <inttypes.h>
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_websocket_client.h"
#include "esp_timer.h"
#include "driver/i2s_std.h"
#include "sdkconfig.h"

static const char *TAG = "patch-audio";

#define SAMPLE_RATE          16000
#define FRAME_SAMPLES        320          // 20 ms @ 16 kHz
#define FRAME_BYTES          (FRAME_SAMPLES * sizeof(int16_t))

// The HA Voice PE SPEAKER bus is clocked at 48 kHz by the XMOS (the ESP TX is a
// slave), while the protocol audio (mic up, TTS down) is 16 kHz. Feeding 16 kHz
// samples to the 48 kHz bus plays everything 3x too fast — a tone just sounds
// high-pitched, but speech becomes fast garbled gibberish (the real F1-audible
// bug, measured: a 480 Hz ring came out at 1446 Hz). So the playback path
// upsamples 16 kHz -> 48 kHz (3x) before writing to the TX channel. The mic
// (RX) bus stays 16 kHz.
#define SPK_RATE             48000
#define SPK_UP               (SPK_RATE / SAMPLE_RATE)   // 3

// DMA tuning: 4 descriptors of 320 samples = 80 ms total buffering. Matches
// our 20 ms frame cadence with one frame in flight + 3 buffered. IDF default
// is 6 × 240 which adds jitter and doesn't align with our frame size.
#define DMA_DESC_NUM         4
#define DMA_FRAME_NUM        FRAME_SAMPLES
// TX (speaker) DMA. The big jitter buffer is the PSRAM stream buffer + feeder
// task (see PLAY_BUF_BYTES); the DMA just needs to be a few frames so the feeder
// can keep it topped up. dma_frame_num must be <= 511 (IDF limit). 4 x 480 ≈
// 40 ms @ 48 kHz. Keeping this small leaves internal RAM for the wakeword's
// TFLite arena (a bigger DMA here starved it → "wake word DISABLED").
#define TX_DMA_DESC_NUM      4
#define TX_DMA_FRAME_NUM     480

#define WS_SENDER_QUEUE_LEN  4
#define TEXT_QUEUE_LEN       8
#define TEXT_FRAME_MAX       512

// Decoupled playback: incoming TTS PCM16 is pushed into this stream buffer by
// the (busy) websocket task, and a DEDICATED high-priority feeder task on the
// other core drains it to the I2S DAC at a steady cadence. This is what the
// official ESPHome i2s_audio speaker does, and it's the fix for the "windy /
// bad phone line" distortion: previously the I2S write happened inline on the
// websocket task, which is also doing mic streaming + parsing, so the speaker
// feed jittered. ~400 ms capacity absorbs network + scheduling jitter.
#define PLAY_BUF_BYTES       (48000 * sizeof(int16_t) * 3)  // ~3 s @ 48 kHz mono (PSRAM)

static i2s_chan_handle_t s_rx = NULL;
static i2s_chan_handle_t s_tx = NULL;
// Objective TX-underrun counter. The IDF fires on_send_q_ovf each time the TX
// DMA has no fresh data ready and must repeat a stale descriptor — the exact
// "stale buffer repeat" that reads as buzz on aperiodic (speech) content but is
// inaudible on a periodic tone. Lets us confirm/deny the underrun hypothesis
// with no ear in the loop.
static volatile uint32_t s_tx_underruns = 0;
static IRAM_ATTR bool tx_underrun_cb(i2s_chan_handle_t h, i2s_event_data_t *e, void *u) {
    (void)h; (void)e; (void)u;
    s_tx_underruns++;
    return false;
}
static StreamBufferHandle_t s_play_buf = NULL;   // mono PCM16 awaiting the DAC
static TaskHandle_t         s_play_task = NULL;   // feeder task
static esp_websocket_client_handle_t s_ws = NULL;
static SemaphoreHandle_t s_lock = NULL;
static TaskHandle_t s_mic_task = NULL;
static TaskHandle_t s_ws_sender_task = NULL;
static TaskHandle_t s_text_task = NULL;
static QueueHandle_t s_ws_send_q = NULL;        // patch_mic_frame_t *
static QueueHandle_t s_text_q = NULL;           // heap-alloc'd char *
static atomic_bool s_active = false;
static uint32_t s_rx_csum = 0;   // running sum of received PCM samples (corruption diag)
static uint32_t s_rx_ccnt = 0;   // running count of received PCM samples
// Timestamp (us) of the last received TTS frame. EXPERIMENT: the mic uplink
// streams concurrently with TTS playback (for barge-in) and was logging
// "ws send_bin failed" during speech; concurrent mic-RX + XMOS-AEC + WS uplink
// during speaker-TX is the leading suspect for the speech-only crackle. While
// TTS is actively arriving we PAUSE the mic uplink so the speaker path runs
// undisturbed (sacrifices barge-in during playback — fine for diag testing).
static volatile int64_t s_last_tts_us = 0;
static patch_audio_session_cfg_t s_cfg = {0};
static uint32_t s_send_drops = 0;

static void i2s_init(void) {
    // HA Voice PE: the TLV320AIC3204 codec (fronted by the XMOS DSP) is the
    // I2S clock PRIMARY; the ESP32 is the clock SECONDARY (I2S_ROLE_SLAVE).
    // The codec is configured for 32-bit I2S slots (see patch_codec.c
    // AIC3204_CODEC_IF=0x30). There are two independent buses: mic-in on
    // GPIO13/14/15 and speaker-out on GPIO8/7/10. Pins + role verified against
    // the official ESPHome config (i2s_mode: secondary).

    // Mic-in bus — codec ADC -> ESP32 RX, slave.
    i2s_chan_config_t rx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    rx_cfg.dma_desc_num = DMA_DESC_NUM;
    rx_cfg.dma_frame_num = DMA_FRAME_NUM;
    ESP_ERROR_CHECK(i2s_new_channel(&rx_cfg, NULL, &s_rx));
    // The HA Voice PE mic bus is STEREO: the XMOS DSP transmits two 32-bit
    // channels per frame (channel 0 = the primary processed mic, channel 1 = a
    // second mic / reference), matching the official ESPHome config
    // (microphone: channels stereo, 32-bit). Reading it as MONO interleaves the
    // two channels into one stream — which railed the samples and corrupted the
    // audio timeline so microWakeWord saw garbage features (peak_prob stuck at
    // 0). Read STEREO here; patch_mic_pump deinterleaves and keeps channel 0.
    i2s_std_config_t rx_std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = CONFIG_PATCH_MIC_BCLK_GPIO,
            .ws   = CONFIG_PATCH_MIC_WS_GPIO,
            .dout = I2S_GPIO_UNUSED,
            .din  = CONFIG_PATCH_MIC_DIN_GPIO,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_rx, &rx_std));

    // Speaker-out bus — ESP32 TX -> codec DAC, slave. 32-bit STEREO slots: the
    // HA Voice PE speaker bus carries two 32-bit slots per frame (same 2-slot
    // discipline as the stereo mic bus). Driving it MONO left the second slot
    // undriven and let the codec latch each sample in the wrong channel phase —
    // the DAC then reconstructed a half-rate, channel-interleaved signal that
    // sounded like harsh digital garble (F1-audible-1). We emit a full stereo
    // frame with the mono TTS sample duplicated L==R; the inbound PCM16 is
    // widened+interleaved via patch_tts_widen_pcm16_stereo before write.
    i2s_chan_config_t tx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_SLAVE);
    tx_cfg.dma_desc_num = TX_DMA_DESC_NUM;
    tx_cfg.dma_frame_num = TX_DMA_FRAME_NUM;
    // Send true silence (zeros) whenever there's no fresh data, instead of
    // repeating the last DMA buffer. Without this, when playback stops the DMA
    // loops stale audio = the "pop at the end"; it also hardens mid-stream gaps
    // (stale-repeat buzz) into clean silence.
    tx_cfg.auto_clear = true;
    ESP_ERROR_CHECK(i2s_new_channel(&tx_cfg, &s_tx, NULL));
    i2s_std_config_t tx_std = {
        // Speaker bus runs at 48 kHz. The TX channel's clk_cfg must declare the
        // TRUE bus rate (48 kHz) — even as a slave the IDF uses sample_rate to set
        // up the peripheral's internal sampling/clock-recovery; declaring 16 kHz
        // while the bus clocks at 48 kHz injects sampling noise into complex
        // content (clean on a steady tone, "noisy" on speech). Matches stock.
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SPK_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = CONFIG_PATCH_SPK_BCLK_GPIO,
            .ws   = CONFIG_PATCH_SPK_WS_GPIO,
            .dout = CONFIG_PATCH_SPK_DOUT_GPIO,
            .din  = I2S_GPIO_UNUSED,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_tx, &tx_std));
    {
        i2s_event_callbacks_t cbs = { .on_send_q_ovf = tx_underrun_cb };
        i2s_channel_register_event_callback(s_tx, &cbs, NULL);
    }
    // HA-style: preload every TX DMA descriptor with silence BEFORE enabling, so
    // the DAC starts from a FULL, clean DMA pipeline. An empty pipeline underruns
    // on the very first writes (startup grit) and is harder to keep fed.
    {
        static int32_t tx_preload[TX_DMA_FRAME_NUM * 2];
        memset(tx_preload, 0, sizeof tx_preload);
        for (int i = 0; i < TX_DMA_DESC_NUM; i++) {
            size_t loaded = 0;
            i2s_channel_preload_data(s_tx, tx_preload, sizeof tx_preload, &loaded);
        }
    }
    ESP_ERROR_CHECK(i2s_channel_enable(s_rx));
    ESP_ERROR_CHECK(i2s_channel_enable(s_tx));
    ESP_LOGI(TAG, "i2s RX @ %d Hz, TX @ %d Hz (slave; codec is clock primary)",
             SAMPLE_RATE, SPK_RATE);
}

void patch_audio_init(void) {
    if (s_lock) return;
    s_lock = xSemaphoreCreateMutex();
    // Bring up the codec FIRST: it releases the XMOS reset (which supplies the
    // I2S clocks the ESP32 slaves to) and powers the DAC. Fail loud — without
    // a configured codec the speaker is silent. No fallback.
    if (!patch_codec_init()) {
        ESP_LOGE(TAG, "codec init failed — audio output will be silent");
    }
    i2s_init();
    // Hand the RX channel to the single producer.
    patch_mic_pump_init((void *)s_rx);
    // Playback decoupling buffer (see PLAY_BUF_BYTES). Storage goes in PSRAM
    // (8 MB available) so it doesn't compete with the wakeword's TFLite arena
    // for scarce internal RAM. Trigger level = one frame so the feeder wakes on
    // whole frames rather than scraps.
    static StaticStreamBuffer_t s_play_buf_ctrl;
    uint8_t *play_storage = heap_caps_malloc(PLAY_BUF_BYTES + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (play_storage) {
        s_play_buf = xStreamBufferCreateStatic(PLAY_BUF_BYTES, FRAME_BYTES, play_storage, &s_play_buf_ctrl);
    }
    if (!s_play_buf) ESP_LOGE(TAG, "failed to create playback stream buffer (PSRAM)");
}

// LOCAL two-tone self-test (no daemon/session). See patch_audio.h.
void patch_audio_play_test_tone(int fa, int fb, int amp_each, int ms) {
    if (!s_tx || !patch_codec_ready()) {
        ESP_LOGW(TAG, "test tone: codec/TX not ready");
        return;
    }
    static int16_t mono[480];
    static int32_t s32[480 * 2];
    patch_codec_amp_enable(true);
    ESP_LOGI(TAG, "test tone: fa=%d fb=%d amp=%d for %d ms", fa, fb, amp_each, ms);
    uint32_t ph = 0;
    int blocks = (48000 * ms / 1000) / 480;
    for (int b = 0; b < blocks; b++) {
        for (int i = 0; i < 480; i++) {
            float v = sinf(2.0f * 3.14159265f * (float)fa * (float)ph / 48000.0f) * (float)amp_each;
            if (fb > 0) v += sinf(2.0f * 3.14159265f * (float)fb * (float)ph / 48000.0f) * (float)amp_each;
            ph++;
            if (v > 32767.0f) v = 32767.0f; else if (v < -32768.0f) v = -32768.0f;
            mono[i] = (int16_t)v;
        }
        if (patch_tts_widen_pcm16_stereo(mono, 480, s32, 480 * 2)) {
            size_t wrote = 0;
            i2s_channel_write(s_tx, s32, 480 * 2 * sizeof(int32_t), &wrote, pdMS_TO_TICKS(60));
        }
    }
    // Trailing silence to clock the last frame out, then amp down (clean now that
    // auto_clear stops the DMA repeating stale audio on underrun).
    memset(s32, 0, sizeof s32);
    for (int k = 0; k < 4; k++) {
        size_t wrote = 0;
        i2s_channel_write(s_tx, s32, sizeof s32, &wrote, pdMS_TO_TICKS(60));
    }
    patch_codec_amp_enable(false);
    ESP_LOGI(TAG, "test tone: done");
}

// LOCAL real-speech self-test (no daemon/session). Plays a pre-resampled 48 kHz
// human-speech clip embedded in flash, straight to the codec via the SAME direct
// path the tone test uses (widen + i2s_channel_write) — bypassing the WS /
// stream-buffer / feeder. A/B vs daemon-streamed speech: if THIS is clean but
// streamed speech crackles, the bug is in the WS/feeder path; if THIS also
// crackles, it's the codec/amp/speaker/XMOS (post-data).
extern const int16_t patch_embedded_speech[];
extern const int patch_embedded_speech_len;
void patch_audio_play_embedded_speech(void) { patch_audio_play_embedded_speech_scaled(100); }
void patch_audio_play_embedded_speech_scaled(int scale_pct) {
    if (!s_tx || !patch_codec_ready()) {
        ESP_LOGW(TAG, "embedded speech: codec/TX not ready");
        return;
    }
    static int16_t mono[480];
    static int32_t s32[480 * 2];
    patch_codec_amp_enable(true);
    uint32_t u0 = s_tx_underruns;
    ESP_LOGI(TAG, "embedded speech: %d samples (direct path, scale=%d%%)", patch_embedded_speech_len, scale_pct);
    for (int off = 0; off < patch_embedded_speech_len; off += 480) {
        int nn = (patch_embedded_speech_len - off >= 480) ? 480 : (patch_embedded_speech_len - off);
        for (int i = 0; i < 480; i++) {
            int v = (i < nn) ? ((int)patch_embedded_speech[off + i] * scale_pct / 100) : 0;
            if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
            mono[i] = (int16_t)v;
        }
        if (patch_tts_widen_pcm16_stereo(mono, 480, s32, 480 * 2)) {
            size_t wrote = 0;
            i2s_channel_write(s_tx, s32, 480 * 2 * sizeof(int32_t), &wrote, pdMS_TO_TICKS(60));
        }
    }
    // Trailing silence so the last audio frame fully clocks out, then power the
    // amp down. The old "pop at the end" was the TX DMA repeating stale audio on
    // underrun (now fixed by tx_cfg.auto_clear → emits zeros), NOT the amp; with
    // auto_clear + the DAC soft-mute in amp_enable, the amp-off is clean.
    memset(s32, 0, sizeof s32);
    for (int k = 0; k < 4; k++) {
        size_t wrote = 0;
        i2s_channel_write(s_tx, s32, sizeof s32, &wrote, pdMS_TO_TICKS(60));
    }
    patch_codec_amp_enable(false);
    ESP_LOGI(TAG, "embedded speech: done — TX underruns during clip = %u",
             (unsigned)(s_tx_underruns - u0));
}

// Close-field self-measurement: play the embedded speech while capturing the
// device's OWN mic (inches from the speaker; AEC is broken on the VPE so the mic
// hears the speaker), then dump the 16 kHz capture over serial as hex. A
// close-field capture is far above the noise floor that defeated the across-room
// Mac mic, so transcribing/analysing it is a viable EAR-FREE quality check.
int patch_audio_miccap_tone_f1 = 0, patch_audio_miccap_tone_f2 = 0;
#define s_miccap_tone_f1 patch_audio_miccap_tone_f1
#define s_miccap_tone_f2 patch_audio_miccap_tone_f2
static void miccap_play_task(void *arg) {
    if (s_miccap_tone_f1 > 0)
        patch_audio_play_test_tone(s_miccap_tone_f1, s_miccap_tone_f2, 9000, 1500);
    else
        patch_audio_play_embedded_speech_scaled((int)(intptr_t)arg);
    vTaskDelete(NULL);
}
void patch_audio_miccap(int scale_pct) {
    const int CAP = 24000;   // 1.5 s @ 16 kHz
    int16_t *buf = heap_caps_malloc(CAP * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    if (!buf) { ESP_LOGW(TAG, "miccap: no mem"); return; }
    QueueHandle_t q = (QueueHandle_t)patch_mic_pump_subscribe(PMPS_CONSUMER_AUDIO);
    if (!q) { free(buf); ESP_LOGW(TAG, "miccap: subscribe failed"); return; }
    // small delay so the speech starts ~together with capture
    xTaskCreatePinnedToCore(miccap_play_task, "spk-cap", 4096,
                            (void *)(intptr_t)scale_pct, 6, NULL, 1);
    int n = 0;
    int64_t end = esp_timer_get_time() + 1700000;
    while (n < CAP && esp_timer_get_time() < end) {
        patch_mic_frame_t *f = NULL;
        if (xQueueReceive(q, &f, pdMS_TO_TICKS(50)) == pdTRUE) {
            const int16_t *d = patch_mic_frame_data(f);
            size_t s = patch_mic_frame_samples(f);
            for (size_t i = 0; i < s && n < CAP; i++) buf[n++] = d[i];
            patch_mic_pump_release(f);
        }
    }
    patch_mic_pump_unsubscribe(PMPS_CONSUMER_AUDIO);
    ESP_LOGI(TAG, "MICCAP_START n=%d sr=16000", n);
    // Dump hex in 64-sample lines so the host can read steadily.
    for (int i = 0; i < n; i += 64) {
        char line[64 * 4 + 16];
        int o = 0;
        o += snprintf(line + o, sizeof line - o, "MX:");
        for (int j = i; j < i + 64 && j < n; j++)
            o += snprintf(line + o, sizeof line - o, "%04x", (uint16_t)buf[j]);
        printf("%s\n", line);
    }
    printf("MICCAP_END\n");
    free(buf);
}

// Play the embedded speech through the FEEDER / stream-buffer path (the exact
// path daemon TTS uses: prime → fill-then-pad → DMA), locally. A/B vs
// patch_audio_play_embedded_speech() (direct path): same data, isolates whether
// the WS/feeder pipeline is what makes streamed speech crackle.
static void play_feeder_task(void *arg);   // defined below
void patch_audio_play_embedded_speech_via_feeder(void) {
    if (!s_tx || !s_play_buf || !patch_codec_ready()) {
        ESP_LOGW(TAG, "embedded speech (feeder): not ready");
        return;
    }
    ESP_LOGI(TAG, "embedded speech (FEEDER path): %d samples", patch_embedded_speech_len);
    xStreamBufferReset(s_play_buf);
    patch_codec_amp_enable(true);
    atomic_store(&s_active, true);
    if (!s_play_task)
        xTaskCreatePinnedToCore(play_feeder_task, "patch-play", 4096, NULL, 6, &s_play_task, 1);
    const uint8_t *p = (const uint8_t *)patch_embedded_speech;
    size_t total = (size_t)patch_embedded_speech_len * sizeof(int16_t);
    size_t sent = 0;
    while (sent < total && atomic_load(&s_active)) {
        size_t chunk = total - sent;
        if (chunk > 3840) chunk = 3840;   // ~ one daemon 1920-sample frame
        size_t w = xStreamBufferSend(s_play_buf, p + sent, chunk, pdMS_TO_TICKS(200));
        sent += w;
    }
    vTaskDelay(pdMS_TO_TICKS(2600));       // let the feeder drain (clip ~1.57 s + prime)
    atomic_store(&s_active, false);        // feeder flushes silence, cuts amp, self-deletes
    vTaskDelay(pdMS_TO_TICKS(200));
    ESP_LOGI(TAG, "embedded speech (FEEDER path): done");
}

// --- decoupled playback feeder ---------------------------------------------
//
// Sole writer of the I2S TX DAC while a session is active. Drains s_play_buf in
// FRAME_SAMPLES chunks, widens mono PCM16 -> stereo int32, and writes to the
// codec. When the buffer is momentarily empty it writes a frame of SILENCE so
// the I2S never underruns (an underrun repeats stale DMA = a click/buzz). Runs
// at high priority on core 1, away from the websocket/mic work on core 0.
static void play_feeder_task(void *arg) {
    (void)arg;
    // Work in DMA-descriptor-sized blocks (one TX DMA buffer = TX_DMA_FRAME_NUM
    // samples) so every write lands exactly one descriptor — HA's always-fill model.
    static int16_t mono[TX_DMA_FRAME_NUM];
    static int32_t s32[TX_DMA_FRAME_NUM * 2];
    const size_t BLOCK_SAMPLES = TX_DMA_FRAME_NUM;
    const size_t BLOCK_BYTES   = TX_DMA_FRAME_NUM * sizeof(int16_t);
    // Jitter buffer (HA-style): build a cushion ONCE before draining, then drain
    // steadily. Two rules that kill the "windy" gaps:
    //   1) prime to ~half the buffer at the START of a burst, then stay primed —
    //      do NOT re-prime on every underrun (re-priming waits ~PREBUFFER again =
    //      a long silence gap mid-speech, which is exactly the windy artifact);
    //   2) on a momentary underrun just emit ONE short silence frame and keep
    //      going; on a partial read play exactly what's there (never pad).
    // Prime ~700 ms before draining: a fat cushion the daemon's burst fills up
    // front, so TCP/scheduling jitter in the rest of the stream can't dry the
    // feeder (the real "windy"). Fixed, not half-the-buffer, so a big buffer
    // doesn't add a multi-second startup delay.
    const size_t PREBUFFER = 48000 * sizeof(int16_t) * 7 / 10;
    bool primed = false;
    size_t wrote = 0;
    // GAP INSTRUMENTATION (the objective "windy" metric — a deaf agent's ears).
    // The feeder runs the whole session and plays silence whenever idle, so a
    // raw underrun count would be dominated by harmless leading/trailing idle.
    // The windy artifact is specifically an underrun MID-STREAM — the buffer ran
    // dry *between* real audio frames. So we count `pending` underruns since the
    // last real frame, and only when a real frame ARRIVES do we fold pending into
    // `gaps` (proving they were sandwiched by audio). Trailing idle never counts.
    // Logged as "playback gaps: underruns=G frames=R" (G==0 => no dropouts).
    uint32_t gaps = 0, real = 0, pending = 0, partials = 0;
#ifdef PATCH_FEEDER_SINE_TEST
    // DEBUG: ignore the streamed TTS and play a clean on-device 440 Hz sine
    // through the EXACT feeder→widen→DMA→codec path while a session is open
    // (mic RX running). If THIS is noisy, the fault is the feeder/codec under
    // session conditions; if clean, the fault is the streamed-data path.
    {
        static uint32_t ph = 0;
        while (atomic_load(&s_active)) {
            for (size_t i = 0; i < BLOCK_SAMPLES; i++) {
                float a = sinf(2.0f * 3.14159265f * 440.0f * (float)ph / 48000.0f);
                mono[i] = (int16_t)(a * 8000.0f);
                ph++;
            }
            if (patch_tts_widen_pcm16_stereo(mono, BLOCK_SAMPLES, s32, BLOCK_SAMPLES * 2))
                i2s_channel_write(s_tx, s32, BLOCK_SAMPLES * 2 * sizeof(int32_t), &wrote, pdMS_TO_TICKS(60));
        }
        goto feeder_done;
    }
#endif
    while (atomic_load(&s_active)) {
        if (!primed) {
            if (xStreamBufferBytesAvailable(s_play_buf) < PREBUFFER) {
                memset(mono, 0, BLOCK_BYTES);   // keep DAC fed with silence while priming
                if (patch_tts_widen_pcm16_stereo(mono, BLOCK_SAMPLES, s32, BLOCK_SAMPLES * 2))
                    i2s_channel_write(s_tx, s32, BLOCK_SAMPLES * 2 * sizeof(int32_t), &wrote, pdMS_TO_TICKS(60));
                continue;
            }
            primed = true;
        }
        // HA fill-then-pad: gather ONE full DMA block, looping reads over a small
        // budget so WS data that trickles in (the daemon's frames arrive split /
        // bursty over the busy WS task) is assembled into a WHOLE block instead of
        // padding the tail with silence on the first short read. A per-block
        // silence splice is inaudible as a "gap" (n>0, not counted) but stacks up
        // into the windy/grit texture — that is the metric-invisible noise. The
        // 10 ms gather budget is < the DMA cushion so it never starves the bus.
        size_t have = 0;
        const TickType_t budget = pdMS_TO_TICKS(10);
        TickType_t t0 = xTaskGetTickCount();
        while (have < BLOCK_BYTES) {
            TickType_t spent = xTaskGetTickCount() - t0;
            if (spent >= budget) break;
            size_t got = xStreamBufferReceive(s_play_buf, (uint8_t *)mono + have,
                                              BLOCK_BYTES - have, budget - spent);
            if (got == 0) break;
            have += got;
        }
        size_t n = have / sizeof(int16_t);
        if (n < BLOCK_SAMPLES) {
            memset((uint8_t *)mono + have, 0, BLOCK_BYTES - have);  // pad the genuine remainder
            partials++;                                            // a silence-spliced block
            if (n == 0) pending++;                                 // fully dry = mid-stream gap
        }
        if (n > 0) {
            if (pending > 0) { gaps += pending; pending = 0; }
            real++;
            if (real % 128 == 0)
                ESP_LOGI(TAG, "playback: gaps=%u partials=%u frames=%u occ=%u",
                         (unsigned)gaps, (unsigned)partials, (unsigned)real,
                         (unsigned)xStreamBufferBytesAvailable(s_play_buf));
        }
        if (!patch_tts_widen_pcm16_stereo(mono, BLOCK_SAMPLES, s32, BLOCK_SAMPLES * 2)) continue;
        i2s_channel_write(s_tx, s32, BLOCK_SAMPLES * 2 * sizeof(int32_t), &wrote, pdMS_TO_TICKS(60));
    }
    if (real > 0)
        ESP_LOGI(TAG, "playback gaps: underruns=%u frames=%u (final)", (unsigned)gaps, (unsigned)real);
#ifdef PATCH_FEEDER_SINE_TEST
feeder_done:;
#endif
    // Flush trailing silence, THEN cut the amp — so the amp always switches off
    // on silence, never mid-audio (cutting mid-audio is the "glitchy buzz" on
    // mute/session-end). The feeder is the sole owner of the session amp-off.
    memset(s32, 0, sizeof s32);
    for (int k = 0; k < 3; k++) {
        size_t wrote = 0;
        i2s_channel_write(s_tx, s32, sizeof s32, &wrote, pdMS_TO_TICKS(60));
    }
    patch_codec_amp_enable(false);
    s_play_task = NULL;
    vTaskDelete(NULL);
}

// --- mic capture consumer --------------------------------------------------
//
// Pulls frames from the pump and forwards to the WS sender's queue. If the
// sender is stalled on TLS, frames are dropped here (with a metric) — that
// keeps the producer's free list flowing so the wakeword consumer is
// unaffected.

static void mic_consumer_task(void *arg) {
    QueueHandle_t pump_q = (QueueHandle_t)arg;
    while (atomic_load(&s_active)) {
        if (patch_button_is_muted()) {
            // Drop pending frames; mute is authoritative.
            patch_mic_frame_t *f = NULL;
            while (xQueueReceive(pump_q, &f, 0) == pdTRUE) patch_mic_pump_release(f);
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        patch_mic_frame_t *f = NULL;
        if (xQueueReceive(pump_q, &f, pdMS_TO_TICKS(40)) != pdTRUE) continue;
        // Hand off to the WS sender. Non-blocking: if the queue is full,
        // the TLS write is behind — drop this frame deliberately and emit
        // a metric. NOT a fallback; this is an explicit drop with telemetry.
        if (xQueueSend(s_ws_send_q, &f, 0) != pdTRUE) {
            patch_mic_pump_release(f);
            s_send_drops++;
            if ((s_send_drops % 50) == 1) {
                ESP_LOGW(TAG, "ws send queue full; %u frames dropped", (unsigned)s_send_drops);
            }
        }
    }
    s_mic_task = NULL;
    patch_mic_pump_unsubscribe(PMPS_CONSUMER_AUDIO);
    vTaskDelete(NULL);
}

static void ws_sender_task(void *arg) {
    (void)arg;
    while (atomic_load(&s_active)) {
        patch_mic_frame_t *f = NULL;
        if (xQueueReceive(s_ws_send_q, &f, pdMS_TO_TICKS(50)) != pdTRUE) continue;
        // EXPERIMENT: skip the mic uplink while TTS is actively playing (a frame
        // arrived in the last 150 ms) so the speaker-TX path isn't contended by
        // concurrent mic-RX/uplink. Drop the frame (don't send) and continue.
        if (esp_timer_get_time() - s_last_tts_us < 150000) {
            patch_mic_pump_release(f);
            continue;
        }
        if (s_ws && esp_websocket_client_is_connected(s_ws)) {
            const int16_t *pcm = patch_mic_frame_data(f);
            size_t bytes = patch_mic_frame_samples(f) * sizeof(int16_t);
            // Allow up to 50 ms blocking here — we have a 4-deep queue
            // upstream that absorbs that jitter without dropping audio.
            int sent = esp_websocket_client_send_bin(
                s_ws, (const char *)pcm, bytes, pdMS_TO_TICKS(50));
            if (sent < 0) ESP_LOGW(TAG, "ws send_bin failed");
        }
        patch_mic_pump_release(f);
    }
    // Drain queue on exit.
    patch_mic_frame_t *f = NULL;
    while (xQueueReceive(s_ws_send_q, &f, 0) == pdTRUE) patch_mic_pump_release(f);
    s_ws_sender_task = NULL;
    vTaskDelete(NULL);
}

// --- text-frame dispatcher -------------------------------------------------
//
// The WS event task must return promptly; substring search + caller
// dispatch happens here.

static void text_dispatch_task(void *arg) {
    (void)arg;
    while (atomic_load(&s_active)) {
        char *body = NULL;
        if (xQueueReceive(s_text_q, &body, pdMS_TO_TICKS(50)) != pdTRUE) continue;
        if (strstr(body, "audio.tts_chunk")) {
            if (s_cfg.on_tts_started) s_cfg.on_tts_started(s_cfg.user);
        } else if (strstr(body, "audio.tts_end")) {
            if (s_cfg.on_tts_ended) s_cfg.on_tts_ended(s_cfg.user);
        } else if (strstr(body, "audio.error")) {
            ESP_LOGE(TAG, "audio error from daemon: %s", body);
            if (s_ws) esp_websocket_client_close(s_ws, pdMS_TO_TICKS(100));
        }
        free(body);
    }
    // Drain.
    char *body = NULL;
    while (xQueueReceive(s_text_q, &body, 0) == pdTRUE) free(body);
    s_text_task = NULL;
    vTaskDelete(NULL);
}

// --- WS event handler ------------------------------------------------------

static void on_ws_event(void *handler_args, esp_event_base_t base,
                        int32_t event_id, void *event_data) {
    (void)handler_args; (void)base;
    esp_websocket_event_data_t *d = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED: {
            ESP_LOGI(TAG, "audio ws connected");
            s_rx_csum = 0; s_rx_ccnt = 0;   // reset received-PCM checksum per session
            char buf[1536];
            // Build the audio.session_start envelope via the shared pure-C
            // encoder (patch_control_frames). surfaceKind=="device" REQUIRES a
            // deviceId (wire audio.ts validateDeviceIdCoupling) and the
            // daemon-pushed voice token must be present — the encoder fails
            // loud on either, no fallback. Using the shared encoder keeps the
            // exact wire bytes identical to what the host-test harness asserts
            // (TF1 F1-11) so there is no test/ship drift.
            size_t n = 0;
            pcf_status_t st = pcf_encode_audio_session_start(
                buf, sizeof buf, &n,
                s_cfg.session_id, s_cfg.account_id, s_cfg.surface_id,
                s_cfg.device_id, s_cfg.chat_id, s_cfg.voice_token);
            if (st != PCF_OK) {
                ESP_LOGE(TAG, "audio.session_start encode failed (%d); aborting", (int)st);
                esp_websocket_client_close(s_ws, pdMS_TO_TICKS(100));
                return;
            }
            esp_websocket_client_send_text(s_ws, buf, (int)n, pdMS_TO_TICKS(200));

            // Spawn pipeline tasks. Subscribe to the mic pump first so the
            // consumer task gets the queue handle. Both pinned to core 0
            // (Wi-Fi/LWIP core); wakeword stays on core 1.
            QueueHandle_t pump_q = (QueueHandle_t)patch_mic_pump_subscribe(PMPS_CONSUMER_AUDIO);
            if (!pump_q) {
                ESP_LOGE(TAG, "mic pump subscribe failed");
                esp_websocket_client_close(s_ws, pdMS_TO_TICKS(100));
                return;
            }
            xTaskCreatePinnedToCore(mic_consumer_task, "patch-mic", 8192, pump_q, 6, &s_mic_task, 0);
            xTaskCreatePinnedToCore(ws_sender_task, "patch-ws-tx", 8192, NULL, 6, &s_ws_sender_task, 0);
            xTaskCreatePinnedToCore(text_dispatch_task, "patch-ws-rx", 4096, NULL, 5, &s_text_task, 0);
            break;
        }
        case WEBSOCKET_EVENT_DATA: {
            // ESP-IDF delivers a WS frame larger than its RX buffer as SEVERAL
            // DATA callbacks: the first carries the real op_code, each
            // CONTINUATION carries op_code 0x0. Track the frame opcode so the
            // continuation fragments of a binary (TTS) frame are NOT dropped.
            // Dropping them spliced ~12% of samples out of every utterance —
            // exactly the "noise". (Text/control frames are small and never
            // fragment, so only binary needs this reassembly.)
            static int s_rx_frame_op = 0;
            if (d->op_code != 0) s_rx_frame_op = d->op_code;
            const int frame_op = s_rx_frame_op;
            if (frame_op == 0x2) {  // binary frame == TTS PCM16 (48 kHz from daemon)
                // The AIC3204 is configured for 32-bit I2S slots, so widen each
                // PCM16 sample to a left-justified int32 before writing. Done
                // in bounded chunks to keep stack use small on the WS task.
                if (d->data_len > 0 && s_tx && patch_codec_ready()) {
                    const int16_t *pcm = (const int16_t *)d->data_ptr;
                    size_t total = d->data_len / sizeof(int16_t);
                    // CHECKSUM DIAG: sum every received PCM sample + count, so we
                    // can compare device-RECEIVED bytes against daemon-SENT bytes
                    // (/tmp/tts48.raw) and localise where corruption enters.
                    for (size_t i = 0; i < total; i++) s_rx_csum += (uint32_t)(uint16_t)pcm[i];
                    s_rx_ccnt += total;
                    // We are about to play TTS — guarantee the speaker amp is on.
                    // Cheap GPIO set (no-op if already on); robust against any
                    // race where a ring-accept's ringtone cleanup cut the amp
                    // just as this session started.
                    patch_codec_amp_enable(true);
                    // F1-audible diag: confirm the device actually RECEIVES real
                    // (non-silent) TTS PCM. Logs the peak amplitude per ~20 frames.
                    {
                        int16_t fpk = 0;
                        for (size_t i = 0; i < total; i++) { int16_t v = pcm[i]; if (v < 0) v = (int16_t)-v; if (v > fpk) fpk = v; }
                        static uint32_t d_n = 0, d_samp = 0; static int16_t d_pk = 0;
                        d_n++; d_samp += total; if (fpk > d_pk) d_pk = fpk;
                        if (d_n % 20 == 0) {
                            ESP_LOGI(TAG, "tts rx diag: frames=%u samples=%u peak=%d/32767 rxsum=%u rxcnt=%u",
                                     (unsigned)d_n, (unsigned)d_samp, (int)d_pk,
                                     (unsigned)s_rx_csum, (unsigned)s_rx_ccnt);
                        }
                    }
                    // The daemon sends CLEAN 48 kHz PCM (resampled host-side from
                    // Kokoro's 24 kHz with a 63-tap FIR), matching the 48 kHz
                    // speaker bus. We do NOT touch the DAC here — instead push the
                    // raw mono PCM16 into the playback stream buffer and let the
                    // dedicated feeder task drain it to the codec at a steady
                    // cadence. Doing the I2S write inline on this (busy) websocket
                    // task is what caused the "windy" jitter. Block up to 80 ms if
                    // the buffer is full so we backpressure rather than drop audio.
                    if (s_play_buf) {
                        s_last_tts_us = esp_timer_get_time();   // mark active playback
                        xStreamBufferSend(s_play_buf, pcm, d->data_len, pdMS_TO_TICKS(80));
                    }
                }
            } else if (d->op_code == 0x1 && d->data_len > 0) {  // text frame (whole)
                // Hand to the dispatcher and return — we MUST NOT do work
                // on this task or other control frames stall behind us.
                size_t len = d->data_len;
                if (len >= TEXT_FRAME_MAX) len = TEXT_FRAME_MAX - 1;
                char *copy = malloc(len + 1);
                if (!copy) {
                    ESP_LOGW(TAG, "no mem for text frame copy");
                    break;
                }
                memcpy(copy, d->data_ptr, len);
                copy[len] = '\0';
                if (!s_text_q || xQueueSend(s_text_q, &copy, 0) != pdTRUE) {
                    free(copy);
                }
            }
            break;
        }
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGI(TAG, "audio ws closed (event=%d)", (int)event_id);
            ESP_LOGI(TAG, "rx checksum: sum=%u cnt=%u", (unsigned)s_rx_csum, (unsigned)s_rx_ccnt);
            atomic_store(&s_active, false);  // feeder flushes silence + cuts the amp cleanly
            if (s_cfg.on_session_closed) s_cfg.on_session_closed(s_cfg.user);
            break;
        default: break;
    }
}

// --- local ring tone --------------------------------------------------------
//
// The "ringing" state is otherwise LED-only. This plays a pleasant repeating
// chime through the speaker so a call is audible. There is no audio session
// while a ring is pending, so s_tx is free; we reuse the same PCM16 ->
// stereo-int32 widening the session play path uses (the framing fix that cured
// the earlier garble).
//
// CRITICAL: the whole loop is PRECOMPUTED once into a RAM buffer, then merely
// copied out frame-by-frame. An earlier version synthesised every sample live
// (multiple sinf/expf per sample at 16 kHz); the synth task couldn't keep the
// I2S DMA fed, the TX buffer starved, and a starved I2S bus repeats stale
// samples -> an audible BUZZ. Precomputing makes the streaming path a cheap
// memcpy, so the DMA never starves. The buffer is normalised so summed/
// overlapping notes can never clip (clipping is its own harsh buzz). Pure
// sines only — added overtones sound harsh on this small speaker.
// A gentle, NON-MELODIC ring: two soft pulses at the SAME warm pitch that
// SWELL in and fade out (raised-cosine envelope, no percussive pluck), then a
// rest, looped. Single pitch => not a tune; the slow swell + a little harmonic
// warmth make it feel soft/organic rather than sterile-electronic (pure plucky
// sines sounded "electronic"). Pulses do not overlap (a small speaker distorts
// on summed peaks). RT_PEAK stays low so the amp/speaker is never overdriven.
#define RT_PERIOD_MS   1600     // two gentle swells then a rest, looped
#define RT_ATK_MS      110      // slow swell-IN (gentle, not a click/pluck)
#define RT_REL_MS      230      // slow fade-OUT
#define RT_PEAK        0.18f    // normalised peak (of full scale) — quiet, undistorted
#define RT_NOTES       2
static const float RT_FREQ[RT_NOTES] = { 480.00f, 480.00f }; // same warm pitch (non-melodic)
static const float RT_ON[RT_NOTES]   = { 0.00f, 0.58f };     // onsets (s) — non-overlapping
static const float RT_DUR[RT_NOTES]  = { 0.46f, 0.46f };     // each pulse's window (s)

static TaskHandle_t s_ringtone_task = NULL;
static atomic_bool  s_ringtone_run  = ATOMIC_VAR_INIT(false);
static int16_t     *s_rt_buf        = NULL;   // precomputed one-period waveform
static int          s_rt_len        = 0;      // samples in s_rt_buf

// One mono float sample at absolute sample index n within the period. Exactly
// one pulse sounds at a time (the segments don't overlap). Each pulse is a warm
// tone (fundamental + gentle harmonics) under a raised-cosine SWELL envelope:
// slow fade in, soft sustain, slow fade out — no percussive onset.
static float rt_sample(long n) {
    float tl  = (float)n / (float)SPK_RATE;   // ring is generated at the 48 kHz speaker rate
    float atk = RT_ATK_MS / 1000.0f;
    float rel = RT_REL_MS / 1000.0f;
    for (int k = 0; k < RT_NOTES; k++) {
        float lt = tl - RT_ON[k];
        if (lt < 0.0f || lt >= RT_DUR[k]) continue;    // not in this pulse's window
        float env;
        float left = RT_DUR[k] - lt;
        if (lt < atk)        env = 0.5f * (1.0f - cosf((float)M_PI * lt / atk));    // swell in
        else if (left < rel) env = 0.5f * (1.0f - cosf((float)M_PI * left / rel));  // fade out
        else                 env = 1.0f;                                            // soft sustain
        float w = (float)(2.0 * M_PI) * RT_FREQ[k] * lt;
        // fundamental + gentle warmth (small even/odd overtones); summed peak is
        // normalised away later so this never clips.
        float s = sinf(w) + 0.22f * sinf(2.0f * w) + 0.08f * sinf(3.0f * w);
        return env * s;
    }
    return 0.0f;
}

static void ringtone_task(void *arg) {
    (void)arg;
    const int N = RT_PERIOD_MS * SPK_RATE / 1000;   // 48 kHz speaker rate
    s_rt_buf = heap_caps_malloc((size_t)N * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_rt_buf) s_rt_buf = malloc((size_t)N * sizeof(int16_t));   // fall back to internal RAM
    if (!s_rt_buf) {
        ESP_LOGW(TAG, "ringtone: no mem for %d-sample buffer", N);
        atomic_store(&s_ringtone_run, false);
        patch_codec_amp_enable(false);
        s_ringtone_task = NULL;
        vTaskDelete(NULL);
        return;
    }
    // Pass 1: find the peak so we can normalise (overlapping decays can sum > 1).
    float maxa = 1e-6f;
    for (int n = 0; n < N; n++) { float a = fabsf(rt_sample(n)); if (a > maxa) maxa = a; }
    const float scale = (RT_PEAK * 32767.0f) / maxa;
    // Pass 2: write the normalised int16 waveform.
    for (int n = 0; n < N; n++) {
        float v = rt_sample(n) * scale;
        if (v > 32767.0f) v = 32767.0f; else if (v < -32768.0f) v = -32768.0f;
        s_rt_buf[n] = (int16_t)v;
    }
    s_rt_len = N;

    patch_codec_amp_enable(true);
    ESP_LOGI(TAG, "ringtone started (%d-sample loop)", N);

    int16_t mono[FRAME_SAMPLES];
    static int32_t s32[FRAME_SAMPLES * 2];
    int pos = 0;
    while (atomic_load(&s_ringtone_run)) {
        for (int i = 0; i < FRAME_SAMPLES; i++) {
            mono[i] = s_rt_buf[pos];
            if (++pos >= s_rt_len) pos = 0;
        }
        if (!patch_tts_widen_pcm16_stereo(mono, FRAME_SAMPLES, s32, FRAME_SAMPLES * 2)) break;
        size_t wrote = 0;
        i2s_channel_write(s_tx, s32, FRAME_SAMPLES * 2 * sizeof(int32_t), &wrote, pdMS_TO_TICKS(50));
    }
    // Flush a few frames of silence so the amp doesn't latch on a non-zero
    // sample (an audible click), then cut the amp.
    memset(s32, 0, sizeof s32);
    for (int k = 0; k < 4; k++) {
        size_t wrote = 0;
        i2s_channel_write(s_tx, s32, sizeof s32, &wrote, pdMS_TO_TICKS(50));
    }
    // CRITICAL: only cut the amp if no audio session is using it. On ring-accept
    // the session opens (and enables the amp for TTS) BEFORE this cleanup runs;
    // if we unconditionally disabled the amp here we'd silence the session's TTS
    // ~1 s in (the F1-audible "speech is just not there" bug). The session owns
    // the amp once active and disables it itself in patch_audio_session_stop.
    if (!atomic_load(&s_active)) patch_codec_amp_enable(false);
    free(s_rt_buf); s_rt_buf = NULL; s_rt_len = 0;
    s_ringtone_task = NULL;
    vTaskDelete(NULL);
}

void patch_audio_ringtone_start(void) {
    if (atomic_load(&s_ringtone_run) || s_ringtone_task) return;  // already ringing
    if (!s_tx || !patch_codec_ready()) return;
    atomic_store(&s_ringtone_run, true);
    // The task precomputes the waveform (brief), enables the amp, then streams —
    // keeping the heavy synth off the caller (the control-frame task).
    if (xTaskCreatePinnedToCore(ringtone_task, "patch-ring", 4096, NULL, 5,
                                &s_ringtone_task, 0) != pdPASS) {
        atomic_store(&s_ringtone_run, false);
        ESP_LOGW(TAG, "ringtone task spawn failed");
    }
}

void patch_audio_ringtone_stop(void) {
    if (!atomic_load(&s_ringtone_run)) return;
    atomic_store(&s_ringtone_run, false);  // task flushes silence, cuts amp, self-deletes
    ESP_LOGI(TAG, "ringtone stop requested");
}

// --- session lifecycle -----------------------------------------------------
//
// session_start_task does the WS connect off the inbound control-frame
// task, then dies. Errors atomically flip s_active back to false so the
// next session_start can proceed.

static void session_start_task(void *arg) {
    (void)arg;
    char uri[256];
    snprintf(uri, sizeof uri, "%s://%s:%d/audio/%s",
             s_cfg.use_tls ? "wss" : "ws",
             s_cfg.daemon_host, s_cfg.daemon_port, s_cfg.session_id);
    esp_websocket_client_config_t wsc = {
        .uri = uri,
        .reconnect_timeout_ms = 0,
        .network_timeout_ms = 5000,
        .buffer_size = 4096,
        // The default websocket_task stack (4 KB) overflows on the audio WSS:
        // on_ws_event runs TLS record handling + JSON parsing + PCM frame
        // dispatch on this task, and the device reset with "stack overflow in
        // task websocket_task" the moment a wake-word audio session opened.
        // 8 KB clears it with margin.
        .task_stack = 8192,
    };
    esp_websocket_client_handle_t ws = esp_websocket_client_init(&wsc);
    if (!ws) {
        ESP_LOGE(TAG, "ws client init failed");
        atomic_store(&s_active, false);
        if (s_cfg.on_session_closed) s_cfg.on_session_closed(s_cfg.user);
        vTaskDelete(NULL);
        return;
    }
    // Allocate the per-session queues now so the on_ws_event handler finds
    // them ready when CONNECTED fires.
    s_ws_send_q = xQueueCreate(WS_SENDER_QUEUE_LEN, sizeof(patch_mic_frame_t *));
    s_text_q   = xQueueCreate(TEXT_QUEUE_LEN, sizeof(char *));
    s_send_drops = 0;
    s_ws = ws;
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, on_ws_event, NULL);
    esp_err_t err = esp_websocket_client_start(s_ws);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ws start err=%d", err);
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
        if (s_ws_send_q) { vQueueDelete(s_ws_send_q); s_ws_send_q = NULL; }
        if (s_text_q)   { vQueueDelete(s_text_q);    s_text_q = NULL; }
        atomic_store(&s_active, false);
        if (s_cfg.on_session_closed) s_cfg.on_session_closed(s_cfg.user);
    }
    vTaskDelete(NULL);
}

void patch_audio_session_start(const patch_audio_session_cfg_t *cfg) {
    // CAS guard: ensures only one in-flight session start; the previous
    // implementation could leak s_ws on early-return failure paths.
    bool expected = false;
    if (!atomic_compare_exchange_strong(&s_active, &expected, true)) {
        ESP_LOGW(TAG, "audio session already active; ignoring");
        return;
    }
    s_cfg = *cfg;
    // Power the speaker amplifier for the duration of the session so queued
    // TTS is audible. Disabled again in patch_audio_session_stop / on close.
    patch_codec_amp_enable(true);
    // Start the dedicated playback feeder (sole TX writer during the session).
    // Reset the buffer so no stale audio from a previous session leaks in.
    if (s_play_buf) xStreamBufferReset(s_play_buf);
    if (!s_play_task) {
        xTaskCreatePinnedToCore(play_feeder_task, "patch-play", 4096, NULL, 6, &s_play_task, 1);
    }
    // Spawn the connect worker so we return immediately to the caller (the
    // control-WSS event task). 4 KB stack is enough for the
    // websocket_client_init/start path; the persistent task running TLS is
    // ws_sender_task with 8 KB.
    if (xTaskCreatePinnedToCore(session_start_task, "patch-au-st", 4096, NULL, 5, NULL, 0) != pdPASS) {
        ESP_LOGE(TAG, "failed to spawn session_start_task");
        atomic_store(&s_active, false);
    }
}

void patch_audio_session_stop(const char *reason) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (atomic_load(&s_active) && s_ws && esp_websocket_client_is_connected(s_ws)) {
        char buf[128];
        int n = snprintf(buf, sizeof buf,
            "{\"type\":\"audio.session_end\",\"sessionId\":\"%s\",\"reason\":\"%s\"}",
            s_cfg.session_id, reason ? reason : "user-button");
        if (n > 0 && n < (int)sizeof buf) {
            esp_websocket_client_send_text(s_ws, buf, n, pdMS_TO_TICKS(200));
        }
    }
    atomic_store(&s_active, false);
    // The playback feeder observes s_active=false, flushes silence, and powers
    // the amp down on a silent frame (clean — no mid-audio glitch on mute/end).
    if (s_ws) {
        esp_websocket_client_close(s_ws, pdMS_TO_TICKS(500));
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
    }
    // Tasks observe s_active=false and self-delete; the queues will be
    // emptied by their drain loops. Delete queues after a short grace.
    vTaskDelay(pdMS_TO_TICKS(100));
    if (s_ws_send_q) { vQueueDelete(s_ws_send_q); s_ws_send_q = NULL; }
    if (s_text_q)   { vQueueDelete(s_text_q);    s_text_q = NULL; }
    xSemaphoreGive(s_lock);
}

bool patch_audio_session_active(void) {
    return atomic_load(&s_active);
}

void *patch_audio_get_rx(void) {
    return (void *)s_rx;
}
