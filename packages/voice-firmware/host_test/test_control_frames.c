#include "patch_control_frames.h"
#include "test_helpers.h"

static void test_encode_hello(void) {
    char buf[256]; size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_hello(buf, sizeof buf, &n, "kitchen-01", "0.1.0", true), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"hello\",\"deviceId\":\"kitchen-01\",\"fwVersion\":\"0.1.0\",\"muted\":true}");

    ASSERT_EQ_INT(pcf_encode_hello(buf, sizeof buf, &n, "bedroom-A", "0.1.0", false), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"hello\",\"deviceId\":\"bedroom-A\",\"fwVersion\":\"0.1.0\",\"muted\":false}");
}

static void test_encode_simple(void) {
    char buf[128]; size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_wake_detected(buf, sizeof buf, &n), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"wake_detected\"}");

    ASSERT_EQ_INT(pcf_encode_ring_accepted(buf, sizeof buf, &n), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"ring_accepted\"}");

    ASSERT_EQ_INT(pcf_encode_ring_dismissed(buf, sizeof buf, &n), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"ring_dismissed\"}");

    ASSERT_EQ_INT(pcf_encode_mute_changed(buf, sizeof buf, &n, true), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"mute_changed\",\"muted\":true}");
    ASSERT_EQ_INT(pcf_encode_mute_changed(buf, sizeof buf, &n, false), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"mute_changed\",\"muted\":false}");
}

static void test_encode_session_end(void) {
    char buf[128]; size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_session_end(buf, sizeof buf, &n, PCF_SESSION_END_VAD_TIMEOUT), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"session_end\",\"reason\":\"vad-timeout\"}");
    ASSERT_EQ_INT(pcf_encode_session_end(buf, sizeof buf, &n, PCF_SESSION_END_USER_BUTTON), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"session_end\",\"reason\":\"user-button\"}");
    ASSERT_EQ_INT(pcf_encode_session_end(buf, sizeof buf, &n, PCF_SESSION_END_AGENT_FINISHED), PCF_OK);
    ASSERT_EQ_STR(buf, "{\"type\":\"session_end\",\"reason\":\"agent-finished\"}");
}

static void test_encode_buffer_overflow(void) {
    char buf[8]; size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_hello(buf, sizeof buf, &n, "x", "y", false), PCF_ERR_BUFFER);
}

static void test_decode_session_start(void) {
    pcf_inbound_t inb;
    // The daemon pushes the per-session voice token alongside sessionId
    // (spec/16 §Wire protocol "Voice-token delivery") plus the accountId +
    // chatId the device must declare on audio.session_start so its identity
    // matches the token's claims. All four are required.
    const char *j = "{\"type\":\"session_start\",\"sessionId\":\"abc-123\","
                     "\"voiceToken\":\"vt.deadbeef.cafe\",\"accountId\":\"acct-9\","
                     "\"chatId\":\"thread_speakers\",\"conversational\":true}";
    ASSERT_EQ_INT(pcf_decode(j, strlen(j), &inb), PCF_OK);
    ASSERT_EQ_INT(inb.kind, PCF_FRAME_SESSION_START);
    ASSERT_EQ_STR(inb.session_id, "abc-123");
    ASSERT_EQ_STR(inb.voice_token, "vt.deadbeef.cafe");
    ASSERT_EQ_STR(inb.account_id, "acct-9");
    ASSERT_EQ_STR(inb.chat_id, "thread_speakers");

    // Field order independence: shuffled keys still parse.
    const char *j2 = "{\"type\":\"session_start\",\"voiceToken\":\"tok2\","
                     "\"chatId\":\"c2\",\"accountId\":\"a2\",\"sessionId\":\"s2\"}";
    ASSERT_EQ_INT(pcf_decode(j2, strlen(j2), &inb), PCF_OK);
    ASSERT_EQ_STR(inb.session_id, "s2");
    ASSERT_EQ_STR(inb.voice_token, "tok2");
    ASSERT_EQ_STR(inb.account_id, "a2");
    ASSERT_EQ_STR(inb.chat_id, "c2");
}

static void test_decode_session_start_requires_voice_token(void) {
    pcf_inbound_t inb;
    // No fallback — a session_start missing voiceToken (or accountId/chatId) is
    // a protocol error; the device would otherwise open the audio WSS with an
    // empty token / wrong identity, which the daemon rejects with auth_failed.
    const char *j = "{\"type\":\"session_start\",\"sessionId\":\"abc-123\","
                    "\"accountId\":\"a\",\"chatId\":\"c\"}";
    ASSERT_EQ_INT(pcf_decode(j, strlen(j), &inb), PCF_ERR_MISSING);
}

