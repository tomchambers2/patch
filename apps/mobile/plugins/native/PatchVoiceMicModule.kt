package io.github.tomchambers2.patch

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Native mic-capture module (`NativeModules.PatchVoiceMic`) for the sustained
 * voice CALL (spec/07 § End-to-end voice transport — "on mobile the PCM
 * transport is a native module … expo-av alone cannot stream PCM").
 *
 * expo-av's Recording API only writes a whole file on stop — it exposes no
 * per-frame tap, so a voice CALL (which must stream mic PCM up the audio WSS
 * while the user is still speaking) cannot use it. This module opens an
 * AudioRecord at the host's canonical 16 kHz mono PCM16 and emits every
 * ~40 ms frame to JS as a base64 `PatchVoiceMicFrame` event; src/lib/voiceMic.ts
 * decodes it and forwards it over the WS.
 *
 * NO FALLBACK: if AudioRecord can't initialise (mic permission missing / device
 * busy) the start Promise rejects, so the JS caller tears the call down and
 * surfaces the failure — never a call that silently carries no audio. A
 * mid-stream read error emits an `error` frame for the same reason.
 */
class PatchVoiceMicModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val SAMPLE_RATE = 16000
    // 40 ms @ 16 kHz mono = 640 samples = 1280 bytes. The host VADs on
    // whatever arrives (session.ts onMicFrame), so the exact size isn't
    // load-bearing; 40 ms balances latency against per-frame bridge overhead.
    const val FRAME_SAMPLES = 640
    const val FRAME_BYTES = FRAME_SAMPLES * 2
    const val EVENT = "PatchVoiceMicFrame"
    // adb logcat | grep patch-voice → pinpoints where the mic uplink stalls.
    const val TAG = "patch-voice"
  }

  private var record: AudioRecord? = null
  @Volatile private var running = false
  private var thread: Thread? = null

  override fun getName(): String = "PatchVoiceMic"

  // RN NativeEventEmitter compliance — silences the "new NativeEventEmitter()
  // was called with a non-null argument without addListener" warning.
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  @ReactMethod
  fun start(promise: Promise) {
    if (running) {
      promise.resolve(null)
      return
    }
    try {
      val minBuf =
        AudioRecord.getMinBufferSize(
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
        )
      if (minBuf <= 0) {
        promise.reject("mic_unavailable", "AudioRecord.getMinBufferSize returned $minBuf")
        return
      }
      // A generous buffer (>= 4 frames) so a scheduling hiccup on the read
      // thread doesn't overrun and drop samples.
      val bufSize = maxOf(minBuf, FRAME_BYTES * 4)
      val rec =
        AudioRecord(
          // VOICE_COMMUNICATION engages the platform's echo-cancel / noise
          // suppression — spec/07 relies on device-side AEC (surfaceHasAec=true).
          MediaRecorder.AudioSource.VOICE_COMMUNICATION,
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          bufSize,
        )
      if (rec.state != AudioRecord.STATE_INITIALIZED) {
        rec.release()
        promise.reject(
          "mic_unavailable",
          "AudioRecord failed to initialise (mic permission denied or device in use)",
        )
        return
      }
      record = rec
      running = true
      rec.startRecording()
      Log.i(TAG, "native mic: AudioRecord started (16kHz mono PCM16, VOICE_COMMUNICATION)")
      val t = Thread({ readLoop(rec) }, "patch-voice-mic")
      t.start()
      thread = t
      promise.resolve(null)
    } catch (e: Throwable) {
      running = false
      record?.release()
      record = null
      Log.e(TAG, "native mic: start failed: ${e.message}")
      promise.reject("mic_start_failed", e.message, e)
    }
  }

  private fun readLoop(rec: AudioRecord) {
    val buf = ByteArray(FRAME_BYTES)
    var firstFrame = true
    while (running) {
      // AudioRecord.read may return fewer bytes than requested; fill a whole
      // frame before emitting so the host always sees complete PCM16 frames.
      var off = 0
      while (off < FRAME_BYTES && running) {
        val n = rec.read(buf, off, FRAME_BYTES - off)
        if (n <= 0) {
          // ERROR_INVALID_OPERATION (-3) / ERROR_BAD_VALUE (-2) / DEAD_OBJECT.
          if (running) emitError("AudioRecord.read returned $n")
          return
        }
        off += n
      }
      if (!running) break
      if (firstFrame) {
        Log.i(TAG, "native mic: first PCM frame captured → emitting to JS")
        firstFrame = false
      }
      val map = Arguments.createMap()
      map.putString("base64", Base64.encodeToString(buf, Base64.NO_WRAP))
      map.putInt("samples", FRAME_SAMPLES)
      emit(map)
    }
  }

  private fun emit(map: WritableMap) {
    try {
      ctx
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT, map)
    } catch (_: Throwable) {
      // React instance torn down mid-frame — nothing to deliver to.
    }
  }

  private fun emitError(message: String) {
    Log.e(TAG, "native mic: read loop error: $message")
    val map = Arguments.createMap()
    map.putString("error", message)
    emit(map)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    running = false
    try {
      thread?.join(500)
    } catch (_: InterruptedException) {
      // Best-effort join; the record is released below regardless.
    }
    thread = null
    try {
      record?.stop()
    } catch (_: Throwable) {
      // Already stopped / never started — release is the source of truth.
    }
    record?.release()
    record = null
    promise.resolve(null)
  }

  override fun invalidate() {
    running = false
    try {
      record?.stop()
    } catch (_: Throwable) {
      // ignore
    }
    record?.release()
    record = null
    super.invalidate()
  }
}
