#include "patch_device_state.h"
#include "test_helpers.h"

static void test_starts_disconnected(void) {
    pds_t s; pds_init(&s);
    ASSERT_EQ_INT(s.state, PDS_STATE_DISCONNECTED);
}

static void test_link_up_to_idle(void) {
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    ASSERT_EQ_INT(s.state, PDS_STATE_IDLE);
}

static void test_full_session_lifecycle(void) {
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_WAKE_FIRED);
    ASSERT_EQ_INT(s.state, PDS_STATE_WAKE_DETECTED);
    pds_dispatch(&s, PDS_EV_AUDIO_SESSION_OPENED);
    ASSERT_EQ_INT(s.state, PDS_STATE_LISTENING);
    pds_dispatch(&s, PDS_EV_TTS_STARTED);
    ASSERT_EQ_INT(s.state, PDS_STATE_AGENT_SPEAKING);
    pds_dispatch(&s, PDS_EV_TTS_ENDED);
    ASSERT_EQ_INT(s.state, PDS_STATE_LISTENING);
    pds_dispatch(&s, PDS_EV_AUDIO_SESSION_CLOSED);
    ASSERT_EQ_INT(s.state, PDS_STATE_IDLE);
}

static void test_mute_overrides_everything(void) {
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_AUDIO_SESSION_OPENED);
    pds_dispatch(&s, PDS_EV_TTS_STARTED);
    ASSERT_EQ_INT(s.state, PDS_STATE_AGENT_SPEAKING);
    pds_dispatch(&s, PDS_EV_MUTE_ON);
    ASSERT_EQ_INT(s.state, PDS_STATE_MUTED);
    ASSERT_FALSE(s.session_open);   // mute drops session per spec §Mute
    ASSERT_FALSE(s.agent_speaking);
    ASSERT_FALSE(s.ringing);
    pds_dispatch(&s, PDS_EV_MUTE_OFF);
    ASSERT_EQ_INT(s.state, PDS_STATE_IDLE);
}

static void test_disconnect_overrides_idle(void) {
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_LINK_DOWN);
    ASSERT_EQ_INT(s.state, PDS_STATE_DISCONNECTED);
}

static void test_disconnect_during_session(void) {
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_AUDIO_SESSION_OPENED);
    pds_dispatch(&s, PDS_EV_LINK_DOWN);
    ASSERT_EQ_INT(s.state, PDS_STATE_DISCONNECTED);
    ASSERT_FALSE(s.session_open);
}

static void test_ringing(void) {
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_RING_RECEIVED);
    ASSERT_EQ_INT(s.state, PDS_STATE_RINGING);
    pds_dispatch(&s, PDS_EV_RING_ACCEPTED);
    ASSERT_EQ_INT(s.state, PDS_STATE_IDLE);
}

static void test_ring_while_muted_ignored(void) {
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_MUTE_ON);
    pds_dispatch(&s, PDS_EV_RING_RECEIVED);
    ASSERT_EQ_INT(s.state, PDS_STATE_MUTED);
    ASSERT_FALSE(s.ringing);
}

static void test_wake_ignored_when_muted_or_disconnected(void) {
    pds_t s; pds_init(&s);
    // Disconnected.
    pds_dispatch(&s, PDS_EV_WAKE_FIRED);
    ASSERT_EQ_INT(s.state, PDS_STATE_DISCONNECTED);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_MUTE_ON);
    pds_dispatch(&s, PDS_EV_WAKE_FIRED);
    ASSERT_EQ_INT(s.state, PDS_STATE_MUTED);
}

static void test_wake_during_ring_does_not_override(void) {
    // A wake firing while the device is RINGING must NOT paint a transient
    // wake-detected state over the active ring — ring has priority.
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_RING_RECEIVED);
    ASSERT_EQ_INT(s.state, PDS_STATE_RINGING);
    ASSERT_TRUE(s.ringing);
    pds_dispatch(&s, PDS_EV_WAKE_FIRED);
    ASSERT_EQ_INT(s.state, PDS_STATE_RINGING);
    ASSERT_TRUE(s.ringing);
}

static void test_wake_during_session_does_not_override(void) {
    // A wake firing while an audio session is open keeps the listening state.
    pds_t s; pds_init(&s);
    pds_dispatch(&s, PDS_EV_LINK_UP);
    pds_dispatch(&s, PDS_EV_AUDIO_SESSION_OPENED);
    ASSERT_EQ_INT(s.state, PDS_STATE_LISTENING);
    pds_dispatch(&s, PDS_EV_WAKE_FIRED);
    ASSERT_EQ_INT(s.state, PDS_STATE_LISTENING);
}

int main(void) {
    fprintf(stderr, "test_device_state\n");
    TEST_RUN(test_starts_disconnected);
    TEST_RUN(test_link_up_to_idle);
    TEST_RUN(test_full_session_lifecycle);
    TEST_RUN(test_mute_overrides_everything);
    TEST_RUN(test_disconnect_overrides_idle);
    TEST_RUN(test_disconnect_during_session);
    TEST_RUN(test_ringing);
    TEST_RUN(test_ring_while_muted_ignored);
    TEST_RUN(test_wake_ignored_when_muted_or_disconnected);
    TEST_RUN(test_wake_during_ring_does_not_override);
    TEST_RUN(test_wake_during_session_does_not_override);
    return 0;
}
