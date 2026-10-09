# patch_wakeword — microWakeWord (TFLite-Micro) wake-word engine.
#
# Sources:
#   patch_wakeword.cpp                  — C wrapper + streaming inference loop
#   microfrontend/.../*.{c,cc}          — vendored TFLite-Micro audio "micro
#                                         frontend" (spectrogram feature gen),
#                                         the same lib ESPHome's micro_wake_word
#                                         uses. NOT shipped by esp-tflite-micro,
#                                         so vendored here from tflite-micro.
#   third_party/kissfft/kiss_fft.c + tools/kiss_fftr.c are intentionally NOT in
#   SRCS — kiss_fft_int16.cc #includes them inside the kissfft_fixed16 namespace
#   with FIXED_POINT=16. Compiling them standalone would double-define symbols.
#
# The hey_jarvis.tflite FlatBuffer is embedded into the app image (EMBED_FILES)
# and reached via _binary_hey_jarvis_tflite_{start,end}.

set(MF_LIB "microfrontend/tensorflow/lite/experimental/microfrontend/lib")

idf_component_register(
    SRCS
        "patch_wakeword.cpp"
        "${MF_LIB}/fft.cc"
        "${MF_LIB}/fft_util.cc"
        "${MF_LIB}/filterbank.c"
        "${MF_LIB}/filterbank_util.c"
        "${MF_LIB}/frontend.c"
        "${MF_LIB}/frontend_util.c"
        "${MF_LIB}/kiss_fft_int16.cc"
        "${MF_LIB}/log_lut.c"
        "${MF_LIB}/log_scale.c"
        "${MF_LIB}/log_scale_util.c"
        "${MF_LIB}/noise_reduction.c"
        "${MF_LIB}/noise_reduction_util.c"
        "${MF_LIB}/pcan_gain_control.c"
        "${MF_LIB}/pcan_gain_control_util.c"
        "${MF_LIB}/window.c"
        "${MF_LIB}/window_util.c"
    INCLUDE_DIRS
        "include"
    PRIV_INCLUDE_DIRS
        "microfrontend"
        "microfrontend/third_party/kissfft"
    REQUIRES patch_audio patch_mic_pump patch_state
    PRIV_REQUIRES esp-tflite-micro driver log freertos esp_psram
    EMBED_FILES "model/hey_jarvis.tflite"
)

# The vendored microfrontend + kissfft sources are upstream third-party C/C++;
# they don't compile clean under our -Werror project flags (sign-compare,
# unused, etc). Relax warnings for this component only — our own
# patch_wakeword.cpp is still subject to the project defaults at review time.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error -w)
