idf_component_register(
    SRCS "patch_codec.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_driver_i2c esp_driver_gpio log patch_state
)
