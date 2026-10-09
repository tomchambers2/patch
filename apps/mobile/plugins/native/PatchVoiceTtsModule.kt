package io.github.tomchambers2.patch

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.LinkedBlockingQueue

/**
 * Native TTS playback module (`NativeModules.PatchVoiceTts`) for the sustained
 * voice CALL (spec/07 § End-to-end voice transport — the down leg: the host
 * streams Kokoro TTS as `audio.tts_chunk` PCM16 @ 24 kHz mono binary frames and
 * the surface must play them back-to-back so the agent's reply is heard).
 *
 * expo-av's Sound plays a COMPLETE asset — it cannot append-as-you-go into a
 * live PCM ring, so hearing a streamed reply needs a native AudioTrack in
 * MODE_STREAM. Chunks arrive from JS as base64 (src/lib/voiceTts.ts) and are
 * queued to a writer thread so the RN bridge thread never blocks on
 * AudioTrack.write. Barge-in flushes both the queue and the track so the
 * agent's cut-off audio stops immediately.
 *
 * NO FALLBACK: if AudioTrack can't initialise the start Promise rejects, so the
 * JS caller tears the call down and surfaces the failure — never a call that
 * looks live but plays no audio.
 */
class PatchVoiceTtsModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    // Kokoro streams 24 kHz mono PCM16 (spec/07 § TTS — Kokoro).
    const val SAMPLE_RATE = 24000
    // Enqueued to unblock the writer thread's take() on stop.
    private val POISON = ByteArray(0)
    // adb logcat | grep patch-voice → pinpoints where the TTS down leg stalls.
    const val TAG = "patch-voice"
  }

  private var track: AudioTrack? = null
  @Volatile private var running = false
  @Volatile private var wroteFirst = false
  private var writer: Thread? = null
  private val queue = LinkedBlockingQueue<ByteArray>()

  override fun getName(): String = "PatchVoiceTts"

  @ReactMethod
  fun start(promise: Promise) {
    if (running) {
      promise.resolve(null)
      return
    }
    try {
      val minBuf =
        AudioTrack.getMinBufferSize(
          SAMPLE_RATE,
          AudioFormat.CHANNEL_OUT_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
        )
      if (minBuf <= 0) {
        promise.reject("tts_unavailable", "AudioTrack.getMinBufferSize returned $minBuf")
        return
      }
      // ~0.5 s of headroom (SAMPLE_RATE * 2 bytes = 1 s) smooths jitter without
      // adding audible latency to the reply.
      val bufSize = maxOf(minBuf, SAMPLE_RATE)
      val t =
        AudioTrack.Builder()
          .setAudioAttributes(
            AudioAttributes.Builder()
              // Match the call's VOICE_COMMUNICATION routing so playback goes to
              // the call audio path (earpiece/BT), not the media stream.
              .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build(),
          )
          .setAudioFormat(
            AudioFormat.Builder()
              .setSampleRate(SAMPLE_RATE)
              .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
              .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
              .build(),
          )
          .setBufferSizeInBytes(bufSize)
          .setTransferMode(AudioTrack.MODE_STREAM)
          .build()
      if (t.state != AudioTrack.STATE_INITIALIZED) {
        t.release()
        promise.reject("tts_unavailable", "AudioTrack failed to initialise")
        return
      }
      track = t
      running = true
      wroteFirst = false
      queue.clear()
      t.play()
      Log.i(TAG, "native tts: AudioTrack started (24kHz mono PCM16, MODE_STREAM, VOICE_COMMUNICATION)")
      val w = Thread({ writeLoop(t) }, "patch-voice-tts")
      w.start()
      writer = w
      promise.resolve(null)
    } catch (e: Throwable) {
      running = false
      track?.release()
      track = null
      Log.e(TAG, "native tts: start failed: ${e.message}")
      promise.reject("tts_start_failed", e.message, e)
    }
  }

  private fun writeLoop(t: AudioTrack) {
    while (running) {
      val chunk =
        try {
          queue.take()
        } catch (_: InterruptedException) {
          break
        }
      if (chunk.isEmpty()) continue // poison / no-op marker; loop re-checks running
      var off = 0
      while (off < chunk.size && running) {
        val n = t.write(chunk, off, chunk.size - off)
        if (n < 0) {
          // ERROR_INVALID_OPERATION / ERROR_DEAD_OBJECT — stop the loop; the JS
          // side ends the call when playback dies.
          running = false
          break
        }
        off += n
      }
    }
  }

  @ReactMethod
  fun write(base64: String, promise: Promise) {
    if (!running) {
      promise.reject("tts_not_started", "PatchVoiceTts.write called before start")
      return
    }
    try {
      queue.offer(Base64.decode(base64, Base64.DEFAULT))
      if (!wroteFirst) {
        Log.i(TAG, "native tts: first PCM chunk queued → AudioTrack (audio should now be audible)")
        wroteFirst = true
      }
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("tts_write_failed", e.message, e)
    }
  }

  /** Barge-in: drop queued + in-flight audio so the cut-off reply stops now. */
  @ReactMethod
  fun flush(promise: Promise) {
    queue.clear()
    try {
      track?.pause()
      track?.flush()
      track?.play()
    } catch (_: Throwable) {
      // Track already stopped — nothing to flush.
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    running = false
    queue.clear()
    queue.offer(POISON)
    try {
      writer?.join(500)
    } catch (_: InterruptedException) {
      // Best-effort join; the track is released below regardless.
    }
    writer = null
    try {
      track?.pause()
      track?.flush()
      track?.stop()
    } catch (_: Throwable) {
      // Already stopped / never started — release is the source of truth.
    }
    track?.release()
    track = null
    promise.resolve(null)
  }

  override fun invalidate() {
    running = false
    queue.offer(POISON)
    try {
      track?.stop()
    } catch (_: Throwable) {
      // ignore
    }
    track?.release()
    track = null
    super.invalidate()
  }
}
