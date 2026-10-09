// patch_device_state — master FSM. See header for state list.
//
// Mute is overriding: while muted we always render the muted LED pattern and
// drop any audio session that was open (the actual side-effects — closing the
// I2S DMA, halting microWakeWord — are the caller's job; this FSM only
// captures the *abstract* state).
//
// Disconnected (no control WSS) overrides everything except mute, since with
// no daemon there's no point pretending we can listen.

#include "patch_device_state.h"

#include <stddef.h>

static void recompute(pds_t *s) {
    if (s->muted) { s->state = PDS_STATE_MUTED; return; }
    if (!s->linked) { s->state = PDS_STATE_DISCONNECTED; return; }
    if (s->ringing) { s->state = PDS_STATE_RINGING; return; }
    if (s->session_open) {
        s->state = s->agent_speaking ? PDS_STATE_AGENT_SPEAKING : PDS_STATE_LISTENING;
        return;
    }
    s->state = PDS_STATE_IDLE;
}

void pds_init(pds_t *s) {
    if (!s) return;
    s->state = PDS_STATE_DISCONNECTED;
    s->muted = false;
    s->linked = false;
    s->ringing = false;
    s->session_open = false;
    s->agent_speaking = false;
}

void pds_dispatch(pds_t *s, pds_event_t ev) {
    if (!s) return;
    switch (ev) {
        case PDS_EV_LINK_UP:                  s->linked = true; break;
        case PDS_EV_LINK_DOWN:                s->linked = false; s->session_open = false; s->agent_speaking = false; s->ringing = false; break;
        case PDS_EV_MUTE_ON:                  s->muted = true; s->session_open = false; s->agent_speaking = false; s->ringing = false; break;
        case PDS_EV_MUTE_OFF:                 s->muted = false; break;
        case PDS_EV_WAKE_FIRED:
            // Transient single-pulse; transition to listening immediately
            // when the audio session opens. We render the wake pulse only
            // when nothing higher-priority is on screen. mute and
            // disconnected obviously suppress it, but so does an active ring:
            // ring > session priority is documented in recompute(), and a wake
            // firing mid-ring must NOT paint a transient wake-detected state
            // over the ring. An already-open session likewise keeps its
            // listening/speaking state. So we only show the wake pulse from a
            // resting idle state; otherwise fall through to recompute() which
            // preserves the current (higher-priority) state.
            if (!s->muted && s->linked && !s->ringing && !s->session_open) {
                s->state = PDS_STATE_WAKE_DETECTED;
                return;
            }
            break;
        case PDS_EV_AUDIO_SESSION_OPENED:     s->session_open = true; s->agent_speaking = false; break;
        case PDS_EV_AUDIO_SESSION_CLOSED:     s->session_open = false; s->agent_speaking = false; break;
        case PDS_EV_TTS_STARTED:              s->agent_speaking = true; break;
        case PDS_EV_TTS_ENDED:                s->agent_speaking = false; break;
        case PDS_EV_RING_RECEIVED:
            if (!s->muted && s->linked) s->ringing = true;
            break;
        case PDS_EV_RING_ACCEPTED:            s->ringing = false; break;
        case PDS_EV_RING_DISMISSED:           s->ringing = false; break;
        case PDS_EV_RING_TIMEOUT:             s->ringing = false; break;
    }
    recompute(s);
}

const char *pds_state_str(pds_state_t s) {
    switch (s) {
        case PDS_STATE_DISCONNECTED:    return "disconnected";
        case PDS_STATE_IDLE:            return "idle";
        case PDS_STATE_WAKE_DETECTED:   return "wake-detected";
        case PDS_STATE_LISTENING:       return "listening";
        case PDS_STATE_AGENT_SPEAKING:  return "agent-speaking";
        case PDS_STATE_RINGING:         return "ringing";
        case PDS_STATE_MUTED:           return "muted";
        case PDS_STATE_PAIRING_IN_PROGRESS: return "pairing-in-progress";
        case PDS_STATE_PAIRING_FAILED:  return "pairing-failed";
    }
    return NULL;
}
