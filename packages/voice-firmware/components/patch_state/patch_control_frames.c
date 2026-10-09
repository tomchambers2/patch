// patch_control_frames — JSON encode/decode for control WSS frames.
//
// Hand-rolled to keep the binary small and to avoid pulling cJSON into the
// host-test build. JSON output is canonical and ASCII-safe (no embedded
// non-ASCII control bytes); strings from this device are short and known.

#include "patch_control_frames.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ---------- writer ---------------------------------------------------------

typedef struct {
    char *buf;
    size_t cap;
    size_t len;
    bool overflow;
} pcf_writer_t;

static void w_init(pcf_writer_t *w, char *buf, size_t cap) {
    w->buf = buf;
    w->cap = cap;
    w->len = 0;
    w->overflow = false;
}

static void w_putc(pcf_writer_t *w, char c) {
    if (w->len + 1 >= w->cap) { w->overflow = true; return; }
    w->buf[w->len++] = c;
}

static void w_puts(pcf_writer_t *w, const char *s) {
    while (*s) w_putc(w, *s++);
}

// JSON-escape a string and write it surrounded by quotes.
static void w_quote(pcf_writer_t *w, const char *s) {
    w_putc(w, '"');
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        switch (c) {
            case '"':  w_puts(w, "\\\""); break;
            case '\\': w_puts(w, "\\\\"); break;
            case '\b': w_puts(w, "\\b"); break;
            case '\f': w_puts(w, "\\f"); break;
            case '\n': w_puts(w, "\\n"); break;
            case '\r': w_puts(w, "\\r"); break;
            case '\t': w_puts(w, "\\t"); break;
            default:
                if (c < 0x20) {
                    char esc[8];
                    snprintf(esc, sizeof esc, "\\u%04x", c);
                    w_puts(w, esc);
                } else {
                    w_putc(w, (char)c);
                }
        }
    }
    w_putc(w, '"');
}

static pcf_status_t w_finish(pcf_writer_t *w, size_t *written) {
    if (w->overflow) return PCF_ERR_BUFFER;
    if (w->len >= w->cap) return PCF_ERR_BUFFER;
    w->buf[w->len] = '\0';
    if (written) *written = w->len;
    return PCF_OK;
}

// ---------- encoders -------------------------------------------------------

pcf_status_t pcf_encode_hello(char *out, size_t out_cap, size_t *written,
                              const char *device_id, const char *fw_version,
                              bool muted) {
    if (!out || !device_id || !fw_version) return PCF_ERR_PARSE;
    pcf_writer_t w; w_init(&w, out, out_cap);
    w_puts(&w, "{\"type\":\"hello\",\"deviceId\":");
    w_quote(&w, device_id);
    w_puts(&w, ",\"fwVersion\":");
    w_quote(&w, fw_version);
    w_puts(&w, ",\"muted\":");
    w_puts(&w, muted ? "true" : "false");
    w_putc(&w, '}');
    return w_finish(&w, written);
}

pcf_status_t pcf_encode_wake_detected(char *out, size_t out_cap, size_t *written) {
    if (!out) return PCF_ERR_PARSE;
    pcf_writer_t w; w_init(&w, out, out_cap);
    w_puts(&w, "{\"type\":\"wake_detected\"}");
    return w_finish(&w, written);
}

const char *pcf_session_end_reason_str(pcf_session_end_reason_t r) {
    switch (r) {
        case PCF_SESSION_END_VAD_TIMEOUT:    return "vad-timeout";
        case PCF_SESSION_END_USER_BUTTON:    return "user-button";
        case PCF_SESSION_END_AGENT_FINISHED: return "agent-finished";
    }
    // No fallback per spec/principles.md — caller must pass a valid enum.
    return NULL;
}

pcf_status_t pcf_encode_session_end(char *out, size_t out_cap, size_t *written,
                                    pcf_session_end_reason_t reason) {
    const char *r = pcf_session_end_reason_str(reason);
    if (!r) return PCF_ERR_TYPE;
    pcf_writer_t w; w_init(&w, out, out_cap);
    w_puts(&w, "{\"type\":\"session_end\",\"reason\":");
    w_quote(&w, r);
    w_putc(&w, '}');
    return w_finish(&w, written);
}

