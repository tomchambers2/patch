# Host-side unit tests for the patch voice-firmware pure-C state machines.
#
# These tests build with the system clang/gcc — no ESP-IDF toolchain required.
# Run with:
#   cmake -S host_test -B host_test/build
#   cmake --build host_test/build
#   ctest --test-dir host_test/build --output-on-failure
#
# Coverage:
#   - patch_control_frames: encode/decode round-trip + reject malformed
#   - patch_device_state:   master FSM transitions, mute/disconnected override
#   - patch_ring_fsm:       30 s timeout, accept, dismiss
#   - patch_led_table:      every pds_state_t has a row, deterministic colours
#   - audio_session_start:  the audio-WSS handshake envelope — daemon-pushed
#                           voice token replayed verbatim, surfaceKind "device",
#                           surfaceHasAec false, never minted on-device (F1-11)
#   - tts_render:           PCM16 -> 32-bit-slot widening that drives the
#                           speaker — full-scale, in order, no drops (F1-audible-1)

cmake_minimum_required(VERSION 3.16)

# --- ASan-capable compiler selection (must run before project()) ----------
# The host tests are MANDATORILY built with -fsanitize=address,undefined
# (see spec/16-voice-device.md TF1: "any sanitiser hit fails the run").
# Apple's bundled clang ships an AddressSanitizer runtime whose dynamic
# shadow-memory probe (FindDynamicShadowStart) hangs forever at process
# startup on Darwin 25 / macOS 26 arm64 — even an empty `int main(){}`
# never returns. That makes the AppleClang toolchain unusable for this
# suite on current macOS. When the user has not pinned a compiler and the
# default would be AppleClang on such a kernel, switch to a Homebrew LLVM
# clang (whose newer ASan runtime maps its shadow correctly). If none is
# available we do NOT silently fall back to a no-sanitiser build — we fail
# loud, per spec/principles.md.
if(NOT DEFINED CMAKE_C_COMPILER AND NOT DEFINED ENV{CC} AND APPLE)
    execute_process(COMMAND cc --version OUTPUT_VARIABLE _cc_ver ERROR_VARIABLE _cc_ver)
    if(_cc_ver MATCHES "Apple clang")
        find_program(_brew_clang clang
            PATHS /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin
            NO_DEFAULT_PATH)
        if(_brew_clang)
            set(CMAKE_C_COMPILER "${_brew_clang}" CACHE FILEPATH "ASan-capable clang" FORCE)
            message(STATUS "Using ${_brew_clang} (AppleClang ASan runtime hangs on this macOS)")
        else()
            message(FATAL_ERROR
                "AppleClang's AddressSanitizer runtime hangs at startup on this "
                "macOS; install an LLVM toolchain with a working ASan runtime "
                "(`brew install llvm`) — refusing to build the sanitiser suite "
                "with a compiler whose ASan cannot run.")
        endif()
    endif()
endif()
# --------------------------------------------------------------------------

project(patch-voice-firmware-host-test C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
    message(WARNING "Untested compiler: ${CMAKE_C_COMPILER_ID}")
endif()

add_compile_options(
    -Wall
    -Wextra
    -Werror
    -Wno-unused-parameter
    -fsanitize=address,undefined
    # A UBSan check defaults to "recover": it prints a diagnostic and CONTINUES,
    # leaving the process exit code 0 — so a real undefined-behaviour hit (e.g. a
    # signed left-shift in the TTS widening) would print but NOT fail ctest, in
    # violation of TF1 "any sanitiser hit fails the run". -fno-sanitize-recover
    # makes every sanitiser check trap (non-zero exit) on first hit, so ctest
    # turns red. (ASan already aborts; this closes the UBSan-only gap.)
    -fno-sanitize-recover=all
    -g
    -O0
)
add_link_options(-fsanitize=address,undefined -fno-sanitize-recover=all)

set(STATE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../components/patch_state)
set(BUTTON_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../components/patch_button)

include_directories(${STATE_DIR}/include)

add_library(patch_state STATIC
    ${STATE_DIR}/patch_control_frames.c
    ${STATE_DIR}/patch_device_state.c
    ${STATE_DIR}/patch_ring_fsm.c
    ${STATE_DIR}/patch_led_table.c
    ${STATE_DIR}/patch_boot_check.c
    ${STATE_DIR}/patch_led_diff.c
    ${STATE_DIR}/patch_mic_pump_state.c
    ${STATE_DIR}/patch_tts_render.c
)

# Button-press classifier — pure C, no FreeRTOS / ESP-IDF deps. Lives in
# patch_button/patch_press.c so the same code is exercised here and on the
# device. The on-device task glue (touch_pad / GPIO) stays out of host tests.
add_library(patch_press STATIC
    ${BUTTON_DIR}/patch_press.c
)
target_include_directories(patch_press PUBLIC ${BUTTON_DIR}/include)

enable_testing()

function(add_patch_test name)
    add_executable(${name} ${name}.c)
    target_link_libraries(${name} PRIVATE patch_state)
    add_test(NAME ${name} COMMAND ${name})
endfunction()

add_patch_test(test_control_frames)
add_patch_test(test_device_state)
add_patch_test(test_ring_fsm)
add_patch_test(test_led_table)
add_patch_test(test_boot_check)
add_patch_test(test_mic_pump_state)
add_patch_test(test_audio_session_start)
add_patch_test(test_tts_render)

add_executable(test_button test_button.c)
target_link_libraries(test_button PRIVATE patch_press)
add_test(NAME test_button COMMAND test_button)
