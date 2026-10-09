// Host-side unit tests for patch_boot_check.
//
// These cover the pure-C boot-time validator that main.c invokes against
// CONFIG_PATCH_SERVER_URL before any network code runs. The firmware
// halts (ESP_LOGE + esp_restart after 5s) on a non-OK result; the test
// stub here just exercises the classification logic.

#include "patch_boot_check.h"
#include "test_helpers.h"

static void test_placeholder_url_is_rejected(void) {
    // The exact string Kconfig ships as the default. If a fresh build
    // boots without anyone running menuconfig, this is what main.c sees.
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.example.com"),
                  PATCH_BOOT_CHECK_PLACEHOLDER);
}

static void test_placeholder_macro_matches_default(void) {
    // The macro the firmware uses in its log message must be byte-for-byte
    // the same as the Kconfig default — otherwise the diagnostic lies.
    ASSERT_EQ_STR(PATCH_BOOT_CHECK_PLACEHOLDER_URL,
                  "https://patch.example.com");
}

static void test_null_url_is_empty(void) {
    ASSERT_EQ_INT(patch_boot_check_server_url(NULL), PATCH_BOOT_CHECK_EMPTY);
}

static void test_empty_string_is_empty(void) {
    ASSERT_EQ_INT(patch_boot_check_server_url(""), PATCH_BOOT_CHECK_EMPTY);
}

static void test_real_url_is_ok(void) {
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.tomchambers.dev"),
                  PATCH_BOOT_CHECK_OK);
    ASSERT_EQ_INT(patch_boot_check_server_url("https://10.0.0.5:8443"),
                  PATCH_BOOT_CHECK_OK);
}

static void test_example_host_variants_are_rejected(void) {
    // Any URL that still points at the example host is an unconfigured build
    // and must fail loud — not only the exact Kconfig default string. A
    // half-edited fresh build (changed scheme/case, added a trailing slash or
    // path, or dropped the scheme) still resolves to the placeholder host.
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.example.com/"),
                  PATCH_BOOT_CHECK_PLACEHOLDER);
    ASSERT_EQ_INT(patch_boot_check_server_url("HTTPS://PATCH.EXAMPLE.COM"),
                  PATCH_BOOT_CHECK_PLACEHOLDER);
    ASSERT_EQ_INT(patch_boot_check_server_url("patch.example.com"),
                  PATCH_BOOT_CHECK_PLACEHOLDER);
    ASSERT_EQ_INT(patch_boot_check_server_url("http://patch.example.com"),
                  PATCH_BOOT_CHECK_PLACEHOLDER);
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.example.com/firmware/0.2.0.bin"),
                  PATCH_BOOT_CHECK_PLACEHOLDER);
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.example.com:8443"),
                  PATCH_BOOT_CHECK_PLACEHOLDER);
}

static void test_similar_but_distinct_is_ok(void) {
    // A genuinely different host that merely shares a prefix with the example
    // host must NOT be flagged — only the example host itself.
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.example.co"),
                  PATCH_BOOT_CHECK_OK);
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.example.community"),
                  PATCH_BOOT_CHECK_OK);
    ASSERT_EQ_INT(patch_boot_check_server_url("https://patch.example.com.evil.test"),
                  PATCH_BOOT_CHECK_OK);
    ASSERT_EQ_INT(patch_boot_check_server_url("https://notpatch.example.com"),
                  PATCH_BOOT_CHECK_OK);
}

int main(void) {
    fprintf(stderr, "test_boot_check\n");
    TEST_RUN(test_placeholder_url_is_rejected);
    TEST_RUN(test_placeholder_macro_matches_default);
    TEST_RUN(test_null_url_is_empty);
    TEST_RUN(test_empty_string_is_empty);
    TEST_RUN(test_real_url_is_ok);
    TEST_RUN(test_example_host_variants_are_rejected);
    TEST_RUN(test_similar_but_distinct_is_ok);
    fprintf(stderr, "test_boot_check: all passed\n");
    return 0;
}
