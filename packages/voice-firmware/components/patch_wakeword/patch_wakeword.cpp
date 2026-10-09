// patch_wakeword — microWakeWord (TFLite-Micro) on-device wake-word engine.
//
// Spec: spec/16-voice-device.md §"Run microWakeWord on-device" and
// spec/18-tech-stack.md §"Voice device firmware" REQUIRE microWakeWord — the
// same TFLite-Micro wake engine Home Assistant Assist uses — NOT esp-sr
// WakeNet. WakeNet's stock models are Mandarin ("Hi Lexin") and its English
// catalogue is a fixed set; microWakeWord is the HA-native path and lets us
// ship the pretrained 'hey_jarvis' model as the interim wake word (a custom
// 'Hey Patch' model is a documented follow-up; not trained here).
//
// Pipeline (matches the ESPHome micro_wake_word component, which is the
// reference implementation of this engine):
//   16 kHz mono PCM16 mic frames (from patch_mic_pump)
//     -> TFLite-Micro audio "micro frontend" -> 40 int8 spectrogram features
//        per 10 ms step (FEATURE_DURATION_MS window, FEATURE_STEP_SIZE_MS step)
//     -> streaming TFLite-Micro model (one feature slice per inference; the
//        model's first conv stride is read from the input tensor's dim[1])
//     -> uint8 probability per inference
//     -> sliding window of the last N probabilities; detection when their sum
//        exceeds probability_cutoff * N (after a warm-up of MIN_SLICES windows).
//
// The hey_jarvis.tflite FlatBuffer + its manifest params are bundled into the
// app image via EMBED_FILES (see CMakeLists.txt) — no separate flash partition,
// no esp-sr srmodels.bin.
//
// This task is a CONSUMER of the patch_mic_pump producer. It does NOT call
// i2s_channel_read directly — it pulls 20 ms PCM16 frames from the per-consumer
// queue exposed by patch_mic_pump_subscribe(PMPS_CONSUMER_WAKEWORD).
//
// The public C contract (patch_wakeword_init / _pause / _resume) is unchanged
// so main.c needs no edits.

#include "patch_wakeword.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdint>
#include <vector>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_heap_caps.h"

#include "tensorflow/lite/core/c/common.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"

extern "C" {
#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
}

#include "patch_mic_pump.h"

static const char *TAG = "patch-wakeword";

// ---------------------------------------------------------------------------
// microWakeWord preprocessor settings.
//
// These MUST match the values microWakeWord models were trained with — they
// are identical to ESPHome's preprocessor_settings.h. Changing any of them
// silently breaks detection (the features stop matching what the model saw in
// training), so they are pinned constants, not Kconfig.
// ---------------------------------------------------------------------------
static const uint8_t PREPROCESSOR_FEATURE_SIZE = 40;  // mel features per slice
static const uint8_t FEATURE_DURATION_MS = 30;        // analysis window
static const uint8_t FEATURE_STEP_SIZE_MS = 10;       // hop (== manifest feature_step_size)

static const float FILTERBANK_LOWER_BAND_LIMIT = 125.0f;
static const float FILTERBANK_UPPER_BAND_LIMIT = 7500.0f;

static const int NOISE_REDUCTION_SMOOTHING_BITS = 10;
static const float NOISE_REDUCTION_EVEN_SMOOTHING = 0.025f;
static const float NOISE_REDUCTION_ODD_SMOOTHING = 0.06f;
static const float NOISE_REDUCTION_MIN_SIGNAL_REMAINING = 0.05f;

static const int PCAN_GAIN_CONTROL_ENABLE_PCAN = 1;
static const float PCAN_GAIN_CONTROL_STRENGTH = 0.95f;
static const float PCAN_GAIN_CONTROL_OFFSET = 80.0f;
static const int PCAN_GAIN_CONTROL_GAIN_BITS = 21;

static const int LOG_SCALE_ENABLE_LOG = 1;
static const int LOG_SCALE_SCALE_SHIFT = 6;

