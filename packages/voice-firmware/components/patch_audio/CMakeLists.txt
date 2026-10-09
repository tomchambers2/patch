idf_component_register(
    SRCS "patch_audio.c" "patch_embedded_speech.c"
    INCLUDE_DIRS "include"
    REQUIRES patch_button patch_mic_pump patch_state patch_codec
    PRIV_REQUIRES driver esp_websocket_client log freertos esp_event esp_psram
)
