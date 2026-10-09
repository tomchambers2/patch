idf_component_register(
    SRCS "patch_provision.c" "patch_pair_qr.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        nvs_flash esp_wifi esp_event log freertos
        wifi_provisioning
        esp_http_client
        mbedtls
        espressif__libsodium
)
