package io.github.tomchambers2.patch

import android.content.ClipData
import android.content.ClipDescription
import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.MimeTypeMap
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.UIManagerModule
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/**
 * Image paste into the composer's TextInput — the way other Android apps do
 * it: an androidx `OnReceiveContentListener` on the EditText, declared for
 * image MIME types. That one listener receives BOTH the long-press → Paste of an
 * image on the clipboard AND a keyboard's image insertion (Gboard GIFs,
 * stickers, clipboard-chip images — `InputConnection.commitContent`).
 *
 * RN 0.76's TextInput has no paste event, so JS asks for this per input:
 * `attach(reactTag)` resolves the input's `ReactEditText` (an
 * `AppCompatEditText`, whose context-menu paste and input connection route
 * through `performReceiveContent` once a listener is set) and installs the
 * listener. Old architecture only (UIManagerModule) — the app runs with
 * newArchEnabled=false.
 *
 * TEXT IS UNTOUCHED: the listener only takes clip items whose URI resolves to
 * an image type and hands everything else back, so a text paste still goes
 * through ReactEditText's own paste-as-plain-text exactly as before.
 *
 * Each image is COPIED into the app's cache on the spot. A keyboard's
 * content grant is temporary (it lasts only as long as the InputContentInfo
 * it came with), and the composer reads the file later, on Send. A copy that
 * fails is reported by name in `errors`, never dropped silently.
 *
 * Event `PatchPasteReceived`: `{ tag, files: [{ uri, name, mimeType, width?,
 * height? }], errors: [string] }` — `tag` says which input it landed in.
 */
class PatchPasteModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val EVENT = "PatchPasteReceived"
    private const val CACHE_DIR = "pasted-in"
    /** Copies older than this are swept on the next paste. */
    private const val CACHE_MAX_AGE_MS = 24L * 60 * 60 * 1000
    private val MIME_TYPES = arrayOf("image/*")
    private val seq = AtomicInteger(0)
  }

  override fun getName(): String = "PatchPaste"

  // RN NativeEventEmitter compliance (same as PatchShareModule).
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  /** Install the image listener on the EditText behind React tag `tag`. */
  @ReactMethod
  fun attach(tag: Int, promise: Promise) {
    val uiManager = ctx.getNativeModule(UIManagerModule::class.java)
    if (uiManager == null) {
      promise.reject("paste_attach_failed", "UIManagerModule missing (new architecture?)")
      return
    }
    // A UI block runs after the batch that created the view, so a tag handed
    // over from a just-mounted TextInput always resolves.
    uiManager.addUIBlock { registry ->
      try {
        val view = registry.resolveView(tag)
        val edit =
          view as? EditText
            ?: throw IllegalStateException("view $tag is a ${view.javaClass.simpleName}, not an EditText")
        ViewCompat.setOnReceiveContentListener(edit, MIME_TYPES, ImageReceiver(tag))
        // A keyboard learns which MIME types a field accepts when it opens its
        // input connection. If the field already has one, reopen it so Gboard
        // offers images right away rather than after the next focus.
        if (edit.hasFocus()) {
          (ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).restartInput(edit)
        }
        promise.resolve(null)
      } catch (e: Throwable) {
        promise.reject("paste_attach_failed", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  private inner class ImageReceiver(private val tag: Int) : OnReceiveContentListener {
    override fun onReceiveContent(view: View, payload: ContentInfoCompat): ContentInfoCompat? {
      val description = payload.clip.description
      val split = payload.partition { item -> imageMime(item, description) != null }
      val images = split.first ?: return split.second
      // Copy NOW, on this (UI) thread: a keyboard's read grant is only
      // guaranteed while this call is running.
      val files = Arguments.createArray()
      val errors = Arguments.createArray()
      sweepCache()
      val clip = images.clip
      for (i in 0 until clip.itemCount) {
        val item = clip.getItemAt(i)
        val uri = item.uri
        try {
          copyToCache(uri, imageMime(item, description)!!, files)
        } catch (e: Throwable) {
          errors.pushString("${displayName(uri) ?: uri}: ${e.message ?: e.javaClass.simpleName}")
        }
      }
      val event =
        Arguments.createMap().apply {
          putInt("tag", tag)
          putArray("files", files)
          putArray("errors", errors)
        }
      try {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT, event)
      } catch (_: Throwable) {
        // React instance torn down under a live EditText — there is no JS left
        // to deliver to, and throwing here would crash the paste.
      }
      return split.second
    }
  }

  /** The item's image MIME type, or null when it is not an image (text, a link, a PDF...). */
  private fun imageMime(item: ClipData.Item, description: ClipDescription): String? {
    val uri = item.uri ?: return null
    val resolved =
      try {
        ctx.contentResolver.getType(uri)
      } catch (_: SecurityException) {
        null
      }
    // The provider's own type first; the clip's declared image type when the
    // provider will not say (keyboards' providers often do not).
    val mime = resolved ?: description.filterMimeTypes("image/*")?.firstOrNull()
    return mime?.takeIf { it.startsWith("image/") }
  }

  private fun copyToCache(uri: Uri, mime: String, out: WritableArray) {
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "img"
    val name =
      (displayName(uri) ?: "pasted-image-${System.currentTimeMillis()}.$ext").replace('/', '_')
    val dir = File(ctx.cacheDir, CACHE_DIR).apply { mkdirs() }
    val file = File(dir, "${System.currentTimeMillis()}-${seq.incrementAndGet()}-$name")
    val input =
      ctx.contentResolver.openInputStream(uri) ?: throw IllegalStateException("no data behind the image")
    input.use { i -> file.outputStream().use { o -> i.copyTo(o) } }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    out.pushMap(
      Arguments.createMap().apply {
        putString("uri", Uri.fromFile(file).toString())
        putString("name", name)
        putString("mimeType", mime)
        if (bounds.outWidth > 0 && bounds.outHeight > 0) {
          putInt("width", bounds.outWidth)
          putInt("height", bounds.outHeight)
        }
      },
    )
  }

  private fun displayName(uri: Uri): String? =
    try {
      ctx.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Throwable) {
      null
    }

  /** Drop copies from earlier pastes that have long since been sent or abandoned. */
  private fun sweepCache() {
    val dir = File(ctx.cacheDir, CACHE_DIR)
    val cutoff = System.currentTimeMillis() - CACHE_MAX_AGE_MS
    dir.listFiles()?.forEach { f -> if (f.lastModified() < cutoff) f.delete() }
  }
}