pcf_status_t pcf_encode_ring_accepted(char *out, size_t out_cap, size_t *written) {
    pcf_writer_t w; w_init(&w, out, out_cap);
    w_puts(&w, "{\"type\":\"ring_accepted\"}");
    return w_finish(&w, written);
}

pcf_status_t pcf_encode_ring_dismissed(char *out, size_t out_cap, size_t *written) {
    pcf_writer_t w; w_init(&w, out, out_cap);
    w_puts(&w, "{\"type\":\"ring_dismissed\"}");
    return w_finish(&w, written);
}

pcf_status_t pcf_encode_mute_changed(char *out, size_t out_cap, size_t *written,
                                     bool muted) {
    pcf_writer_t w; w_init(&w, out, out_cap);
    w_puts(&w, "{\"type\":\"mute_changed\",\"muted\":");
    w_puts(&w, muted ? "true" : "false");
    w_putc(&w, '}');
    return w_finish(&w, written);
}

pcf_status_t pcf_encode_audio_session_start(char *out, size_t out_cap,
                                            size_t *written,
                                            const char *session_id,
                                            const char *account_id,
                                            const char *surface_id,
                                            const char *device_id,
                                            const char *chat_id,
                                            const char *voice_token) {
    if (!out || !session_id || !account_id || !surface_id || !device_id ||
        !chat_id || !voice_token) {
        return PCF_ERR_PARSE;
    }
    // surfaceKind=="device" REQUIRES a non-empty deviceId (wire
    // validateDeviceIdCoupling) and the daemon-pushed token must be present
    // before we can open the audio session. Both empty values are config bugs,
    // not runtime-skippable — fail loud rather than emit an invalid frame.
    if (device_id[0] == '\0' || voice_token[0] == '\0') return PCF_ERR_MISSING;

    pcf_writer_t w; w_init(&w, out, out_cap);
    w_puts(&w, "{\"type\":\"audio.session_start\",\"sessionId\":");
    w_quote(&w, session_id);
    w_puts(&w, ",\"accountId\":");
    w_quote(&w, account_id);
    w_puts(&w, ",\"surfaceId\":");
    w_quote(&w, surface_id);
    // surfaceKind is ALWAYS "device" for this firmware — never web/desktop/
    // mobile. The token is the daemon-pushed voice token, replayed verbatim;
    // the device never mints it. surfaceHasAec is ALWAYS false (no hardware
    // AEC — the daemon runs AEC3 for device sessions).
    w_puts(&w, ",\"surfaceKind\":\"device\",\"deviceId\":");
    w_quote(&w, device_id);
    w_puts(&w, ",\"chatId\":");
    w_quote(&w, chat_id);
    w_puts(&w, ",\"role\":\"voice-device-conv\",\"token\":");
    w_quote(&w, voice_token);
    w_puts(&w, ",\"surfaceHasAec\":false}");
    return w_finish(&w, written);
}

// ---------- decoder --------------------------------------------------------
//
// Tiny JSON parser sufficient for the daemon→device frame shapes we accept.
// Handles whitespace, top-level object, string/bool/object values. Numbers and
// arrays not needed today and are rejected as PCF_ERR_PARSE.

typedef struct {
    const char *p;
    const char *end;
} pcf_reader_t;

static void r_skip_ws(pcf_reader_t *r) {
    while (r->p < r->end) {
        char c = *r->p;
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') r->p++;
        else break;
    }
}

static bool r_match(pcf_reader_t *r, char c) {
    r_skip_ws(r);
    if (r->p < r->end && *r->p == c) { r->p++; return true; }
    return false;
}

