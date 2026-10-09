idf_component_register(
    SRCS
        "patch_control_frames.c"
        "patch_device_state.c"
        "patch_ring_fsm.c"
        "patch_led_table.c"
        "patch_led_diff.c"
        "patch_boot_check.c"
        "patch_mic_pump_state.c"
        "patch_tts_render.c"
    INCLUDE_DIRS
        "include"
    REQUIRES
        # Pure C — no IDF deps.
)