// hey_jarvis.json manifest params (models/v2/hey_jarvis.json):
//   probability_cutoff: 0.97, sliding_window_size: 5, tensor_arena_size: 22860.
// probability_cutoff is quantised 0.0-1.0 -> 0-255 (the streaming model emits a
// uint8 probability), matching ESPHome's WakeWordModel.
static const uint8_t PROBABILITY_CUTOFF_Q8 = (uint8_t) (0.97f * 255.0f + 0.5f);  // 247
static const size_t SLIDING_WINDOW_SIZE = 5;
// Headroom over the observed arena_used (~15.5 KiB at runtime; manifest claims
// 22860). 28 KiB clears the real need with margin while staying small enough to
// fit alongside the audio path + WSS buffers in internal RAM (a 48 KiB internal
// alloc failed once the stereo mic-pump scratch buffer grew). esp-nn's arena
// need varies a little by version, so this leaves ~12 KiB slack.
static const size_t TENSOR_ARENA_SIZE = 28 * 1024;
static const size_t VAR_ARENA_SIZE = 1024;
static const int MIN_SLICES_BEFORE_DETECTION = 100;  // warm-up before any fire

// Embedded model FlatBuffer (CMakeLists EMBED_FILES "model/hey_jarvis.tflite").
extern const uint8_t hey_jarvis_tflite_start[] asm("_binary_hey_jarvis_tflite_start");
extern const uint8_t hey_jarvis_tflite_end[] asm("_binary_hey_jarvis_tflite_end");

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
static patch_wakeword_handler_t s_handler = nullptr;
static void *s_user = nullptr;
static volatile bool s_paused = false;

static FrontendState s_frontend_state;
static FrontendConfig s_frontend_config;
static volatile int16_t s_mic_peak = 0;  // F1 diag: peak mic amplitude this window
static volatile uint16_t s_feat_peak = 0;  // F1 diag: peak raw frontend feature this window

namespace {

// Streaming microWakeWord model — a direct port of ESPHome's
// StreamingModel/WakeWordModel inference path.
class StreamingWakeWord {
 public:
  bool setup() {
    var_arena_ = static_cast<uint8_t *>(
        heap_caps_malloc(VAR_ARENA_SIZE, MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL));
    if (!var_arena_) {
      ESP_LOGE(TAG, "var arena alloc failed");
      return false;
    }
    tensor_arena_ = static_cast<uint8_t *>(
        heap_caps_malloc(TENSOR_ARENA_SIZE, MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL));
    if (!tensor_arena_) {
      ESP_LOGE(TAG, "tensor arena alloc (%u B) failed", (unsigned) TENSOR_ARENA_SIZE);
      return false;
    }

    if (!register_ops(op_resolver_)) {
      ESP_LOGE(TAG, "op resolver registration failed");
      return false;
    }

    const tflite::Model *model = tflite::GetModel(hey_jarvis_tflite_start);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
      ESP_LOGE(TAG, "model schema %lu != supported %d",
               (unsigned long) model->version(), TFLITE_SCHEMA_VERSION);
      return false;
    }

    ma_ = tflite::MicroAllocator::Create(var_arena_, VAR_ARENA_SIZE);
    mrv_ = tflite::MicroResourceVariables::Create(ma_, 20);
    if (!ma_ || !mrv_) {
      ESP_LOGE(TAG, "micro allocator / resource variables create failed");
      return false;
    }

    interpreter_ = new tflite::MicroInterpreter(model, op_resolver_, tensor_arena_,
                                                TENSOR_ARENA_SIZE, mrv_);
    if (interpreter_->AllocateTensors() != kTfLiteOk) {
      ESP_LOGE(TAG, "AllocateTensors failed (arena too small?)");
      return false;
    }

    TfLiteTensor *input = interpreter_->input(0);
    if (input->dims->size != 3 || input->dims->data[0] != 1 ||
        input->dims->data[2] != PREPROCESSOR_FEATURE_SIZE) {
      ESP_LOGE(TAG, "model input dims unexpected");
      return false;
    }
    if (input->type != kTfLiteInt8) {
      ESP_LOGE(TAG, "model input not int8");
      return false;
    }
    TfLiteTensor *output = interpreter_->output(0);
    if (output->dims->size != 2 || output->dims->data[0] != 1 ||
        output->dims->data[1] != 1) {
      ESP_LOGE(TAG, "model output dims not 1x1");
      return false;
    }
    if (output->type != kTfLiteUInt8) {
      ESP_LOGE(TAG, "model output not uint8");
      return false;
    }