static void test_decode_session_start_rejects_empty_required(void) {
    pcf_inbound_t inb;
    // No fallback — a present-but-empty required field is a protocol error,
    // not an empty-token/empty-id session (symmetric with the encoder, which
    // rejects an empty token/deviceId). Each empty required field in turn must
    // yield PCF_ERR_MISSING.
    const char *empty_token =
        "{\"type\":\"session_start\",\"sessionId\":\"s\",\"voiceToken\":\"\","
        "\"accountId\":\"a\",\"chatId\":\"c\"}";
    ASSERT_EQ_INT(pcf_decode(empty_token, strlen(empty_token), &inb), PCF_ERR_MISSING);

    const char *empty_session =
        "{\"type\":\"session_start\",\"sessionId\":\"\",\"voiceToken\":\"vt\","
        "\"accountId\":\"a\",\"chatId\":\"c\"}";
    ASSERT_EQ_INT(pcf_decode(empty_session, strlen(empty_session), &inb), PCF_ERR_MISSING);

    const char *empty_account =
        "{\"type\":\"session_start\",\"sessionId\":\"s\",\"voiceToken\":\"vt\","
        "\"accountId\":\"\",\"chatId\":\"c\"}";
    ASSERT_EQ_INT(pcf_decode(empty_account, strlen(empty_account), &inb), PCF_ERR_MISSING);

    const char *empty_chat =
        "{\"type\":\"session_start\",\"sessionId\":\"s\",\"voiceToken\":\"vt\","
        "\"accountId\":\"a\",\"chatId\":\"\"}";
    ASSERT_EQ_INT(pcf_decode(empty_chat, strlen(empty_chat), &inb), PCF_ERR_MISSING);
}

static void test_decode_rejects_duplicate_key(void) {
    pcf_inbound_t inb;
    // An ambiguous duplicate top-level key must NOT silently resolve to
    // whichever came last (NO FALLBACKS) — it is rejected as a parse error.
    const char *dup_type =
        "{\"type\":\"ring\",\"type\":\"led\",\"state\":\"idle\","
        "\"chatId\":\"c\",\"conversational\":true}";
    ASSERT_EQ_INT(pcf_decode(dup_type, strlen(dup_type), &inb), PCF_ERR_PARSE);

    const char *dup_chat =
        "{\"type\":\"ring\",\"chatId\":\"a\",\"chatId\":\"b\",\"conversational\":true}";
    ASSERT_EQ_INT(pcf_decode(dup_chat, strlen(dup_chat), &inb), PCF_ERR_PARSE);
}

static void test_decode_rejects_trailing_garbage(void) {
    pcf_inbound_t inb;
    // Non-whitespace bytes after the top-level closing brace mean a corrupt or
    // concatenated frame — reject rather than stop at the first '}'.
    const char *j = "{\"type\":\"ring\",\"chatId\":\"c\",\"conversational\":true}garbage";
    ASSERT_EQ_INT(pcf_decode(j, strlen(j), &inb), PCF_ERR_PARSE);

    // Trailing whitespace only is still fine.
    const char *ok = "{\"type\":\"ring\",\"chatId\":\"c\",\"conversational\":true}   \n";
    ASSERT_EQ_INT(pcf_decode(ok, strlen(ok), &inb), PCF_OK);
}

static void test_decode_rejects_malformed_number_in_ignored_key(void) {
    pcf_inbound_t inb;
    // A structurally-invalid number (multiple leading signs / repeated exponent
    // signs) in an ignored key is a corrupt frame — the value skipper must not
    // swallow any contiguous [0-9+-.eE] run.
    const char *bad = "{\"type\":\"ring\",\"chatId\":\"c\",\"conversational\":true,\"weird\":--1.2e+-3}";
    ASSERT_EQ_INT(pcf_decode(bad, strlen(bad), &inb), PCF_ERR_PARSE);

    // A well-formed number in an ignored key is still accepted.
    const char *good = "{\"type\":\"ring\",\"chatId\":\"c\",\"conversational\":true,\"weird\":-1.2e+3}";
    ASSERT_EQ_INT(pcf_decode(good, strlen(good), &inb), PCF_OK);
    ASSERT_EQ_INT(inb.kind, PCF_FRAME_RING);
}

static void test_decode_ring(void) {
    pcf_inbound_t inb;
    const char *j = "{\"type\":\"ring\",\"chatId\":\"chat-7\",\"message\":\"bus is delayed\",\"conversational\":false}";
    ASSERT_EQ_INT(pcf_decode(j, strlen(j), &inb), PCF_OK);
    ASSERT_EQ_INT(inb.kind, PCF_FRAME_RING);
    ASSERT_EQ_STR(inb.chat_id, "chat-7");
    ASSERT_TRUE(inb.has_message);
    ASSERT_EQ_STR(inb.message, "bus is delayed");
    ASSERT_FALSE(inb.conversational);

    // No message → has_message=false.
    const char *j2 = "{\"type\":\"ring\",\"chatId\":\"c\",\"conversational\":true}";
    ASSERT_EQ_INT(pcf_decode(j2, strlen(j2), &inb), PCF_OK);
    ASSERT_FALSE(inb.has_message);
    ASSERT_TRUE(inb.conversational);
}

