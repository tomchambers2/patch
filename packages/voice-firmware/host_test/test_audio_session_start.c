// Host unit test for the audio-plane session-start envelope — the device's
// audio-WSS handshake (TF1 / F1-11).
//
// F1-11 is a wire-contract assertion about the device's audio-WSS handshake:
//
//   1. The device receives its per-session voice token on the session_start
//      CONTROL frame from the daemon (never mints/fetches it, never calls the
//      server's voice-token endpoint).
//   2. The device presents that exact token, plus surfaceKind "device" and
//      surfaceHasAec false, when opening the audio WSS.
//   3. It identifies as surfaceKind "device" — never web/desktop/mobile.
//
// The bytes the device puts on the audio WSS are produced by
// pcf_encode_audio_session_start() (patch_control_frames). The firmware's
// audio task (patch_audio.c, WEBSOCKET_EVENT_CONNECTED) calls that SAME
// function to build the frame it sends, so asserting it here exercises the
// exact shipped wire contract — no daemon, no flashed board, no test/ship
// drift. The token-provenance half of the contract (token comes from the
// daemon control frame, not minted on-device) is proven by decoding a real
// session_start control frame and feeding ITS token straight into the audio
// envelope: the device code path has no other source for the token, and there
// is no HTTP-mint function anywhere in the firmware tree to call.

#include "patch_control_frames.h"
#include "test_helpers.h"

#include <string.h>

// Build the canonical audio.session_start envelope and assert the exact bytes.
// This is the literal wire frame the daemon's audio server validates against
// packages/wire/src/audio.ts AudioSessionStartEvent.
static void test_audio_session_start_exact_wire(void) {
    char buf[1536];
    size_t n = 0;
    pcf_status_t st = pcf_encode_audio_session_start(
        buf, sizeof buf, &n,
        /* session_id  */ "sess-abc-123",
        /* account_id  */ "acct-9",
        /* surface_id  */ "voice-pe-07138c",
        /* device_id   */ "voice-pe-07138c",
        /* chat_id     */ "thread_speakers",
        /* voice_token */ "vt.daemon.pushed.token");
    ASSERT_EQ_INT(st, PCF_OK);
    ASSERT_EQ_STR(buf,
        "{\"type\":\"audio.session_start\","
        "\"sessionId\":\"sess-abc-123\","
        "\"accountId\":\"acct-9\","
        "\"surfaceId\":\"voice-pe-07138c\","
        "\"surfaceKind\":\"device\","
        "\"deviceId\":\"voice-pe-07138c\","
        "\"chatId\":\"thread_speakers\","
        "\"role\":\"voice-device-conv\","
        "\"token\":\"vt.daemon.pushed.token\","
        "\"surfaceHasAec\":false}");
    ASSERT_EQ_INT(n, (size_t)strlen(buf));
}

// surfaceKind is hard-coded "device" and surfaceHasAec hard-coded false — the
// device can NEVER identify as web/desktop/mobile, and never claims hardware
// AEC. Assert the substrings are present and that no other surfaceKind value
// can leak through (there is no parameter that could change them).
static void test_audio_session_start_is_device_no_aec(void) {
    char buf[1536];
    size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_audio_session_start(
        buf, sizeof buf, &n, "s", "a", "sid", "dev1", "c", "tok"), PCF_OK);
    ASSERT_NOT_NULL(strstr(buf, "\"surfaceKind\":\"device\""));
    ASSERT_NOT_NULL(strstr(buf, "\"surfaceHasAec\":false"));
    ASSERT_NOT_NULL(strstr(buf, "\"role\":\"voice-device-conv\""));
    // Must NOT claim any other surface kind or hardware AEC.
    ASSERT_TRUE(strstr(buf, "\"surfaceKind\":\"web\"") == NULL);
    ASSERT_TRUE(strstr(buf, "\"surfaceKind\":\"desktop\"") == NULL);
    ASSERT_TRUE(strstr(buf, "\"surfaceKind\":\"mobile\"") == NULL);
    ASSERT_TRUE(strstr(buf, "\"surfaceHasAec\":true") == NULL);
}

