// patch_codec — TLV320AIC3204 codec + speaker-amp bring-up for the HA Voice PE.
//
// See patch_codec.h for the why. The register sequence below is ported, value
// for value, from the upstream ESPHome `aic3204` audio_dac driver
// (esphome/esphome esphome/components/aic3204) — the same driver the stock HA
// Voice PE firmware uses — so the DAC is configured exactly as the vendor does
// (I2S, 32-bit, line-out + headphone drivers powered, soft-step volume).

#include "patch_codec.h"
#include "patch_tts_render.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_err.h"
#include "sdkconfig.h"

static const char *TAG = "patch-codec";

// --- AIC3204 register map (page-relative) ----------------------------------
#define AIC3204_PAGE_CTRL     0x00
#define AIC3204_SW_RST        0x01
#define AIC3204_NDAC          0x0B
#define AIC3204_MDAC          0x0C
#define AIC3204_DOSR          0x0E
#define AIC3204_CODEC_IF      0x1B
#define AIC3204_AUDIO_IF_4    0x1F
#define AIC3204_AUDIO_IF_5    0x20
#define AIC3204_SCLK_MFP3     0x38
#define AIC3204_DAC_SIG_PROC  0x3C
#define AIC3204_DAC_CH_SET1   0x3F
#define AIC3204_DAC_CH_SET2   0x40
#define AIC3204_DACL_VOL_D    0x41
#define AIC3204_DACR_VOL_D    0x42
// Page 1
#define AIC3204_PWR_CFG       0x01
#define AIC3204_LDO_CTRL      0x02
#define AIC3204_PLAY_CFG1     0x03
#define AIC3204_PLAY_CFG2     0x04
#define AIC3204_OP_PWR_CTRL   0x09
#define AIC3204_CM_CTRL       0x0A
#define AIC3204_HPL_ROUTE     0x0C
#define AIC3204_HPR_ROUTE     0x0D
#define AIC3204_LOL_ROUTE     0x0E
#define AIC3204_LOR_ROUTE     0x0F
#define AIC3204_HPL_GAIN      0x10
#define AIC3204_HPR_GAIN      0x11
#define AIC3204_LOL_DRV_GAIN  0x12
#define AIC3204_LOR_DRV_GAIN  0x13
#define AIC3204_HP_START      0x14
#define AIC3204_REF_STARTUP   0x7B

#define I2C_TIMEOUT_MS        100

static i2c_master_bus_handle_t s_bus = NULL;
static i2c_master_dev_handle_t s_dev = NULL;
static bool s_ready = false;

static esp_err_t reg_write(uint8_t reg, uint8_t val) {
    uint8_t buf[2] = { reg, val };
    return i2c_master_transmit(s_dev, buf, sizeof buf, I2C_TIMEOUT_MS);
}

// Fail-loud register write: on any I2C NACK/error, log + return false so the
// caller aborts (no fallback, per spec/principles.md).
#define REG(r, v, msg)                                                  \
    do {                                                                \
        esp_err_t _e = reg_write((r), (v));                             \
        if (_e != ESP_OK) {                                             \
            ESP_LOGE(TAG, "%s (reg 0x%02x = 0x%02x): %s",               \
                     (msg), (r), (v), esp_err_to_name(_e));             \
            return false;                                               \
        }                                                               \
    } while (0)

