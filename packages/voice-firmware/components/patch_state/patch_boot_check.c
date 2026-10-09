#include "patch_boot_check.h"

#include <ctype.h>
#include <stdbool.h>
#include <string.h>

// The example/placeholder host. ANY URL that resolves to this host — with or
// without a scheme, with a trailing slash or path, in any letter case — is an
// unconfigured build that must NOT boot (spec/principles.md: fail loud, no
// fallback). We match on the host token rather than the one exact Kconfig
// string so a half-edited fresh build (e.g. someone changed the scheme but not
// the host) still gets caught.
#define PATCH_BOOT_CHECK_PLACEHOLDER_HOST "patch.example.com"

// Case-insensitive check that `s` begins with `prefix`. Returns the number of
// bytes matched (prefix length) on success, or 0 on no match.
static size_t ci_starts_with(const char *s, const char *prefix) {
    size_t i = 0;
    for (; prefix[i] != '\0'; i++) {
        if (tolower((unsigned char)s[i]) != tolower((unsigned char)prefix[i])) {
            return 0;
        }
    }
    return i;
}

patch_boot_check_result_t patch_boot_check_server_url(const char *url) {
    if (url == NULL || url[0] == '\0') {
        return PATCH_BOOT_CHECK_EMPTY;
    }

    // Strip an optional scheme so "https://", "http://" and a bare host all
    // reduce to the same host token. We only skip a "<scheme>://" prefix; a
    // string with no "://" is treated as already host-first.
    const char *host = url;
    const char *sep = strstr(url, "://");
    if (sep != NULL) {
        host = sep + 3;
    }

    size_t matched = ci_starts_with(host, PATCH_BOOT_CHECK_PLACEHOLDER_HOST);
    if (matched != 0) {
        // The placeholder host matched. It is only a real, distinct host if a
        // host-character (alnum, '-', '.') immediately follows — e.g.
        // "patch.example.community" is a different host and is fine. A path
        // ('/'), port (':'), query, fragment, or end-of-string all mean the
        // host IS the example host, so reject.
        char next = host[matched];
        bool host_continues = (next >= 'a' && next <= 'z') ||
                              (next >= 'A' && next <= 'Z') ||
                              (next >= '0' && next <= '9') ||
                              next == '-' || next == '.';
        if (!host_continues) {
            return PATCH_BOOT_CHECK_PLACEHOLDER;
        }
    }

    return PATCH_BOOT_CHECK_OK;
}