static void test_decode_led(void) {
    pcf_inbound_t inb;
    const struct { const char *json; pcf_led_hint_t expect; } cases[] = {
        { "{\"type\":\"led\",\"state\":\"idle\"}",            PCF_LED_IDLE },
        { "{\"type\":\"led\",\"state\":\"listening\"}",       PCF_LED_LISTENING },
        { "{\"type\":\"led\",\"state\":\"agent-speaking\"}",  PCF_LED_AGENT_SPEAKING },
        { "{\"type\":\"led\",\"state\":\"ringing\"}",         PCF_LED_RINGING },
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        ASSERT_EQ_INT(pcf_decode(cases[i].json, strlen(cases[i].json), &inb), PCF_OK);
        ASSERT_EQ_INT(inb.kind, PCF_FRAME_LED);
        ASSERT_EQ_INT(inb.led_hint, cases[i].expect);
    }

    // Unknown LED state → PCF_ERR_TYPE.
    const char *bad = "{\"type\":\"led\",\"state\":\"rave\"}";
    ASSERT_EQ_INT(pcf_decode(bad, strlen(bad), &inb), PCF_ERR_TYPE);
}

static void test_decode_unknown_type(void) {
    pcf_inbound_t inb;
    const char *j = "{\"type\":\"some-future-frame\",\"x\":1}";
    ASSERT_EQ_INT(pcf_decode(j, strlen(j), &inb), PCF_ERR_UNKNOWN_FRAME);
    ASSERT_EQ_INT(inb.kind, PCF_FRAME_UNKNOWN);
}

static void test_decode_malformed(void) {
    pcf_inbound_t inb;
    ASSERT_EQ_INT(pcf_decode("not json", 8, &inb), PCF_ERR_PARSE);
    ASSERT_EQ_INT(pcf_decode("{}", 2, &inb), PCF_ERR_MISSING);
    // session_start missing sessionId
    const char *bad1 = "{\"type\":\"session_start\"}";
    ASSERT_EQ_INT(pcf_decode(bad1, strlen(bad1), &inb), PCF_ERR_MISSING);
    // ring missing required fields
    const char *bad2 = "{\"type\":\"ring\"}";
    ASSERT_EQ_INT(pcf_decode(bad2, strlen(bad2), &inb), PCF_ERR_MISSING);
}

static void test_decode_ignores_extra_keys(void) {
    pcf_inbound_t inb;
    const char *j = "{\"type\":\"session_start\",\"sessionId\":\"s\",\"voiceToken\":\"vt\","
                    "\"accountId\":\"a\",\"chatId\":\"c\",\"future\":42,\"meta\":{\"x\":\"y\"}}";
    ASSERT_EQ_INT(pcf_decode(j, strlen(j), &inb), PCF_OK);
    ASSERT_EQ_STR(inb.session_id, "s");
    ASSERT_EQ_STR(inb.voice_token, "vt");
    ASSERT_EQ_STR(inb.account_id, "a");
    ASSERT_EQ_STR(inb.chat_id, "c");
}

static void test_encode_escapes(void) {
    char buf[128]; size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_hello(buf, sizeof buf, &n, "with \"quotes\"", "1.0", false), PCF_OK);
    // Should contain \" inside the deviceId value.
    ASSERT_NOT_NULL(strstr(buf, "with \\\"quotes\\\""));
}

int main(void) {
    fprintf(stderr, "test_control_frames\n");
    TEST_RUN(test_encode_hello);
    TEST_RUN(test_encode_simple);
    TEST_RUN(test_encode_session_end);
    TEST_RUN(test_encode_buffer_overflow);
    TEST_RUN(test_encode_escapes);
    TEST_RUN(test_decode_session_start);
    TEST_RUN(test_decode_session_start_requires_voice_token);
    TEST_RUN(test_decode_session_start_rejects_empty_required);
    TEST_RUN(test_decode_rejects_duplicate_key);
    TEST_RUN(test_decode_rejects_trailing_garbage);
    TEST_RUN(test_decode_rejects_malformed_number_in_ignored_key);
    TEST_RUN(test_decode_ring);
    TEST_RUN(test_decode_led);
    TEST_RUN(test_decode_unknown_type);
    TEST_RUN(test_decode_malformed);
    TEST_RUN(test_decode_ignores_extra_keys);
    return 0;
}