static bool aic3204_configure(void) {
    // --- Page 0: clocks + audio interface ---
    REG(AIC3204_PAGE_CTRL, 0x00, "page 0");
    REG(AIC3204_SW_RST, 0x01, "sw reset");
    vTaskDelay(pdMS_TO_TICKS(10));     // let the SW reset settle

    REG(AIC3204_NDAC, 0x82, "NDAC");                 // power up NDAC = 2
    REG(AIC3204_MDAC, 0x82, "MDAC");                 // power up MDAC = 2
    REG(AIC3204_DOSR, 0x80, "DOSR");                 // DOSR = 128
    REG(AIC3204_CODEC_IF, 0x30, "CODEC_IF");         // I2S, 32-bit, DOUT driving
    REG(AIC3204_SCLK_MFP3, 0x02, "SCLK/MFP3");       // SCLK/MFP3 = audio data in
    REG(AIC3204_AUDIO_IF_4, 0x01, "AUDIO_IF_4");
    REG(AIC3204_AUDIO_IF_5, 0x01, "AUDIO_IF_5");
    REG(AIC3204_DAC_SIG_PROC, 0x01, "DAC_SIG_PROC"); // PRB_P1

    // --- Page 1: analog blocks + drivers ---
    REG(AIC3204_PAGE_CTRL, 0x01, "page 1");
    REG(AIC3204_LDO_CTRL, 0x09, "LDO_CTRL enable AVDD_LDO");
    REG(AIC3204_PWR_CFG, 0x08, "PWR_CFG");           // disable crude AVdd
    REG(AIC3204_LDO_CTRL, 0x01, "LDO_CTRL master");  // master analog power
    REG(AIC3204_CM_CTRL, 0x40, "CM_CTRL");           // common mode 0.75V
    // PTM_P1 (0x08) = Class-AB, HIGHEST-performance / LOWEST-distortion DAC
    // PowerTune mode. Stock ESPHome uses 0x00 = PTM_P3/P4 (lower power, HIGHER
    // distortion) — the analog nonlinearity we hear as speech crackle / two-tone
    // intermodulation. PTM_P1 needs MDAC*DOSR resource (2*128=256, /32=8, OK).
    REG(AIC3204_PLAY_CFG1, 0x08, "PLAY_CFG1");       // PTM_P1 class-AB (low distortion)
    REG(AIC3204_PLAY_CFG2, 0x08, "PLAY_CFG2");
    REG(AIC3204_REF_STARTUP, 0x01, "REF_STARTUP");   // 40ms ref charge
    REG(AIC3204_HP_START, 0x25, "HP_START");         // HP soft-step pop control
    REG(AIC3204_HPL_ROUTE, 0x08, "HPL_ROUTE");       // L DAC -> HPL
    REG(AIC3204_HPR_ROUTE, 0x08, "HPR_ROUTE");       // R DAC -> HPR
    REG(AIC3204_LOL_ROUTE, 0x08, "LOL_ROUTE");       // L DAC -> LOL
    REG(AIC3204_LOR_ROUTE, 0x08, "LOR_ROUTE");       // R DAC -> LOR
    REG(AIC3204_HPL_GAIN, 0x3e, "HPL_GAIN");         // unmute HPL, -2dB
    REG(AIC3204_HPR_GAIN, 0x3e, "HPR_GAIN");         // unmute HPR, -2dB
    REG(AIC3204_LOL_DRV_GAIN, 0x00, "LOL_DRV_GAIN"); // unmute LOL, 0dB
    REG(AIC3204_LOR_DRV_GAIN, 0x00, "LOR_DRV_GAIN"); // unmute LOR, 0dB
    REG(AIC3204_OP_PWR_CTRL, 0x3C, "OP_PWR_CTRL");   // power HPL/HPR/LOL/LOR

    // Soft-step settling before powering the DAC (ESPHome waits 2.5s).
    vTaskDelay(pdMS_TO_TICKS(2500));

    // --- Page 0: power up DAC + volume + unmute ---
    REG(AIC3204_PAGE_CTRL, 0x00, "page 0 (DAC)");
    REG(AIC3204_DAC_CH_SET1, 0xd4, "DAC_CH_SET1"); // power L+R DAC, L->L R->R
    // DAC digital volume — single source of truth is
    // patch_tts_dac_vol_reg(PATCH_TTS_DAC_VOL_HALF_STEPS) so the host harness
    // locks the shipped value. CONSERVATIVE-QUIET by design: the verification
    // mic sits at close range, so -20 dB (0xd8) clears the mic noise floor while
    // keeping a glitch physically incapable of disturbing people nearby. It
    // stays at-or-below the ~-18 dB ceiling the bring-up enforces and far below
    // the +24 dB hardware max (0x30) that clips. NOTE: the F1-audible-1 garble
    // was NOT a loudness problem — it reproduced at every level. The root cause
    // was the speaker I2S framing (mono slot vs the codec's 2-slot stereo bus),
    // fixed in patch_audio.c / patch_tts_widen_pcm16_stereo. Do not chase
    // loudness here; never park it above ~-18 dB.
    const uint8_t dac_vol = patch_tts_dac_vol_reg(PATCH_TTS_DAC_VOL_HALF_STEPS);
    REG(AIC3204_DACL_VOL_D, dac_vol, "DACL_VOL");
    REG(AIC3204_DACR_VOL_D, dac_vol, "DACR_VOL");
    REG(AIC3204_DAC_CH_SET2, 0x00, "DAC_CH_SET2"); // unmute (mute bits 2-3 = 0)

    return true;
}

