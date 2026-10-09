package io.github.tomchambers2.patch

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicInteger

/**
 * Bridges Android's share sheet into JS: ACTION_SEND (text, or one image /
 * file of any type) and ACTION_SEND_MULTIPLE (several images / files).
 *
 * expo-linking only resolves ACTION_VIEW intents carrying a data URI
 * (src/lib/deepLink.ts) — a share intent carries its payload in extras, not a
 * URI, so it never reaches the JS deep-link resolver on its own. This module
 * hands the share to JS two ways: a cold start (app launched BY the share
 * sheet) reads it off the launching Activity's own intent (getInitialShare);
 * a share arriving while Patch is already running lands in
 * MainActivity.onNewIntent (singleTask launch mode — see
 * plugins/withShareIntent.js), which calls notifyNewIntent below to re-emit
 * it as a PatchShareReceived event.
 *
 * Payload: `{ text?, files: [{ uri, name, mimeType }], errors: [string] }`.
 *
 * Every shared stream is COPIED into this app's cache before JS sees it. The
 * sender's content:// grant is temporary and tied to the intent, and the file
 * is only read later — when the user picks a chat and presses Send, which can
 * be minutes on, or after the sender has revoked it. A private file:// copy is
 * what the composer's ordinary attachment path (downscale + upload) can always
 * read. A stream that cannot be copied is reported in `errors` by name, never
 * silently dropped (NO FALLBACK).
 */
class PatchShareModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val EVENT = "PatchShareReceived"
    private const val CACHE_DIR = "shared-in"
    /** Copies older than this are swept on the next share. */
    private const val CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000
    private val seq = AtomicInteger(0)
    private var instance: WeakReference<PatchShareModule>? = null

    /** Called from MainActivity.onNewIntent — see plugins/withShareIntent.js. */
    fun notifyNewIntent(intent: Intent) {
      instance?.get()?.emitIfShare(intent)
    }
  }

  init {
    instance = WeakReference(this)
  }

  override fun getName(): String = "PatchShare"

  // RN NativeEventEmitter compliance (same as PatchVoiceMicModule) — silences
  // the "new NativeEventEmitter() called with a non-null argument without
  // addListener" warning.
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  /** The share at COLD START (Patch launched via the share sheet), or null. */
  @ReactMethod
  fun getInitialShare(promise: Promise) {
    val activity: Activity? = currentActivity
    try {
      promise.resolve(shareMapFromIntent(activity?.intent))
    } catch (e: Throwable) {
      promise.reject("share_read_failed", e.message ?: e.javaClass.simpleName, e)
    }
  }

  private fun emitIfShare(intent: Intent) {
    if (!isShare(intent)) return
    // onNewIntent runs on the UI thread; copying a video there would freeze it.
    Thread {
      val map: WritableMap = (try {
        shareMapFromIntent(intent)
      } catch (e: Throwable) {
        Arguments.createMap().apply {
          putArray("files", Arguments.createArray())
          putArray(
            "errors",
            Arguments.createArray().apply {
              pushString("could not read the share: ${e.message ?: e.javaClass.simpleName}")
            },
          )
        }
      }) ?: return@Thread
      try {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT, map)
      } catch (_: Throwable) {
        // React instance torn down between the share arriving and us emitting —
        // nothing to deliver to.
      }
    }.start()
  }

  private fun isShare(intent: Intent?): Boolean =
    intent != null &&
      (intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE)

  private fun shareMapFromIntent(intent: Intent?): WritableMap? {
    if (intent == null || !isShare(intent)) return null
    val map = Arguments.createMap()
    intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.let { map.putString("text", it) }
    val files = Arguments.createArray()
    val errors = Arguments.createArray()
    val uris = streamUris(intent)
    if (uris.isNotEmpty()) sweepCache()
    for (uri in uris) {
      try {
        files.pushMap(copyToCache(uri, intent.type))
      } catch (e: Throwable) {
        errors.pushString("${displayName(uri) ?: uri}: ${e.message ?: e.javaClass.simpleName}")
      }
    }
    map.putArray("files", files)
    map.putArray("errors", errors)
    return map
  }

  @Suppress("DEPRECATION")
  private fun streamUris(intent: Intent): List<Uri> {
    val out = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val list: List<Uri>? =
        if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        }
      list?.let { out.addAll(it) }
    } else {
      val one: Uri? =
        if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
      one?.let { out.add(it) }
    }
    // Some senders put the streams on ClipData only (it is what carries the
    // read grant). Read them from there when the extra is empty.
    if (out.isEmpty()) {
      val clip = intent.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { out.add(it) }
      }
    }
    return out
  }

  private fun copyToCache(uri: Uri, intentType: String?): WritableMap {
    val resolver = ctx.contentResolver
    val name = (displayName(uri) ?: uri.lastPathSegment ?: "shared").replace('/', '_')
    // The provider's own type first; the intent's type only when it names one
    // concrete type (a multi-share of mixed files says `*/*`); otherwise the
    // honest "unknown binary".
    val mime =
      resolver.getType(uri)
        ?: intentType?.takeIf { !it.contains('*') }
        ?: "application/octet-stream"
    val dir = File(ctx.cacheDir, CACHE_DIR).apply { mkdirs() }
    val out = File(dir, "${System.currentTimeMillis()}-${seq.incrementAndGet()}-$name")
    val input = resolver.openInputStream(uri) ?: throw IllegalStateException("the sender gave no data")
    input.use { i -> out.outputStream().use { o -> i.copyTo(o) } }
    return Arguments.createMap().apply {
      putString("uri", Uri.fromFile(out).toString())
      putString("name", name)
      putString("mimeType", mime)
    }
  }

  private fun displayName(uri: Uri): String? =
    try {
      ctx.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Throwable) {
      null
    }

  /** Drop copies from earlier shares that have long since been sent or abandoned. */
  private fun sweepCache() {
    val dir = File(ctx.cacheDir, CACHE_DIR)
    val cutoff = System.currentTimeMillis() - CACHE_MAX_AGE_MS
    dir.listFiles()?.forEach { f -> if (f.lastModified() < cutoff) f.delete() }
  }
}