// Read a JSON string into out (NUL-terminated), capped at out_cap-1 bytes.
// Returns false on malformed input.
static bool r_string(pcf_reader_t *r, char *out, size_t out_cap) {
    r_skip_ws(r);
    if (r->p >= r->end || *r->p != '"') return false;
    r->p++;
    size_t i = 0;
    while (r->p < r->end) {
        char c = *r->p++;
        if (c == '"') {
            if (i >= out_cap) return false;
            out[i] = '\0';
            return true;
        }
        if (c == '\\') {
            if (r->p >= r->end) return false;
            char esc = *r->p++;
            char decoded;
            switch (esc) {
                case '"':  decoded = '"';  break;
                case '\\': decoded = '\\'; break;
                case '/':  decoded = '/';  break;
                case 'b':  decoded = '\b'; break;
                case 'f':  decoded = '\f'; break;
                case 'n':  decoded = '\n'; break;
                case 'r':  decoded = '\r'; break;
                case 't':  decoded = '\t'; break;
                case 'u': {
                    // Tolerate \uXXXX by mapping to '?' for non-ASCII; we never
                    // emit non-ASCII to the device anyway. NO FALLBACK on
                    // structural errors though.
                    if (r->end - r->p < 4) return false;
                    unsigned v = 0;
                    for (int k = 0; k < 4; k++) {
                        char h = *r->p++;
                        v <<= 4;
                        if (h >= '0' && h <= '9') v |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') v |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') v |= (unsigned)(h - 'A' + 10);
                        else return false;
                    }
                    decoded = (v < 0x80) ? (char)v : '?';
                    break;
                }
                default: return false;
            }
            if (i + 1 >= out_cap) return false;
            out[i++] = decoded;
            continue;
        }
        if (i + 1 >= out_cap) return false;
        out[i++] = c;
    }
    return false;
}

// Skip a value (string, bool, null, number). Used to ignore unknown keys.
// Returns false on malformed.
static bool r_skip_value(pcf_reader_t *r) {
    r_skip_ws(r);
    if (r->p >= r->end) return false;
    char c = *r->p;
    if (c == '"') {
        char tmp[PCF_MESSAGE_MAX];
        return r_string(r, tmp, sizeof tmp);
    }
    if (c == 't' && r->end - r->p >= 4 && memcmp(r->p, "true", 4) == 0) {
        r->p += 4; return true;
    }
    if (c == 'f' && r->end - r->p >= 5 && memcmp(r->p, "false", 5) == 0) {
        r->p += 5; return true;
    }
    if (c == 'n' && r->end - r->p >= 4 && memcmp(r->p, "null", 4) == 0) {
        r->p += 4; return true;
    }
    if (c == '-' || (c >= '0' && c <= '9')) {
        // Validate a strict JSON number (RFC 8259):
        //   -? ( 0 | [1-9][0-9]* ) ( . [0-9]+ )? ( [eE] [+-]? [0-9]+ )?
        // We must NOT swallow any contiguous [0-9+-.eE] run — a malformed
        // number (e.g. "--1.2e+-3") in an ignored key is a corrupt frame and
        // must produce PCF_ERR_PARSE, not be silently accepted (NO FALLBACKS).
        if (*r->p == '-') r->p++;
        // int part
        if (r->p >= r->end) return false;
        if (*r->p == '0') {
            r->p++;
        } else if (*r->p >= '1' && *r->p <= '9') {
            while (r->p < r->end && *r->p >= '0' && *r->p <= '9') r->p++;
        } else {
            return false;  // no digit after sign / leading-zero violation
        }
        // frac part
        if (r->p < r->end && *r->p == '.') {
            r->p++;
            if (r->p >= r->end || *r->p < '0' || *r->p > '9') return false;
            while (r->p < r->end && *r->p >= '0' && *r->p <= '9') r->p++;
        }
        // exp part
        if (r->p < r->end && (*r->p == 'e' || *r->p == 'E')) {
            r->p++;
            if (r->p < r->end && (*r->p == '+' || *r->p == '-')) r->p++;
            if (r->p >= r->end || *r->p < '0' || *r->p > '9') return false;
            while (r->p < r->end && *r->p >= '0' && *r->p <= '9') r->p++;
        }
        return true;
    }
    if (c == '{') {
        r->p++;
        if (r_match(r, '}')) return true;
        for (;;) {
            char tmp[64];
            if (!r_string(r, tmp, sizeof tmp)) return false;
            if (!r_match(r, ':')) return false;
            if (!r_skip_value(r)) return false;
            if (r_match(r, ',')) continue;
            return r_match(r, '}');
        }
    }
    if (c == '[') {
        r->p++;
        if (r_match(r, ']')) return true;
        for (;;) {
            if (!r_skip_value(r)) return false;
            if (r_match(r, ',')) continue;
            return r_match(r, ']');
        }
    }
    return false;
}