// Configure the XMOS XU316 DSP over I2C, replicating ESPHome's `voice_kit`
// component — which our firmware otherwise SKIPS entirely (we only pulse the
// reset). The XMOS (FFVA firmware, I2C addr 0x42) exposes a "configuration
// servicer": resource id 241, then a register + length + value. The official
// driver, on every boot, sets each mic channel's pipeline depth (channel 0 ->
// AGC, channel 1 -> NS) and reads the version (VNR). Left in its power-on
// default the XMOS may mis-handle the audio engine — this brings it into the
// same runtime state as stock. Best-effort: logs + continues on any NACK.
bool patch_codec_set_dac_ptm(int cfg) {
    if (!s_dev) return false;
    reg_write(AIC3204_PAGE_CTRL, 0x01);            // page 1
    esp_err_t e1 = reg_write(AIC3204_PLAY_CFG1, (uint8_t)cfg);
    esp_err_t e2 = reg_write(AIC3204_PLAY_CFG2, (uint8_t)cfg);
    reg_write(AIC3204_PAGE_CTRL, 0x00);            // back to page 0
    ESP_LOGI(TAG, "DAC PTM cfg=0x%02x (%s/%s)", cfg, esp_err_to_name(e1), esp_err_to_name(e2));
    return e1 == ESP_OK && e2 == ESP_OK;
}

// Runtime DAC digital volume (page-0 regs 0x41/0x42), in half-dB steps. Lets us
// A/B output level live (stock runs ~+10 dB at its 0.85 cap; our boot default is
// the conservative -18 dB). +24 dB (=48) max, clips above; -63.5 dB min.
bool patch_codec_set_dac_vol(int half_steps) {
    if (!s_dev) return false;
    uint8_t v = patch_tts_dac_vol_reg(half_steps);
    reg_write(AIC3204_PAGE_CTRL, 0x00);            // page 0
    esp_err_t e1 = reg_write(AIC3204_DACL_VOL_D, v);
    esp_err_t e2 = reg_write(AIC3204_DACR_VOL_D, v);
    ESP_LOGI(TAG, "DAC vol = %d half-steps (reg 0x%02x) (%s/%s)",
             half_steps, v, esp_err_to_name(e1), esp_err_to_name(e2));
    return e1 == ESP_OK && e2 == ESP_OK;
}

