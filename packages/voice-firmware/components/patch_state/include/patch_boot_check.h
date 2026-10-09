// patch_boot_check — pure-C boot-time validation helpers.
//
// Per spec/principles.md (fail-loud, no fallbacks): a fresh build that has
// not been configured via `idf.py menuconfig` must NOT silently boot with
// the placeholder Kconfig defaults. Doing so causes downstream DNS/TLS
// failures that look like Wi-Fi problems but are actually misconfiguration.
//
// These helpers are pure C with no ESP-IDF dependency so they can be unit
// tested on the host. main.c calls patch_boot_check_server_url() during
// boot and halts if the result is not OK.

#ifndef PATCH_BOOT_CHECK_H
#define PATCH_BOOT_CHECK_H

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PATCH_BOOT_CHECK_OK = 0,
    // Configured value is empty or NULL — never set.
    PATCH_BOOT_CHECK_EMPTY = 1,
    // Configured value still points at the example/placeholder host. This
    // covers the exact Kconfig default AND obvious half-edited variants
    // (trailing slash/path, missing or changed scheme, different letter case)
    // — all of which mean the build was never configured.
    PATCH_BOOT_CHECK_PLACEHOLDER = 2,
} patch_boot_check_result_t;

// The placeholder URL shipped as the Kconfig default. Exposed as a macro
// so the firmware build and the host tests both agree on the exact string
// (it is used in the fail-loud diagnostic main.c logs).
#define PATCH_BOOT_CHECK_PLACEHOLDER_URL "https://patch.example.com"

// Validate the configured server URL.
//
// Returns:
//   PATCH_BOOT_CHECK_OK          — url is a real, configured value.
//   PATCH_BOOT_CHECK_EMPTY       — url is NULL or empty string.
//   PATCH_BOOT_CHECK_PLACEHOLDER — url still points at the example host
//                                  (any scheme/case/trailing-path variant).
//
// Caller is responsible for emitting a fail-loud log + halting on a
// non-OK result. No fallback, no "best-effort" boot.
patch_boot_check_result_t patch_boot_check_server_url(const char *url);

#ifdef __cplusplus
}
#endif

#endif
