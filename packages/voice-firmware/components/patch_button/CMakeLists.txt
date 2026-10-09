idf_component_register(
    SRCS "patch_button.c" "patch_press.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES driver esp_timer esp_system log freertos patch_provision
)