static bool r_bool(pcf_reader_t *r, bool *out) {
    r_skip_ws(r);
    if (r->end - r->p >= 4 && memcmp(r->p, "true", 4) == 0) {
        r->p += 4; *out = true; return true;
    }
    if (r->end - r->p >= 5 && memcmp(r->p, "false", 5) == 0) {
        r->p += 5; *out = false; return true;
    }
    return false;
}

pcf_status_t pcf_decode(const char *json, size_t len, pcf_inbound_t *out) {
    if (!json || !out) return PCF_ERR_PARSE;
    memset(out, 0, sizeof *out);
    pcf_reader_t r = { json, json + len };

    if (!r_match(&r, '{')) return PCF_ERR_PARSE;

    char type[32] = {0};
    bool have_type = false;
    char chat_id[PCF_CHAT_ID_MAX] = {0};
    char account_id[PCF_ACCOUNT_ID_MAX] = {0};
    char session_id[PCF_SESSION_ID_MAX] = {0};
    char voice_token[PCF_VOICE_TOKEN_MAX] = {0};
    char message[PCF_MESSAGE_MAX] = {0};
    char led_state[32] = {0};
    char err_message[PCF_MESSAGE_MAX] = {0};
    bool conversational = false;
    bool have_conv = false;
    bool have_chat = false;
    bool have_account = false;
    bool have_session = false;
    bool have_voice_token = false;
    bool have_message = false;
    bool have_led = false;
    bool have_err_msg = false;
    bool have_code = false;
    bool have_err_field = false;

    if (!r_match(&r, '}')) {
        for (;;) {
            char key[32];
            if (!r_string(&r, key, sizeof key)) return PCF_ERR_PARSE;
            if (!r_match(&r, ':')) return PCF_ERR_PARSE;
            r_skip_ws(&r);
            // NO FALLBACKS: a duplicate top-level key is ambiguous (e.g. two
            // "type" values) and must NOT silently resolve to whichever came
            // last. Reject any repeated recognised key with PCF_ERR_PARSE.
            // (The flags below double as "already seen" markers; `code` is
            // tracked by have_code so a duplicate code is caught even though it
            // shares storage with the message/errorMessage fields.)
            if (strcmp(key, "type") == 0) {
                if (have_type) return PCF_ERR_PARSE;
                if (!r_string(&r, type, sizeof type)) return PCF_ERR_PARSE;
                have_type = true;
            } else if (strcmp(key, "sessionId") == 0) {
                if (have_session) return PCF_ERR_PARSE;
                if (!r_string(&r, session_id, sizeof session_id)) return PCF_ERR_PARSE;
                have_session = true;
            } else if (strcmp(key, "voiceToken") == 0) {
                if (have_voice_token) return PCF_ERR_PARSE;
                if (!r_string(&r, voice_token, sizeof voice_token)) return PCF_ERR_PARSE;
                have_voice_token = true;
            } else if (strcmp(key, "chatId") == 0) {
                if (have_chat) return PCF_ERR_PARSE;
                if (!r_string(&r, chat_id, sizeof chat_id)) return PCF_ERR_PARSE;
                have_chat = true;
            } else if (strcmp(key, "accountId") == 0) {
                if (have_account) return PCF_ERR_PARSE;
                if (!r_string(&r, account_id, sizeof account_id)) return PCF_ERR_PARSE;
                have_account = true;
            } else if (strcmp(key, "message") == 0) {
                if (have_message) return PCF_ERR_PARSE;
                if (!r_string(&r, message, sizeof message)) return PCF_ERR_PARSE;
                have_message = true;
            } else if (strcmp(key, "conversational") == 0) {
                if (have_conv) return PCF_ERR_PARSE;
                if (!r_bool(&r, &conversational)) return PCF_ERR_PARSE;
                have_conv = true;
            } else if (strcmp(key, "state") == 0) {
                if (have_led) return PCF_ERR_PARSE;
                if (!r_string(&r, led_state, sizeof led_state)) return PCF_ERR_PARSE;
                have_led = true;
            } else if (strcmp(key, "code") == 0) {
                if (have_code) return PCF_ERR_PARSE;
                have_code = true;
                // error frame's `code` — store into err_message prefix.
                char tmp[64];
                if (!r_string(&r, tmp, sizeof tmp)) return PCF_ERR_PARSE;
                if (!have_err_msg) {
                    snprintf(err_message, sizeof err_message, "%s", tmp);
                    have_err_msg = true;
                }
            } else if (strcmp(key, "errorMessage") == 0 || strcmp(key, "msg") == 0) {
                if (have_err_field) return PCF_ERR_PARSE;
                have_err_field = true;
                if (!r_string(&r, err_message, sizeof err_message)) return PCF_ERR_PARSE;
                have_err_msg = true;
            } else {
                if (!r_skip_value(&r)) return PCF_ERR_PARSE;
            }
            if (r_match(&r, ',')) continue;
            if (r_match(&r, '}')) break;
            return PCF_ERR_PARSE;
        }
    }

    // NO FALLBACKS: nothing but whitespace may follow the top-level object.
    // A frame with trailing non-whitespace bytes (e.g. a truncated/concatenated
    // or corrupt frame, "...}garbage") must be rejected, not silently accepted
    // by stopping at the first closing brace.
    r_skip_ws(&r);
    if (r.p != r.end) return PCF_ERR_PARSE;

    if (!have_type) return PCF_ERR_MISSING;

    if (strcmp(type, "session_start") == 0) {
        // Both fields are mandatory: the daemon mints the per-session voice
        // token and pushes it here so the device never calls the server's
        // token endpoint itself (spec/16 §Wire protocol "Voice-token
        // delivery"). No fallback — a session_start without a token is a
        // protocol error, not an empty-token session.
        // accountId + chatId are mandatory too: the device declares them on
        // audio.session_start to match the token's claims (the daemon sends
        // both so the device never decodes the token). No fallback.
        if (!have_session || !have_voice_token || !have_account || !have_chat)
            return PCF_ERR_MISSING;
        // No fallback — a present-but-empty required field is just as much a
        // protocol error as a missing one (it would open the audio WSS with an
        // empty token / wrong identity, which the daemon rejects). This is
        // symmetric with pcf_encode_audio_session_start, which rejects an empty
        // token/deviceId with PCF_ERR_MISSING.
        if (session_id[0] == '\0' || voice_token[0] == '\0' ||
            account_id[0] == '\0' || chat_id[0] == '\0')
            return PCF_ERR_MISSING;
        out->kind = PCF_FRAME_SESSION_START;
        snprintf(out->session_id, sizeof out->session_id, "%s", session_id);
        snprintf(out->voice_token, sizeof out->voice_token, "%s", voice_token);
        snprintf(out->account_id, sizeof out->account_id, "%s", account_id);
        snprintf(out->chat_id, sizeof out->chat_id, "%s", chat_id);
        return PCF_OK;
    }
    if (strcmp(type, "ring") == 0) {
        if (!have_chat || !have_conv) return PCF_ERR_MISSING;
        out->kind = PCF_FRAME_RING;
        snprintf(out->chat_id, sizeof out->chat_id, "%s", chat_id);
        out->conversational = conversational;
        if (have_message) {
            snprintf(out->message, sizeof out->message, "%s", message);
            out->has_message = true;
        }
        return PCF_OK;
    }
    if (strcmp(type, "led") == 0) {
        if (!have_led) return PCF_ERR_MISSING;
        out->kind = PCF_FRAME_LED;
        if (strcmp(led_state, "idle") == 0)            out->led_hint = PCF_LED_IDLE;
        else if (strcmp(led_state, "listening") == 0)  out->led_hint = PCF_LED_LISTENING;
        else if (strcmp(led_state, "agent-speaking") == 0) out->led_hint = PCF_LED_AGENT_SPEAKING;
        else if (strcmp(led_state, "ringing") == 0)    out->led_hint = PCF_LED_RINGING;
        else return PCF_ERR_TYPE;
        return PCF_OK;
    }
    if (strcmp(type, "error") == 0) {
        out->kind = PCF_FRAME_ERROR;
        if (have_err_msg) snprintf(out->error_message, sizeof out->error_message, "%s", err_message);
        return PCF_OK;
    }
    out->kind = PCF_FRAME_UNKNOWN;
    return PCF_ERR_UNKNOWN_FRAME;
}
