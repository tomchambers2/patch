package io.github.tomchambers2.patch

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * JS-facing native module (`NativeModules.PatchVoiceAudioService`) that
 * starts / updates / stops the {@link VoiceAudioService} foreground service,
 * and forwards the notification's own button presses back to JS as
 * `PatchVoiceAudioAction` events ("mute" / "mode" / "stop").
 *
 * Consumed by src/lib/voiceAudioService.ts. NO FALLBACK: errors reject the
 * returned Promise so the JS caller surfaces them in the voice store rather
 * than continuing without a live foreground service.
 */
class PatchVoiceAudioServiceModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "PatchVoiceAudioService"

  override fun initialize() {
    super.initialize()
    VoiceAudioService.actionListener = { action ->
      if (ctx.hasActiveReactInstance()) {
        ctx
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("PatchVoiceAudioAction", action)
      }
    }
  }

  override fun invalidate() {
    VoiceAudioService.actionListener = null
    super.invalidate()
  }

  /** Required by NativeEventEmitter; the emitting is done above. */
  @ReactMethod fun addListener(eventName: String) = Unit

  @ReactMethod fun removeListeners(count: Int) = Unit

  private fun send(action: String, chatName: String?, mode: String?, muted: Boolean) {
    val intent =
      Intent(ctx, VoiceAudioService::class.java).apply {
        this.action = action
        putExtra(VoiceAudioService.EXTRA_CHAT, chatName)
        putExtra(VoiceAudioService.EXTRA_MODE, mode ?: "call")
        putExtra(VoiceAudioService.EXTRA_MUTED, muted)
      }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && action == VoiceAudioService.ACTION_START) {
      ctx.startForegroundService(intent)
    } else {
      ctx.startService(intent)
    }
  }

  @ReactMethod
  fun start(chatName: String?, mode: String?, muted: Boolean, promise: Promise) {
    try {
      send(VoiceAudioService.ACTION_START, chatName, mode, muted)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("voice_fg_start_failed", e.message, e)
    }
  }

  /**
   * Re-render the notification for a session that is already running — the
   * mode flipped, or the mic was muted. Same START path: the service is
   * already foreground, so this only rebuilds the notification.
   */
  @ReactMethod
  fun update(chatName: String?, mode: String?, muted: Boolean, promise: Promise) {
    try {
      send(VoiceAudioService.ACTION_START, chatName, mode, muted)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("voice_fg_update_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val intent =
        Intent(ctx, VoiceAudioService::class.java).apply {
          action = VoiceAudioService.ACTION_STOP
        }
      ctx.startService(intent)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("voice_fg_stop_failed", e.message, e)
    }
  }
}
