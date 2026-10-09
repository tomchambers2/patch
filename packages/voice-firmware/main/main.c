// patch-voice-device firmware — entry point.
//
// Orchestrates the components defined in components/patch_*/. The runtime
// behaviour follows spec/16-voice-device.md §Firmware responsibilities:
//
//   1. microWakeWord runs whenever device is unmuted + linked.
//   2. Persistent control WSS to daemon (auto-reconnect).
//   3. Wake fires (or accepted ring) → open audio WSS, stream PCM16 mic up,
//      play PCM16 down.
//   4. LED ring renders pds_state_t.
//   5. Button: short-press = PTT / accept ring. Long-press = end session
//      / dismiss ring.
//   6. Mute switch cuts wake-word + audio session, notifies daemon.
//   7. Wi-Fi reconnect via esp_wifi auto-reconnect.
//   8. OTA poll once an hour.

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/timers.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "driver/usb_serial_jtag.h"

#include "patch_device_state.h"
#include "patch_ring_fsm.h"
#include "patch_boot_check.h"
#include "patch_led.h"
#include "patch_button.h"
#include "patch_audio.h"
#include "patch_codec.h"
#include "patch_wakeword.h"
#include "patch_control.h"
#include "patch_provision.h"
#include "patch_ota.h"

static const char *TAG = "patch-main";
#define FW_VERSION "0.1.0"

static patch_provision_state_t s_prov;
static pds_t s_state;
static prf_t s_ring;
static char s_active_session_id[64] = {0};
static char s_active_chat_id[128] = {0};
static char s_active_account_id[64] = {0};
static char s_voice_token[1024] = {0};

// Forward decls.
static void on_control_inbound(const pcf_inbound_t *frame, void *user);
static void on_control_link_up(void *user);
static void on_control_link_down(void *user);
static bool get_muted_cb(void *user);
static void on_button(pb_event_t ev, void *user);
static void on_wake_word(void *user);
static void on_tts_started(void *user);
static void on_tts_ended(void *user);
static void on_audio_session_closed(void *user);
static void render_state(void);

// ---------- Wi-Fi -----------------------------------------------------------
//
// Wi-Fi credentials come from wifi_provisioning_manager during first-boot
// provisioning and are stored in the `nvs.net80211` partition that
// esp_wifi reads automatically; on subsequent boots we just call
// esp_wifi_start() and `esp_wifi_connect()` and the auto-reconnect path
// handles drops.

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "wifi disconnected; reconnecting");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(TAG, "wifi got ip");
    }
}

// Bring up the netif + default event loop + the Wi-Fi driver itself. This MUST
// run before either branch (subsequent-boot STA connect OR first-boot BLE
// provisioning): wifi_prov_mgr_start_provisioning() internally calls
// esp_wifi_set_mode(STA) and aborts with ESP_ERR_WIFI_NOT_INIT if the driver
// was never esp_wifi_init()'d. Previously esp_wifi_init lived only inside
// wifi_init_sta() (subsequent-boot path), so the very first provisioning boot
// crash-looped. Init the stack once here; the two branches only start/connect.
static void net_stack_init(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL));
}

static void wifi_init_sta(void) {
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    // After BLE provisioning the prov manager may already have started the
    // driver; treat ESP_ERR_WIFI_* "already started/inited" as success rather
    // than aborting (the subsequent-boot path starts from a clean stop).
    esp_err_t se = esp_wifi_start();
    if (se != ESP_OK && se != ESP_ERR_WIFI_CONN) ESP_ERROR_CHECK(se);
    esp_err_t ce = esp_wifi_connect();
    if (ce != ESP_OK && ce != ESP_ERR_WIFI_CONN) ESP_ERROR_CHECK(ce);
}

// ---------- ring timer ------------------------------------------------------
//
// Ticks once a second to drive the 30 s ring timeout. We could pair this with
// any single-shot timer but keeping it in a periodic timer is simpler and the
// extra wake-ups are negligible.