    stride_ = static_cast<uint8_t>(input->dims->data[1]);
    // v2 microWakeWord models carry their own input quantization (scale + zero
    // point). The feature path quantizes the float spectrogram into this int8
    // grid; reading it from the model (not hard-coding) keeps us correct across
    // model revisions. hey_jarvis.tflite: scale=0.101961 zp=-128.
    input_scale_ = input->params.scale;
    input_zero_point_ = input->params.zero_point;
    if (input_scale_ <= 0.0f) {
      ESP_LOGE(TAG, "model input has no quantization scale");
      return false;
    }
    recent_probabilities_.assign(SLIDING_WINDOW_SIZE, 0);
    ESP_LOGI(TAG, "microWakeWord ready: 'Hey Jarvis' stride=%u cutoff=%u/255 window=%u arena_used=%u in_scale=%.6f in_zp=%d",
             stride_, PROBABILITY_CUTOFF_Q8, (unsigned) SLIDING_WINDOW_SIZE,
             (unsigned) interpreter_->arena_used_bytes(),
             input_scale_, input_zero_point_);
    reset_probabilities();
    return true;
  }

  // Feed one 40-feature int8 slice; runs an inference every `stride_` slices.
  void infer(const int8_t features[PREPROCESSOR_FEATURE_SIZE]) {
    TfLiteTensor *input = interpreter_->input(0);
    current_stride_step_ = current_stride_step_ % stride_;
    std::memmove(reinterpret_cast<int8_t *>(input->data.int8) +
                     PREPROCESSOR_FEATURE_SIZE * current_stride_step_,
                 features, PREPROCESSOR_FEATURE_SIZE);
    ++current_stride_step_;

    if (current_stride_step_ >= stride_) {
      if (interpreter_->Invoke() != kTfLiteOk) {
        ESP_LOGW(TAG, "Invoke failed");
        return;
      }
      TfLiteTensor *output = interpreter_->output(0);
      ++last_n_index_;
      if (last_n_index_ == SLIDING_WINDOW_SIZE) last_n_index_ = 0;
      recent_probabilities_[last_n_index_] = output->data.uint8[0];
      ++inference_count_;
      if (output->data.uint8[0] > peak_prob_) peak_prob_ = output->data.uint8[0];
    }
    if (recent_probabilities_[last_n_index_] < PROBABILITY_CUTOFF_Q8) {
      ignore_windows_ = std::min(ignore_windows_ + 1, 0);
    }
  }

  // Returns true on a fresh detection; resets the window so it can't double-fire.
  bool detected() {
    if (ignore_windows_ < 0) return false;
    uint32_t sum = 0;
    for (uint8_t p : recent_probabilities_) sum += p;
    bool det = sum > (uint32_t) PROBABILITY_CUTOFF_Q8 * SLIDING_WINDOW_SIZE;
    if (det) reset_probabilities();
    return det;
  }

  void reset_probabilities() {
    std::fill(recent_probabilities_.begin(), recent_probabilities_.end(), 0);
    ignore_windows_ = -MIN_SLICES_BEFORE_DETECTION;
  }

  // Diagnostics (F1 verification only): peak single-window probability and the
  // number of inferences since the last drain. Lets the bench confirm the
  // frontend->inference pipeline is live and see how close audio comes to the
  // cutoff. Drained (and logged) once per ~2s by the task.
  uint32_t inference_count_{0};
  uint8_t peak_prob_{0};
  float input_scale() const { return input_scale_; }
  int32_t input_zero_point() const { return input_zero_point_; }
  void drain_diag(uint32_t *count, uint8_t *peak) {
    *count = inference_count_;
    *peak = peak_prob_;
    inference_count_ = 0;
    peak_prob_ = 0;
  }

 private:
  static bool register_ops(tflite::MicroMutableOpResolver<20> &r) {
    return r.AddCallOnce() == kTfLiteOk && r.AddVarHandle() == kTfLiteOk &&
           r.AddReshape() == kTfLiteOk && r.AddReadVariable() == kTfLiteOk &&
           r.AddStridedSlice() == kTfLiteOk && r.AddConcatenation() == kTfLiteOk &&
           r.AddAssignVariable() == kTfLiteOk && r.AddConv2D() == kTfLiteOk &&
           r.AddMul() == kTfLiteOk && r.AddAdd() == kTfLiteOk &&
           r.AddMean() == kTfLiteOk && r.AddFullyConnected() == kTfLiteOk &&
           r.AddLogistic() == kTfLiteOk && r.AddQuantize() == kTfLiteOk &&
           r.AddDepthwiseConv2D() == kTfLiteOk && r.AddAveragePool2D() == kTfLiteOk &&
           r.AddMaxPool2D() == kTfLiteOk && r.AddPad() == kTfLiteOk &&
           r.AddPack() == kTfLiteOk && r.AddSplitV() == kTfLiteOk;
  }

