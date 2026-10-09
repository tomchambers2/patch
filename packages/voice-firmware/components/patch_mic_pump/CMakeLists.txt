idf_component_register(
    SRCS "patch_mic_pump.c"
    INCLUDE_DIRS "include"
    REQUIRES patch_state patch_button
    PRIV_REQUIRES driver log freertos esp_timer
)