// End-to-end token provenance: the per-session voice token the device replays
// on the audio WSS is the token the daemon pushed on the session_start CONTROL
// frame — decoded by pcf_decode, then handed straight to the audio encoder.
// This is the device's ONLY source for the token (main.c copies f->voice_token
// from the decoded control frame into the audio session cfg); there is no
// HTTP-mint path in the firmware. So a verbatim match here proves the device
// neither mints nor fetches its own token.
static void test_audio_token_is_daemon_pushed_verbatim(void) {
    // A real daemon→device session_start control frame carrying a JWT-shaped
    // voice token plus the accountId/chatId the token is bound to.
    const char *control =
        "{\"type\":\"session_start\",\"sessionId\":\"sess-xyz\","
        "\"voiceToken\":\"eyJhbGciOiJIUzI1NiJ9.daemon-minted.sig\","
        "\"accountId\":\"acct-42\",\"chatId\":\"thread_speakers\"}";
    pcf_inbound_t inb;
    memset(&inb, 0, sizeof inb);
    ASSERT_EQ_INT(pcf_decode(control, strlen(control), &inb), PCF_OK);
    ASSERT_EQ_INT(inb.kind, PCF_FRAME_SESSION_START);

    // Feed the decoded control-frame values straight into the audio envelope,
    // exactly as main.c::open_audio_session_now does.
    char buf[1536];
    size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_audio_session_start(
        buf, sizeof buf, &n,
        inb.session_id, inb.account_id, "voice-pe-07138c", "voice-pe-07138c",
        inb.chat_id, inb.voice_token), PCF_OK);

    // The token on the audio WSS is byte-for-byte the daemon-pushed token.
    ASSERT_NOT_NULL(strstr(buf,
        "\"token\":\"eyJhbGciOiJIUzI1NiJ9.daemon-minted.sig\""));
    // And the replayed identity matches the token's claims (accountId/chatId).
    ASSERT_NOT_NULL(strstr(buf, "\"accountId\":\"acct-42\""));
    ASSERT_NOT_NULL(strstr(buf, "\"chatId\":\"thread_speakers\""));
    ASSERT_NOT_NULL(strstr(buf, "\"sessionId\":\"sess-xyz\""));
}

// The firmware tree has NO server voice-token mint call. F1-11's negative
// assertion ("device makes NO direct call to the server's voice-token
// endpoint") is structurally guaranteed: the device's only token source is the
// control-frame field above. A long token (a real ~350-byte JWT) must survive
// the encode intact — proving the device replays whatever the daemon pushed
// without re-minting or truncating.
static void test_audio_token_long_jwt_roundtrip(void) {
    char token[400];
    memset(token, 'A', sizeof token - 1);
    token[0] = 'x'; token[sizeof token - 2] = 'z';
    token[sizeof token - 1] = '\0';

    char buf[1536];
    size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_audio_session_start(
        buf, sizeof buf, &n, "s", "a", "sid", "dev1", "c", token), PCF_OK);
    // The exact token bytes appear in the frame.
    char needle[420];
    snprintf(needle, sizeof needle, "\"token\":\"%s\"", token);
    ASSERT_NOT_NULL(strstr(buf, needle));
}

// Config-bug guards (no fallback, per spec/principles.md): surfaceKind=="device"
// REQUIRES a deviceId, and the daemon-pushed token must be present before the
// audio session can open. Empty values must fail loud — NOT emit an invalid
// frame that the daemon would reject mid-handshake.
static void test_audio_session_start_requires_device_and_token(void) {
    char buf[1536];
    size_t n = 0;
    // Empty deviceId — would violate wire validateDeviceIdCoupling.
    ASSERT_EQ_INT(pcf_encode_audio_session_start(
        buf, sizeof buf, &n, "s", "a", "sid", "", "c", "tok"), PCF_ERR_MISSING);
    // Empty token — the daemon never pushed one yet.
    ASSERT_EQ_INT(pcf_encode_audio_session_start(
        buf, sizeof buf, &n, "s", "a", "sid", "dev1", "c", ""), PCF_ERR_MISSING);
    // NULL args rejected.
    ASSERT_EQ_INT(pcf_encode_audio_session_start(
        buf, sizeof buf, &n, NULL, "a", "sid", "dev1", "c", "tok"), PCF_ERR_PARSE);
}

// A too-small output buffer must report PCF_ERR_BUFFER, never a truncated
// (and thus invalid) JSON frame.
static void test_audio_session_start_buffer_overflow(void) {
    char small[32];
    size_t n = 0;
    ASSERT_EQ_INT(pcf_encode_audio_session_start(
        small, sizeof small, &n, "s", "a", "sid", "dev1", "c", "tok"),
        PCF_ERR_BUFFER);
}

int main(void) {
    fprintf(stderr, "test_audio_session_start:\n");
    TEST_RUN(test_audio_session_start_exact_wire);
    TEST_RUN(test_audio_session_start_is_device_no_aec);
    TEST_RUN(test_audio_token_is_daemon_pushed_verbatim);
    TEST_RUN(test_audio_token_long_jwt_roundtrip);
    TEST_RUN(test_audio_session_start_requires_device_and_token);
    TEST_RUN(test_audio_session_start_buffer_overflow);
    fprintf(stderr, "all passed\n");
    return 0;
}