// Worker that performs the ring-timeout dismiss off the FreeRTOS timer-service
// task. The timer task has a deliberately small stack
// (CONFIG_FREERTOS_TIMER_TASK_STACK_DEPTH=2048) and MUST NOT call into the
// websocket/TLS send path — doing so overflowed the timer task stack and
// reset the device (observed on the F1-10 30s no-answer path). The control
// send + state dispatch run here on an adequately sized stack instead.
static void ring_timeout_dismiss_task(void *arg) {
    (void)arg;
    ESP_LOGI(TAG, "ring 30s timeout; dismissing");
    patch_audio_ringtone_stop();
    patch_control_send_ring_dismissed();
    pds_dispatch(&s_state, PDS_EV_RING_TIMEOUT);
    render_state();
    vTaskDelete(NULL);
}

static void ring_tick_cb(TimerHandle_t t) {
    (void)t;
    int64_t now_ms = (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
    prf_out_t o = prf_tick(&s_ring, now_ms);
    if (o == PRF_OUT_RING_DISMISSED_TIMEOUT) {
        // Hand off to a task with a real stack — see comment above.
        xTaskCreate(ring_timeout_dismiss_task, "ring-dismiss", 4096, NULL, 5, NULL);
    }
}

// ---------- control link callbacks -----------------------------------------

static void on_control_link_up(void *user) {
    (void)user;
    pds_dispatch(&s_state, PDS_EV_LINK_UP);
    render_state();
}

static void on_control_link_down(void *user) {
    (void)user;
    pds_dispatch(&s_state, PDS_EV_LINK_DOWN);
    render_state();
    patch_audio_ringtone_stop();
    if (patch_audio_session_active()) patch_audio_session_stop("user-button");
}

static bool get_muted_cb(void *user) { (void)user; return patch_button_is_muted(); }

static void open_audio_session_now(void) {
    if (s_active_session_id[0] == '\0') return;
    patch_audio_session_cfg_t cfg = {
        .daemon_host = s_prov.daemon_host,
        .daemon_port = s_prov.daemon_port,
        .use_tls     = s_prov.tls,
        .session_id  = s_active_session_id,
        // accountId + chatId come from the daemon's session_start frame so the
        // audio.session_start identity matches the voice token's claims (the
        // daemon mints the token bound to {accountId, deviceId, chatId}). The
        // device declares exactly what the daemon told it — it never decodes
        // the token.
        .account_id  = s_active_account_id,
        .surface_id  = s_prov.device_id,
        .device_id   = s_prov.device_id, // surfaceKind=="device" coupling
        .chat_id     = s_active_chat_id,
        .voice_token = s_voice_token,
        .on_tts_started     = on_tts_started,
        .on_tts_ended       = on_tts_ended,
        .on_session_closed  = on_audio_session_closed,
    };
    patch_audio_session_start(&cfg);
    pds_dispatch(&s_state, PDS_EV_AUDIO_SESSION_OPENED);
    patch_wakeword_pause();
    render_state();
}

static void on_control_inbound(const pcf_inbound_t *f, void *user) {
    (void)user;
    switch (f->kind) {
        case PCF_FRAME_SESSION_START:
            // The daemon mints the per-session HMAC voice token and pushes it
            // in the session_start control frame (spec/16 §Wire protocol
            // "Voice-token delivery"); the device replays it as the
            // audio.session_start `token`. pcf_decode requires both fields, so
            // by here they are both present and non-empty — no fallback.
            snprintf(s_active_session_id, sizeof s_active_session_id, "%s", f->session_id);
            snprintf(s_voice_token, sizeof s_voice_token, "%s", f->voice_token);
            // accountId + chatId are carried on the session_start control frame
            // (the daemon minted the voice token bound to exactly these), so the
            // device replays them verbatim on audio.session_start — the audio
            // server rejects any mismatch with the token's claims. The
            // voice-device chat is the daemon's special speakers thread
            // (thread_speakers); the daemon, not the firmware, names it.
            snprintf(s_active_account_id, sizeof s_active_account_id, "%s", f->account_id);
            snprintf(s_active_chat_id, sizeof s_active_chat_id, "%s", f->chat_id);
            ESP_LOGI(TAG, "control: session_start sessionId=%s", s_active_session_id);
            open_audio_session_now();
            break;
        case PCF_FRAME_RING: {
            ESP_LOGI(TAG, "control: ring chatId=%s conv=%d", f->chat_id, (int)f->conversational);
            int64_t now_ms = (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
            prf_on_ring(&s_ring, now_ms);
            snprintf(s_active_chat_id, sizeof s_active_chat_id, "%s", f->chat_id);
            pds_dispatch(&s_state, PDS_EV_RING_RECEIVED);
            render_state();
            patch_audio_ringtone_start();  // make the ring audible, not LED-only
            break;
        }
        case PCF_FRAME_LED:
            // Optional UI hint per spec. Map to abstract state if it would
            // override normal local rendering — but our local FSM already
            // covers idle/listening/agent-speaking/ringing, so we treat the
            // hint as informational only (logged).
            ESP_LOGI(TAG, "control: led hint=%d", (int)f->led_hint);
            break;
        case PCF_FRAME_ERROR:
            ESP_LOGE(TAG, "control: error from daemon: %s", f->error_message);
            break;
        case PCF_FRAME_UNKNOWN:
            break;
    }
}

// ---------- audio callbacks -------------------------------------------------

static void on_tts_started(void *u) {
    (void)u;
    pds_dispatch(&s_state, PDS_EV_TTS_STARTED);
    render_state();
}
static void on_tts_ended(void *u) {
    (void)u;
    pds_dispatch(&s_state, PDS_EV_TTS_ENDED);
    render_state();
}
static void on_audio_session_closed(void *u) {
    (void)u;
    s_active_session_id[0] = '\0';
    pds_dispatch(&s_state, PDS_EV_AUDIO_SESSION_CLOSED);
    if (!patch_button_is_muted()) patch_wakeword_resume();
    render_state();
}

// ---------- wake word -------------------------------------------------------

static void on_wake_word(void *u) {
    (void)u;
    if (patch_button_is_muted() || !patch_control_is_linked()) return;
    pds_dispatch(&s_state, PDS_EV_WAKE_FIRED);
    render_state();
    patch_control_send_wake_detected();
    // The daemon responds with `session_start`; the audio WSS opens then.
}

// ---------- button + mute ---------------------------------------------------

static void on_button(pb_event_t ev, void *user) {
    (void)user;
    int64_t now_ms = (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
    switch (ev) {
        case PB_EV_SHORT_PRESS:
            if (s_state.state == PDS_STATE_RINGING) {
                if (prf_on_accept(&s_ring) == PRF_OUT_RING_ACCEPTED) {
                    patch_audio_ringtone_stop();  // silence the chime before the session opens
                    patch_control_send_ring_accepted();
                    pds_dispatch(&s_state, PDS_EV_RING_ACCEPTED);
                    render_state();
                }
            } else if (!patch_audio_session_active() && !patch_button_is_muted()
                       && patch_control_is_linked()) {
                // Push-to-talk: behaves like a wake-word fire.
                pds_dispatch(&s_state, PDS_EV_WAKE_FIRED);
                render_state();
                patch_control_send_wake_detected();
            }
            break;
        case PB_EV_LONG_PRESS:
            if (s_state.state == PDS_STATE_RINGING) {
                if (prf_on_dismiss(&s_ring) == PRF_OUT_RING_DISMISSED_USER) {
                    patch_audio_ringtone_stop();
                    patch_control_send_ring_dismissed();
                    pds_dispatch(&s_state, PDS_EV_RING_DISMISSED);
                    render_state();
                }
            } else if (patch_audio_session_active()) {
                patch_control_send_session_end(PCF_SESSION_END_USER_BUTTON);
                patch_audio_session_stop("user-button");
            }
            (void)now_ms;
            break;
        case PB_EV_MUTE_ON:
            ESP_LOGI(TAG, "mute switch ON");
            patch_audio_ringtone_stop();
            patch_wakeword_pause();
            if (patch_audio_session_active()) {
                patch_control_send_session_end(PCF_SESSION_END_USER_BUTTON);
                patch_audio_session_stop("user-button");
            }
            patch_control_send_mute_changed(true);
            pds_dispatch(&s_state, PDS_EV_MUTE_ON);
            render_state();
            break;
        case PB_EV_MUTE_OFF:
            ESP_LOGI(TAG, "mute switch OFF");
            patch_control_send_mute_changed(false);
            patch_wakeword_resume();
            pds_dispatch(&s_state, PDS_EV_MUTE_OFF);
            render_state();
            break;
        case PB_EV_LONG_LONG_PRESS:
            // Factory-reset gesture (10 s hold). The credential wipe + reboot
            // are owned by patch_button.c, which calls
            // patch_provision_factory_reset()/esp_restart() the moment the
            // gesture crosses its threshold — so by the time this event is
            // delivered the device is on its way down. Nothing to do here but
            // record it; no fallback, no second reset path.
            ESP_LOGW(TAG, "factory-reset gesture observed; device restarting");
            break;
    }
}

static void render_state(void) {
    patch_led_set(s_state.state);
    // Emit the LED-ring state over serial so the rendered indication is
    // observable on a headless bench (no camera on the ring). The string is
    // the same pds_state_t that drives the physical LED pattern table.
    ESP_LOGI(TAG, "led: %s", pds_state_str(s_state.state));
}

// ---------- serial bench-diagnostic console --------------------------------
//
// A tiny line reader over the USB-Serial-JTAG console so an unattended bench
// (no human at the device) can actuate the inputs that are otherwise physical
// gestures, to verify the REAL on-device firmware response. Commands:
//
//   mute on      -> drive the physical mute-switch line (GPIO3) LOW, as if the
//                   slider were moved to muted. Exercises the genuine poll-task
//                   PB_EV_MUTE_ON path on the flashed unit.
//   mute off     -> release the line back to the physical slider (PB_EV_MUTE_OFF).
//
// This is a test seam, gated to the serial console only; it does not affect
// normal (no-input) operation. It electrically drives the same input pin the
// firmware reads — it is not a host-FSM stub.

static void handle_diag_line(const char *line) {
    if (strcmp(line, "mute on") == 0) {
        ESP_LOGW(TAG, "diag: mute on");
        patch_button_force_mute_line(true);
    } else if (strcmp(line, "mute off") == 0) {
        ESP_LOGW(TAG, "diag: mute off");
        patch_button_force_mute_line(false);
    } else if (strcmp(line, "mute read") == 0) {
        ESP_LOGW(TAG, "diag: mute gpio level=%d is_muted=%d",
                 patch_button_read_mute_gpio(), (int)patch_button_is_muted());
    } else if (strcmp(line, "wake") == 0) {
        // Fake a wake-word hit: sends wake_detected on the control WS so the
        // daemon opens a voice session (same path the real wakeword uses). Lets
        // us drive end-to-end daemon TTS without speaking aloud.
        ESP_LOGW(TAG, "diag: forcing wake_detected");
        bool ok = patch_control_send_wake_detected();
        ESP_LOGW(TAG, "diag: wake_detected sent=%d", (int)ok);
    } else if (strcmp(line, "button down") == 0) {
        ESP_LOGW(TAG, "diag: button down");
        patch_button_force_press(1);
    } else if (strcmp(line, "button up") == 0) {
        ESP_LOGW(TAG, "diag: button up");
        patch_button_force_press(0);
    } else if (strcmp(line, "button release") == 0) {
        ESP_LOGW(TAG, "diag: button release-override");
        patch_button_force_press(-1);
    } else if (strcmp(line, "button read") == 0) {
        ESP_LOGW(TAG, "diag: button gpio level=%d (0==pressed)",
                 patch_button_read_button_gpio());
    } else if (strcmp(line, "button trace") == 0) {
        // Sample the raw action-button GPIO0 line for ~8s so an operator can
        // press the physical button and confirm the level actually drops on the
        // flashed unit (real-press readability check; no override involved).
        ESP_LOGW(TAG, "diag: button trace start (press the physical button now)");
        int last = -1;
        for (int i = 0; i < 800; ++i) {
            int lvl = patch_button_read_button_gpio();
            if (lvl != last) {
                ESP_LOGW(TAG, "diag: button gpio -> %d at %d ms", lvl, i * 10);
                last = lvl;
            }
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        ESP_LOGW(TAG, "diag: button trace end");
    } else if (strncmp(line, "tone", 4) == 0 && line[4] != 'c') {  // not "tonecap"
        // Local tone self-test (no daemon/session) for host-mic IMD measurement.
        //   "tone"               -> two-tone 300+3300 @ amp 6000
        //   "tone <amp>"         -> two-tone 300+3300 @ <amp>
        //   "tone <amp> <fa> <fb>" -> custom (fb=0 => single tone)
        int amp = 6000, fa = 300, fb = 3300;
        sscanf(line + 4, "%d %d %d", &amp, &fa, &fb);
        ESP_LOGW(TAG, "diag: tone amp=%d fa=%d fb=%d", amp, fa, fb);
        patch_audio_play_test_tone(fa, fb, amp, 3000);
    } else if (strncmp(line, "speech", 6) == 0 && line[6] != 'f') {
        // Local real-speech self-test. "speech" = native level; "speech <pct>"
        // scales amplitude (e.g. 200 = 2x, louder for a host-mic capture).
        int pct = 100;
        sscanf(line + 6, "%d", &pct);
        ESP_LOGW(TAG, "diag: speech (direct path, scale=%d%%)", pct);
        patch_audio_play_embedded_speech_scaled(pct);
    } else if (strncmp(line, "ptm", 3) == 0) {
        int v = 8;
        sscanf(line + 3, "%i", &v);   // %i parses 0x.. too
        ESP_LOGW(TAG, "diag: DAC PTM = 0x%02x", v);
        patch_codec_set_dac_ptm((uint8_t)v);
    } else if (strncmp(line, "dacvol", 6) == 0) {
        int hs = -36;                 // default boot level (-18 dB)
        sscanf(line + 6, "%d", &hs);
        ESP_LOGW(TAG, "diag: DAC vol = %d half-steps (%.1f dB)", hs, hs * 0.5);
        patch_codec_set_dac_vol(hs);
    } else if (strncmp(line, "amp", 3) == 0) {
        int on = 0;
        sscanf(line + 3, "%d", &on);
        ESP_LOGW(TAG, "diag: speaker amp -> %s", on ? "ON" : "OFF");
        patch_codec_amp_enable(on != 0);
    } else if (strncmp(line, "tonecap", 7) == 0) {
        // Close-field two-tone capture for objective IMD measurement.
        int f1 = 300, f2 = 3300;
        sscanf(line + 7, "%d %d", &f1, &f2);
        ESP_LOGW(TAG, "diag: tonecap %d+%d", f1, f2);
        patch_audio_miccap_tone_f1 = f1;
        patch_audio_miccap_tone_f2 = f2;
        patch_audio_miccap(100);
        patch_audio_miccap_tone_f1 = 0;
        patch_audio_miccap_tone_f2 = 0;
    } else if (strncmp(line, "miccap", 6) == 0) {
        int pct = 200;
        sscanf(line + 6, "%d", &pct);
        ESP_LOGW(TAG, "diag: miccap scale=%d%%", pct);
        patch_audio_miccap(pct);
    } else if (strcmp(line, "speechfeed") == 0) {
        // Same clip via the feeder/stream-buffer path (daemon-TTS path) for A/B.
        ESP_LOGW(TAG, "diag: speechfeed (embedded, FEEDER path)");
        patch_audio_play_embedded_speech_via_feeder();
    } else if (strncmp(line, "xmos", 4) == 0) {
        // Live A/B of XMOS mic-pipeline stages (0=NONE 1=AEC 2=IC 3=NS 4=AGC).
        // "xmos <ch0> <ch1>" — to test whether XMOS DSP processing causes the
        // playback IMD (set both to 0=NONE and re-measure the two-tone).
        int a = 0, b = 0;
        sscanf(line + 4, "%d %d", &a, &b);
        ESP_LOGW(TAG, "diag: xmos pipeline ch0=%d ch1=%d -> %d", a, b,
                 (int)patch_codec_set_xmos_pipeline(a, b));
    } else if (line[0] != '\0') {
        ESP_LOGW(TAG, "diag: unknown command '%s' "
                      "(try: mute on|off|read, button down|up|release, tone, xmos)", line);
    }
}

static void diag_console_task(void *arg) {
    (void)arg;
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    if (usb_serial_jtag_driver_install(&cfg) != ESP_OK) {
        ESP_LOGW(TAG, "diag console unavailable (driver install failed)");
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "diag console ready (commands: 'mute on', 'mute off')");
    char buf[64];
    size_t len = 0;
    for (;;) {
        uint8_t c;
        int n = usb_serial_jtag_read_bytes(&c, 1, pdMS_TO_TICKS(200));
        if (n <= 0) continue;
        if (c == '\r' || c == '\n') {
            if (len > 0) {
                buf[len] = '\0';
                handle_diag_line(buf);
                len = 0;
            }
        } else if (len < sizeof(buf) - 1) {
            buf[len++] = (char)c;
        } else {
            len = 0; // overflow — drop the line
        }
    }
}

void app_main(void) {
    printf("patch voice-device boot, fw=%s\n", FW_VERSION);

    // Fail-loud Kconfig validation per spec/principles.md. A fresh checkout
    // ships with PATCH_SERVER_URL = "https://patch.example.com" — booting
    // with the placeholder produces a confusing DNS failure that looks
    // like a Wi-Fi problem. Reject it here before any network code runs.
    patch_boot_check_result_t bcr = patch_boot_check_server_url(CONFIG_PATCH_SERVER_URL);
    if (bcr != PATCH_BOOT_CHECK_OK) {
        if (bcr == PATCH_BOOT_CHECK_PLACEHOLDER) {
            ESP_LOGE(TAG, "PATCH_SERVER_URL is the placeholder '%s'; "
                          "configure via 'idf.py menuconfig' -> 'Patch voice device' "
                          "-> 'Patch server base URL'. Restarting in 5s.",
                     PATCH_BOOT_CHECK_PLACEHOLDER_URL);
        } else {
            ESP_LOGE(TAG, "PATCH_SERVER_URL is empty; "
                          "configure via 'idf.py menuconfig' -> 'Patch voice device'. "
                          "Restarting in 5s.");
        }
        vTaskDelay(pdMS_TO_TICKS(5000));
        esp_restart();
    }

    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    pds_init(&s_state);
    prf_init(&s_ring);
    patch_led_init();
    render_state();

    // The Wi-Fi driver must be initialised before EITHER branch — the BLE
    // provisioning manager calls esp_wifi_set_mode() internally.
    net_stack_init();

    bool provisioned = patch_provision_load(&s_prov);

    // Bring up audio + the diag console FIRST — independent of network/provisioning
    // (codec/I2S/XMOS are all local). This guarantees the device produces audio
    // (and the local 'tone' self-test works) even before/while it is provisioned,
    // and keeps the console available during the blocking BLE provisioning flow.
    patch_audio_init();
    patch_button_init(on_button, NULL);
    patch_wakeword_init(on_wake_word, NULL);
    xTaskCreate(diag_console_task, "patch-diag", 3072, NULL, 4, NULL);

    if (!provisioned) {
        // First boot (or NVS wiped by an external full-flash). Run the normal
        // Wi-Fi-over-BLE + QR-link pairing so the device is RECOVERABLE. This
        // blocks app_main until pairing completes, but the audio + diag console
        // tasks above keep running.
        ESP_LOGW(TAG, "no provisioning creds — entering BLE provisioning "
                      "(audio + 'tone' diag already available)");
        if (!patch_provision_run(&s_prov)) {
            ESP_LOGE(TAG, "provisioning failed; halting (no fallback per spec/principles.md)");
            for (;;) vTaskDelay(pdMS_TO_TICKS(60000));
        }
    }
    wifi_init_sta();

    patch_control_cfg_t ccfg = {
        .daemon_host = s_prov.daemon_host,
        .daemon_port = s_prov.daemon_port,
        .use_tls     = s_prov.tls,
        .device_id   = s_prov.device_id,
        .fw_version  = FW_VERSION,
        .bearer_jwt  = s_prov.surface_jwt,
        .on_inbound   = on_control_inbound,
        .on_link_up   = on_control_link_up,
        .on_link_down = on_control_link_down,
        .get_muted    = get_muted_cb,
        .user = NULL,
    };
    patch_control_start(&ccfg);

    TimerHandle_t ring_tmr = xTimerCreate("patch-ring", pdMS_TO_TICKS(1000),
                                          pdTRUE, NULL, ring_tick_cb);
    xTimerStart(ring_tmr, 0);

    patch_ota_start(FW_VERSION);

    ESP_LOGI(TAG, "patch voice-device init complete; deviceId=%s", s_prov.device_id);
    // app_main returns; FreeRTOS keeps running tasks.
}