bool patch_codec_set_xmos_pipeline(int ch0_stage, int ch1_stage) {
    if (!s_bus) return false;
    i2c_device_config_t xcfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = 0x42,
        .scl_speed_hz = 400000,
    };
    i2c_master_dev_handle_t xdev = NULL;
    if (i2c_master_bus_add_device(s_bus, &xcfg, &xdev) != ESP_OK) {
        ESP_LOGW(TAG, "XMOS: i2c add (0x42) failed");
        return false;
    }
    // Read VNR once (best effort): {241, 0x00|READ_BIT, len} then read.
    uint8_t vnr_req[] = {241, 0x00 | 0x80, 2};
    uint8_t vnr_resp[3] = {0};
    if (i2c_master_transmit(xdev, vnr_req, sizeof vnr_req, I2C_TIMEOUT_MS) == ESP_OK &&
        i2c_master_receive(xdev, vnr_resp, sizeof vnr_resp, I2C_TIMEOUT_MS) == ESP_OK) {
        ESP_LOGI(TAG, "XMOS VNR bytes=%u,%u,%u", vnr_resp[0], vnr_resp[1], vnr_resp[2]);
    }
    // Pipeline stages (CONFIGURATION_SERVICER_RESID=241): ch0 reg 0x30, ch1 reg
    // 0x40. Format: {241, reg, value_len(1), value}.
    uint8_t ch0[] = {241, 0x30, 1, (uint8_t)ch0_stage};
    uint8_t ch1[] = {241, 0x40, 1, (uint8_t)ch1_stage};
    esp_err_t e0 = i2c_master_transmit(xdev, ch0, sizeof ch0, I2C_TIMEOUT_MS);
    esp_err_t e1 = i2c_master_transmit(xdev, ch1, sizeof ch1, I2C_TIMEOUT_MS);
    ESP_LOGI(TAG, "XMOS pipeline set: ch0=%d(%s) ch1=%d(%s)",
             ch0_stage, esp_err_to_name(e0), ch1_stage, esp_err_to_name(e1));
    i2c_master_bus_rm_device(xdev);
    return e0 == ESP_OK && e1 == ESP_OK;
}

// Configure the XMOS DSP like ESPHome's voice_kit (ch0=AGC, ch1=NS) at boot.
static void patch_codec_config_xmos(void) {
    patch_codec_set_xmos_pipeline(4 /*AGC*/, 3 /*NS*/);
}

bool patch_codec_init(void) {
    if (s_ready) return true;

    // Reset the XMOS DSP so it boots its persisted FFVA firmware (which then
    // supplies the I2S audio clocks). Reset is ACTIVE-HIGH on this board: the
    // ESPHome voice_kit driver pulses reset HIGH then drives it LOW for the
    // run state (digital_write(true); delay(1); digital_write(false)). The
    // XMOS keeps its firmware in its own flash, so a reset alone boots it — no
    // DFU upload needed unless the version mismatches.
    if (CONFIG_PATCH_XMOS_RESET_GPIO >= 0) {
        gpio_config_t rst = {
            .pin_bit_mask = 1ULL << CONFIG_PATCH_XMOS_RESET_GPIO,
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        ESP_ERROR_CHECK(gpio_config(&rst));
        gpio_set_level(CONFIG_PATCH_XMOS_RESET_GPIO, 1);   // assert reset
        vTaskDelay(pdMS_TO_TICKS(5));
        gpio_set_level(CONFIG_PATCH_XMOS_RESET_GPIO, 0);   // release -> run
        // Give the XMOS firmware time to boot before we touch the I2C codec.
        vTaskDelay(pdMS_TO_TICKS(3000));
        ESP_LOGI(TAG, "XMOS reset pulsed (GPIO%d: high->low, running)",
                 CONFIG_PATCH_XMOS_RESET_GPIO);
    }

    // Speaker amp enable line: configure as output, default OFF (matches
    // ESPHome restore_mode ALWAYS_OFF). patch_codec_amp_enable() drives it.
    if (CONFIG_PATCH_SPK_AMP_EN_GPIO >= 0) {
        gpio_config_t amp = {
            .pin_bit_mask = 1ULL << CONFIG_PATCH_SPK_AMP_EN_GPIO,
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        ESP_ERROR_CHECK(gpio_config(&amp));
        gpio_set_level(CONFIG_PATCH_SPK_AMP_EN_GPIO, 0);
    }

    // I2C master bus for the codec control plane.
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = CONFIG_PATCH_CODEC_I2C_SDA_GPIO,
        .scl_io_num = CONFIG_PATCH_CODEC_I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus init failed (sda=%d scl=%d): %s",
                 CONFIG_PATCH_CODEC_I2C_SDA_GPIO, CONFIG_PATCH_CODEC_I2C_SCL_GPIO,
                 esp_err_to_name(err));
        return false;
    }

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = CONFIG_PATCH_CODEC_I2C_ADDR,
        .scl_speed_hz = 400000,
    };
    err = i2c_master_bus_add_device(s_bus, &dev_cfg, &s_dev);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c add device 0x%02x failed: %s",
                 CONFIG_PATCH_CODEC_I2C_ADDR, esp_err_to_name(err));
        return false;
    }

    // Probe: the codec must ACK its address or we have the wrong bus/pins.
    err = i2c_master_probe(s_bus, CONFIG_PATCH_CODEC_I2C_ADDR, I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "AIC3204 did not ACK at 0x%02x on sda=%d scl=%d: %s — "
                      "audio output will be silent (codec absent or miswired)",
                 CONFIG_PATCH_CODEC_I2C_ADDR, CONFIG_PATCH_CODEC_I2C_SDA_GPIO,
                 CONFIG_PATCH_CODEC_I2C_SCL_GPIO, esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "AIC3204 ACKed at 0x%02x; configuring DAC", CONFIG_PATCH_CODEC_I2C_ADDR);

    // Configure the XMOS DSP like the official voice_kit component does (we
    // otherwise leave it in its power-on default). Done before the DAC config.
    patch_codec_config_xmos();

    if (!aic3204_configure()) {
        ESP_LOGE(TAG, "AIC3204 register configuration failed");
        return false;
    }

    s_ready = true;
    ESP_LOGI(TAG, "codec ready (DAC powered, drivers unmuted)");
    return true;
}

