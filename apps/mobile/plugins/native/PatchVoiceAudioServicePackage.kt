package io.github.tomchambers2.patch

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the hand-rolled voice native modules with the RN bridge:
 * {@link PatchVoiceAudioServiceModule} (foreground service),
 * {@link PatchVoiceMicModule} (AudioRecord PCM16 mic tap — the up leg) and
 * {@link PatchVoiceTtsModule} (AudioTrack PCM16 playback — the down leg) for
 * the sustained voice call (see spec/07 § End-to-end voice transport).
 */
class PatchVoiceAudioServicePackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> =
    listOf(
      PatchVoiceAudioServiceModule(reactContext),
      PatchVoiceMicModule(reactContext),
      PatchVoiceTtsModule(reactContext),
    )

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
