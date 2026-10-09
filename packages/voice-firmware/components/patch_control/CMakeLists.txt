idf_component_register(
    SRCS "patch_control.c"
    INCLUDE_DIRS "include"
    REQUIRES patch_state
    PRIV_REQUIRES esp_websocket_client log freertos esp_event
)
