package io.github.tomchambers2.patch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder

/**
 * Foreground service that keeps the voice session (mic + audio focus) alive
 * while the app is backgrounded — required by Android for any app that
 * records audio off-screen (spec/15 ## Native specifics: "Foreground service
 * while voice is active (OS requires it)").
 *
 * The persistent notification is the CONTROL SURFACE for a phone the user is
 * not looking at (spec/15 § Voice tab): it names the mode and carries
 * Mute, a mode switch and End call. Those actions come back to JS
 * through {@link actionListener} so the app state and the notification never
 * disagree — a notification button that only changed the notification would be
 * a lie about what the call is doing.
 *
 * Audio focus is requested as AUDIOFOCUS_GAIN, so music and navigation prompts
 * duck for the session rather than playing over it. A hands-free session holds
 * the same service and the same focus: silence is not the same as being
 * finished, and a session Android drops while the phone is in a pocket is the
 * failure this prevents.
 *
 * Started/stopped from JS via PatchVoiceAudioServiceModule. NO FALLBACK: if
 * the platform refuses to promote us to foreground we throw, surfacing the
 * failure rather than silently dropping background audio.
 */
class VoiceAudioService : Service() {
  companion object {
    const val CHANNEL_ID = "patch_voice_fg"
    const val NOTIFICATION_ID = 4711
    const val EXTRA_CHAT = "chat"
    const val EXTRA_MODE = "mode"
    const val EXTRA_MUTED = "muted"
    const val ACTION_START = "io.github.tomchambers2.patch.voice.START"
    const val ACTION_STOP = "io.github.tomchambers2.patch.voice.STOP"
    /**
     * The notification's own End call button, as distinct from ACTION_STOP,
     * which is JS tearing the service down. Only this one tells JS to end the
     * call — routing both through one action would have JS's own teardown
     * bounce straight back at it as a fresh end-the-call request.
     */
    const val ACTION_END_FROM_NOTIFICATION = "io.github.tomchambers2.patch.voice.END"
    const val ACTION_MUTE = "io.github.tomchambers2.patch.voice.MUTE"
    const val ACTION_MODE = "io.github.tomchambers2.patch.voice.MODE"

    /**
     * Set by PatchVoiceAudioServiceModule while the React context is alive.
     * The service calls it with the bare action name when the user presses one
     * of the notification's buttons; JS owns what that means.
     */
    @Volatile var actionListener: ((String) -> Unit)? = null
  }

  private var focusRequest: AudioFocusRequest? = null
  private var chat: String? = null
  private var mode: String = "call"
  private var muted: Boolean = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_END_FROM_NOTIFICATION -> {
        // A press on End call has to end the CALL, not just the service —
        // otherwise the app is left holding a session with no notification.
        actionListener?.invoke("stop")
        abandonAudioFocus()
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_STOP -> {
        abandonAudioFocus()
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_MUTE -> {
        actionListener?.invoke("mute")
        return START_STICKY
      }
      ACTION_MODE -> {
        actionListener?.invoke("mode")
        return START_STICKY
      }
    }
    if (intent != null) {
      chat = intent.getStringExtra(EXTRA_CHAT)
      mode = intent.getStringExtra(EXTRA_MODE) ?: "call"
      muted = intent.getBooleanExtra(EXTRA_MUTED, false)
    }
    ensureChannel()
    requestAudioFocus()
    startForeground(NOTIFICATION_ID, buildNotification())
    return START_STICKY
  }

  override fun onDestroy() {
    abandonAudioFocus()
    super.onDestroy()
  }

  private fun requestAudioFocus() {
    if (focusRequest != null) return
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes =
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      val request =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(attributes)
          .setWillPauseWhenDucked(false)
          .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(
        null,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN,
      )
    }
  }

  private fun abandonAudioFocus() {
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val request = focusRequest
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
      manager.abandonAudioFocusRequest(request)
    } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      @Suppress("DEPRECATION") manager.abandonAudioFocus(null)
    }
    focusRequest = null
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
        val channel =
          NotificationChannel(
            CHANNEL_ID,
            "Patch voice session",
            NotificationManager.IMPORTANCE_LOW,
          )
        channel.setShowBadge(false)
        mgr.createNotificationChannel(channel)
      }
    }
  }

  private fun serviceAction(action: String, requestCode: Int): PendingIntent {
    val intent = Intent(this, VoiceAudioService::class.java).apply { this.action = action }
    return PendingIntent.getService(
      this,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun buildNotification(): Notification {
    val open =
      packageManager.getLaunchIntentForPackage(packageName)?.apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
      }
    val contentIntent =
      PendingIntent.getActivity(
        this,
        0,
        open ?: Intent(),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val handsFree = mode == "hands-free"
    val label = if (handsFree) "Hands-free" else "On call"
    val status = if (chat.isNullOrBlank()) label else "$label · $chat"

    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(this)
      }

    return builder
      .setContentTitle("Patch")
      .setContentText(status)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .addAction(
        Notification.Action.Builder(
            0,
            if (muted) "Unmute" else "Mute",
            serviceAction(ACTION_MUTE, 2),
          )
          .build()
      )
      .addAction(
        Notification.Action.Builder(
            0,
            if (handsFree) "Take the call" else "Hands-free",
            serviceAction(ACTION_MODE, 3),
          )
          .build()
      )
      .addAction(
        Notification.Action.Builder(
            0,
            "End call",
            serviceAction(ACTION_END_FROM_NOTIFICATION, 1),
          )
          .build()
      )
      .build()
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
  }
}