// Soft-mute / unmute the DAC (page-0 DAC_CH_SET2). The DAC channels were powered
// with soft-stepping enabled, so a mute ramps the output down gracefully rather
// than stepping — used to silence the DAC BEFORE the class-D amp is powered down,
// which removes the "little pop" the amp makes on shutdown (the amp clicks if its
// input still carries the DAC's DC bias when GPIO47 drops).
static void dac_soft_mute(bool mute) {
    if (!s_dev) return;
    reg_write(AIC3204_PAGE_CTRL, 0x00);                 // page 0
    reg_write(AIC3204_DAC_CH_SET2, mute ? 0x0c : 0x00); // mute bits 2-3
}

void patch_codec_amp_enable(bool on) {
    if (CONFIG_PATCH_SPK_AMP_EN_GPIO < 0) return;
    // ENABLE-ONCE-AND-STAY-ON. The class-D amp has an intrinsic turn-OFF pop
    // (a hardware transient when GPIO47 drops — independent of the audio, which
    // is already silent; soft-muting the DAC does NOT remove it). The device is
    // mains-powered and the amp is dead-silent at idle (no hiss, confirmed by
    // ear), so we simply never power it down: enable on first use, then leave it
    // on. This eliminates the "pop at the end" of every utterance for good.
    // (The separate "stale DMA repeat on underrun" pop is handled by
    // tx_cfg.auto_clear in patch_audio.c.)
    static bool s_amp_on = false;
    if (!on) return;            // ignore power-down requests — see above
    if (s_amp_on) return;       // already on (idempotent; callers re-assert freely)
    s_amp_on = true;
    dac_soft_mute(false);       // DAC live + unmuted before the amp comes up
    gpio_set_level(CONFIG_PATCH_SPK_AMP_EN_GPIO, 1);
    ESP_LOGI(TAG, "speaker amp ENABLED (GPIO%d, stays on)",
             CONFIG_PATCH_SPK_AMP_EN_GPIO);
}

bool patch_codec_ready(void) {
    return s_ready;
}