  tflite::MicroMutableOpResolver<20> op_resolver_;
  uint8_t *tensor_arena_{nullptr};
  uint8_t *var_arena_{nullptr};
  tflite::MicroAllocator *ma_{nullptr};
  tflite::MicroResourceVariables *mrv_{nullptr};
  tflite::MicroInterpreter *interpreter_{nullptr};
  uint8_t stride_{1};
  float input_scale_{0.0f};
  int32_t input_zero_point_{0};
  uint8_t current_stride_step_{0};
  size_t last_n_index_{0};
  int16_t ignore_windows_{-MIN_SLICES_BEFORE_DETECTION};
  std::vector<uint8_t> recent_probabilities_;
};

StreamingWakeWord s_model;

// microWakeWord v2 feature scaling.
//
// The TFLite-Micro audio frontend emits each mel channel as a uint16 in the
// microWakeWord range (~0..26). The v2 training pipeline normalises that to a
// float feature by dividing by FEATURE_FLOAT_SCALE (25.6, the microWakeWord
// MICRO_FEATURES_SCALE), then the model's int8 input layer quantises it with
// the FlatBuffer's own input scale/zero-point:
//
//   int8 = round( (frontend_value / 25.6) / input_scale ) + input_zero_point
//
// This is the v2 path; the previous code used the legacy ESPHome-v1 formula
// (value*256+333)/666 - 128, which maps the small v2 frontend range almost
// entirely onto INT8_MIN — so every inference saw "silence" and peak_prob
// pinned at 0/255 even with real speech. Verified offline against the real
// hey_jarvis.tflite: this scaling drives a spoken/played "Hey Jarvis" to 255
// while silence/noise stay 0 (see .tmp/f1-prov reference harness).
static const float FEATURE_FLOAT_SCALE = 25.6f;

void scale_features(const uint16_t *values, size_t n, float input_scale,
                    int32_t input_zero_point,
                    int8_t out[PREPROCESSOR_FEATURE_SIZE]) {
  const float inv = 1.0f / (FEATURE_FLOAT_SCALE * input_scale);
  for (size_t i = 0; i < n && i < PREPROCESSOR_FEATURE_SIZE; ++i) {
    int32_t v = (int32_t) lroundf((float) values[i] * inv) + input_zero_point;
    if (v < INT8_MIN) v = INT8_MIN;
    if (v > INT8_MAX) v = INT8_MAX;
    out[i] = (int8_t) v;
  }
}

void init_frontend() {
  FrontendFillConfigWithDefaults(&s_frontend_config);
  s_frontend_config.window.size_ms = FEATURE_DURATION_MS;
  s_frontend_config.window.step_size_ms = FEATURE_STEP_SIZE_MS;
  s_frontend_config.filterbank.num_channels = PREPROCESSOR_FEATURE_SIZE;
  s_frontend_config.filterbank.lower_band_limit = FILTERBANK_LOWER_BAND_LIMIT;
  s_frontend_config.filterbank.upper_band_limit = FILTERBANK_UPPER_BAND_LIMIT;
  s_frontend_config.noise_reduction.smoothing_bits = NOISE_REDUCTION_SMOOTHING_BITS;
  s_frontend_config.noise_reduction.even_smoothing = NOISE_REDUCTION_EVEN_SMOOTHING;
  s_frontend_config.noise_reduction.odd_smoothing = NOISE_REDUCTION_ODD_SMOOTHING;
  s_frontend_config.noise_reduction.min_signal_remaining = NOISE_REDUCTION_MIN_SIGNAL_REMAINING;
  s_frontend_config.pcan_gain_control.enable_pcan = PCAN_GAIN_CONTROL_ENABLE_PCAN;
  s_frontend_config.pcan_gain_control.strength = PCAN_GAIN_CONTROL_STRENGTH;
  s_frontend_config.pcan_gain_control.offset = PCAN_GAIN_CONTROL_OFFSET;
  s_frontend_config.pcan_gain_control.gain_bits = PCAN_GAIN_CONTROL_GAIN_BITS;
  s_frontend_config.log_scale.enable_log = LOG_SCALE_ENABLE_LOG;
  s_frontend_config.log_scale.scale_shift = LOG_SCALE_SCALE_SHIFT;
}

