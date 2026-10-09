idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash esp_wifi esp_event esp_netif freertos log
        esp_driver_usb_serial_jtag
        patch_state patch_led patch_button patch_audio
        patch_wakeword patch_control patch_provision patch_ota
)
