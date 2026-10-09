# ESP-IDF top-level project file for patch-voice-device.
# Build with `idf.py set-target esp32s3 && idf.py build`.
cmake_minimum_required(VERSION 3.16)

# Targets the ESP32-S3 (HA Voice Preview Edition).
set(IDF_TARGET "esp32s3" CACHE STRING "")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(patch-voice-device)

# Enforce ESP-IDF v5.3.2 — `idf_component.yml` declares `idf: '==5.3.2'`,
# but that pin is only checked by the component manager (release-time check).
# Per spec/principles.md (no fallbacks): fail loud at configure time if a
# different IDF is sourced into the environment. IDF's own CMake-side
# variables (set by project.cmake above) are the canonical source —
# ESP_IDF_VERSION env var only carries major.minor.
if(NOT IDF_VERSION_MAJOR EQUAL 5 OR NOT IDF_VERSION_MINOR EQUAL 3 OR NOT IDF_VERSION_PATCH EQUAL 2)
  message(FATAL_ERROR "This project requires ESP-IDF 5.3.2 (got: ${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}.${IDF_VERSION_PATCH}). Source `~/esp/esp-idf/export.sh` from a v5.3.2 checkout.")
endif()

# --- libsodium AEGIS link fix ------------------------------------------------
#
# The pinned espressif/libsodium (1.0.20~1) ships a CMakeLists.txt whose `srcs`
# list was derived from a pre-AEGIS Makefile.am, but the bundled libsodium
# source's sodium_init() calls _crypto_aead_aegis128l/256_pick_best_implementation()
# (sodium/core.c:48-49). The two files that define those symbols are never
# compiled, so the final link fails with undefined references. We can't edit the
# checksummed managed component, so inject the missing translation units into its
# target here, after project() has registered it. No fallback — if the component
# layout changes the TARGET guard simply no-ops and the link error returns,
# surfacing the regression instead of hiding it.
set(_patch_libsodium_target __idf_espressif__libsodium)
if(TARGET ${_patch_libsodium_target})
  set(_patch_libsodium_src
      ${CMAKE_CURRENT_SOURCE_DIR}/managed_components/espressif__libsodium/libsodium/src/libsodium)
  target_sources(${_patch_libsodium_target} PRIVATE
      ${_patch_libsodium_src}/crypto_aead/aegis128l/aead_aegis128l.c
      ${_patch_libsodium_src}/crypto_aead/aegis128l/aegis128l_soft.c
      ${_patch_libsodium_src}/crypto_aead/aegis256/aead_aegis256.c
      ${_patch_libsodium_src}/crypto_aead/aegis256/aegis256_soft.c
      # Portable AES used by the soft AEGIS impls (no AES-NI/ARM-crypto on
      # Xtensa); also omitted from the component's srcs.
      ${_patch_libsodium_src}/crypto_core/softaes/softaes.c
  )
endif()