void wakeword_task(void *arg) {
  (void) arg;

  init_frontend();
  if (!FrontendPopulateState(&s_frontend_config, &s_frontend_state, 16000)) {
    ESP_LOGE(TAG, "FrontendPopulateState failed");
    vTaskDelete(nullptr);
    return;
  }
  if (!s_model.setup()) {
    ESP_LOGE(TAG, "microWakeWord model setup failed; wake word DISABLED");
    vTaskDelete(nullptr);
    return;
  }

  QueueHandle_t q = (QueueHandle_t) patch_mic_pump_subscribe(PMPS_CONSUMER_WAKEWORD);
  if (!q) {
    ESP_LOGE(TAG, "mic pump subscribe failed");
    vTaskDelete(nullptr);
    return;
  }

  int64_t last_diag_ms = 0;

  // The frontend buffers samples internally and only emits a feature slice once
  // it has a full FEATURE_DURATION_MS window, advancing by FEATURE_STEP_SIZE_MS
  // each call. We hand it whole 20 ms (320-sample) pump frames; it returns at
  // most a couple of slices per call.
  for (;;) {
    if (s_paused) {
      patch_mic_frame_t *drain = nullptr;
      while (xQueueReceive(q, &drain, 0) == pdTRUE) patch_mic_pump_release(drain);
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }

    patch_mic_frame_t *f = nullptr;
    if (xQueueReceive(q, &f, pdMS_TO_TICKS(40)) != pdTRUE) continue;

    const int16_t *src = patch_mic_frame_data(f);
    size_t remaining = patch_mic_frame_samples(f);
    // F1 diagnostic: accumulate peak mic amplitude this window so we can tell
    // whether the mic path is delivering real audio (non-zero) or silence.
    for (size_t i = 0; i < remaining; ++i) {
      int16_t v = src[i];
      int32_t a = v < 0 ? -v : v;
      if (a > (int32_t) s_mic_peak) s_mic_peak = (int16_t) a;
    }
    size_t offset = 0;
    while (remaining > 0) {
      size_t consumed = 0;
      FrontendOutput out =
          FrontendProcessSamples(&s_frontend_state, src + offset, remaining, &consumed);
      if (consumed == 0) break;  // frontend wants more samples than this frame holds
      offset += consumed;
      remaining -= consumed;
      if (out.size > 0) {
        // F1 diag: track the raw frontend feature peak so the bench can confirm
        // the spectrogram range (microWakeWord v2 ~0..26) and that scaling lands
        // it in the int8 grid.
        for (int fi = 0; fi < out.size; ++fi)
          if (out.values[fi] > s_feat_peak) s_feat_peak = out.values[fi];
        int8_t feats[PREPROCESSOR_FEATURE_SIZE];
        scale_features(out.values, out.size, s_model.input_scale(),
                       s_model.input_zero_point(), feats);
        s_model.infer(feats);
        if (s_model.detected()) {
          ESP_LOGI(TAG, "wake word detected! ('Hey Jarvis')");
          if (!s_paused && s_handler) s_handler(s_user);
        }
      }
    }
    patch_mic_pump_release(f);

    // F1 diagnostic: every ~2 s, report inference throughput + peak window
    // probability so the bench can confirm the frontend->inference pipeline is
    // live and gauge how close incoming audio came to the 247/255 cutoff.
    int64_t now = (int64_t) xTaskGetTickCount() * portTICK_PERIOD_MS;
    if (now - last_diag_ms >= 2000) {
      uint32_t cnt = 0;
      uint8_t peak = 0;
      s_model.drain_diag(&cnt, &peak);
      ESP_LOGI(TAG, "ww diag: inferences=%lu peak_prob=%u/255 (cutoff=%u) mic_peak=%d feat_peak=%u",
               (unsigned long) cnt, peak, PROBABILITY_CUTOFF_Q8, (int) s_mic_peak,
               (unsigned) s_feat_peak);
      s_mic_peak = 0;
      s_feat_peak = 0;
      last_diag_ms = now;
    }
  }
}

}  // namespace

extern "C" void patch_wakeword_init(patch_wakeword_handler_t handler, void *user) {
  s_handler = handler;
  s_user = user;
  // Pinned to core 1 — opposite the mic-pump producer + WS sender (core 0).
  // TFLite-Micro inference is CPU-bound; keeping it off core 0 stops it
  // starving the audio path. 16 KiB stack: the interpreter's call frames plus
  // the frontend's per-slice work need more than the old 8 KiB esp-sr wrapper.
  xTaskCreatePinnedToCore(wakeword_task, "patch-ww", 16384, nullptr, 5, nullptr, 1);
}

extern "C" void patch_wakeword_pause(void) { s_paused = true; }
extern "C" void patch_wakeword_resume(void) { s_paused = false; }
