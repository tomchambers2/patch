idf_component_register(
    SRCS "patch_led.c"
    INCLUDE_DIRS "include"
    REQUIRES patch_state
    PRIV_REQUIRES espressif__led_strip log freertos esp_driver_gpio
)
