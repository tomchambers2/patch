idf_component_register(
    SRCS "patch_ota.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES esp_http_client esp_https_ota log freertos app_update esp_event esp_timer
)
