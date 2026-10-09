// Minimal Unity-style test assertion helpers. We don't pull Unity itself
// because the host-test build is meant to work with just a bare clang/gcc
// install — the firmware repo isn't a place to set up an extra dep.

#ifndef PATCH_TEST_HELPERS_H
#define PATCH_TEST_HELPERS_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TEST_RUN(name) do { \
    fprintf(stderr, "  - " #name " ... "); \
    name(); \
    fprintf(stderr, "ok\n"); \
} while (0)

#define TEST_FAIL(fmt, ...) do { \
    fprintf(stderr, "FAIL %s:%d: " fmt "\n", __FILE__, __LINE__, ##__VA_ARGS__); \
    abort(); \
} while (0)

#define ASSERT_TRUE(x) do { if (!(x)) TEST_FAIL("expected true: %s", #x); } while (0)
#define ASSERT_FALSE(x) do { if ((x)) TEST_FAIL("expected false: %s", #x); } while (0)
#define ASSERT_EQ_INT(a, b) do { \
    long _a = (long)(a), _b = (long)(b); \
    if (_a != _b) TEST_FAIL("expected %ld == %ld (%s == %s)", _a, _b, #a, #b); \
} while (0)
#define ASSERT_EQ_STR(a, b) do { \
    if (strcmp((a), (b)) != 0) TEST_FAIL("expected '%s' == '%s'", (a), (b)); \
} while (0)
#define ASSERT_NOT_NULL(p) do { if ((p) == NULL) TEST_FAIL("expected non-null: %s", #p); } while (0)

#endif
