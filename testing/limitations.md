# Known Limitations of AI-Driven Native Testing

These are hard limits on what can be tested programmatically via CLI tools. Some have workarounds, some don't.

## iOS Simulator (idb + simctl)

| What                            | Can test? | Details                                                 |
| ------------------------------- | --------- | ------------------------------------------------------- |
| UI rendering                    | Yes       | Screenshots + Read tool                                 |
| Tap elements                    | Yes       | idb ui tap with coordinates from describe-all           |
| Scroll / swipe                  | Yes       | idb ui swipe                                            |
| System dialogs (permissions)    | Yes       | Appear in accessibility tree                            |
| Push notification delivery      | Yes       | xcrun simctl push shows banners                         |
| Local notification scheduling   | Yes       | Schedule near-future, background app, screenshot        |
| **Notification banner tap**     | **No**    | Banner overlay is not in accessibility tree             |
| **Notification action buttons** | **No**    | Can't expand or interact with notification actions      |
| **Notification center**         | **No**    | Can't swipe down to open or interact with it            |
| Keyboard input                  | Partial   | idb can type but not always reliably into RN TextInputs |
| Biometrics                      | No        | Face ID / Touch ID can't be simulated via idb           |
| Camera / photos                 | No        | No camera simulation                                    |
| In-app purchases                | No        | StoreKit testing requires Xcode UI                      |
| Audio playback                  | No        | Can't verify sound programmatically                     |

### Workarounds for notification testing

- **Visual verification**: Send notification, screenshot at the right moment to see the banner
- **Code-level testing**: Call `handleNotificationAction()` directly with mock response objects
- **XCUITest**: Apple's UI testing framework CAN interact with notification center and action buttons, but requires writing Swift test code
- **Detox**: Wix's React Native E2E framework has some notification interaction support

## Android Emulator (ADB)

| What                           | Can test? | Details                       |
| ------------------------------ | --------- | ----------------------------- |
| UI rendering                   | Yes       | adb screencap                 |
| Tap elements                   | Yes       | adb shell input tap           |
| Scroll / swipe                 | Yes       | adb shell input swipe         |
| System dialogs                 | Yes       | Via uiautomator dump + tap    |
| **Push notification delivery** | **No**    | No equivalent of simctl push  |
| Local notification scheduling  | Yes       | Same approach as iOS          |
| **Notification interactions**  | **No**    | Same limitation as iOS        |
| Keyboard input                 | Yes       | adb shell input text          |
| Permissions                    | Yes       | adb shell pm grant/revoke     |
| Deep links                     | Yes       | adb shell am start -d         |
| Logcat                         | Yes       | adb logcat for console output |

### Workarounds

- **No push simulation**: Rely on the app's own local notification scheduling. Or send an FCM test message if the app uses Firebase.
- **uiautomator is slow**: Cache results. Don't dump the tree on every action — only when you need to find new coordinates.

## macOS Desktop (AppleScript + cliclick)

| What                       | Can test?   | Details                                                      |
| -------------------------- | ----------- | ------------------------------------------------------------ |
| Window rendering           | Yes         | screencapture                                                |
| Window buttons/controls    | Yes         | AppleScript can click named elements                         |
| Menu bar items             | Yes         | AppleScript can navigate menus                               |
| System tray / status items | Yes         | AppleScript menu bar 2                                       |
| Tray submenus              | Yes         | AppleScript can drill into submenus                          |
| **Webview content**        | **Partial** | AppleScript sees the native shell, not web content           |
| **Tauri webview**          | **No**      | WebKit doesn't expose Chrome DevTools                        |
| **Electron webview**       | **Yes**     | Enable remote debugging, use Chrome DevTools                 |
| Keyboard shortcuts         | Yes         | AppleScript keystroke                                        |
| File dialogs               | Partial     | AppleScript can interact with some, not all                  |
| Drag and drop              | Yes         | cliclick dd/du                                               |
| Dock interactions          | Yes         | AppleScript                                                  |
| **Native notifications**   | **Partial** | Can trigger them but can't interact with Notification Center |
| **Audio**                  | **No**      | Can't verify sound                                           |

### Workarounds

- **Tauri webview testing**: Test the web content separately via Playwright against the same URL the webview loads. Test the native shell (tray, window) via AppleScript.
- **Electron webview testing**: Launch with `--remote-debugging-port=9222`, then connect Chrome DevTools MCP for full web interaction within the native window.

## General Limitations

### Can never test programmatically

- **Haptic feedback** — no way to sense vibration
- **Audio output** — can't listen to sound
- **Visual polish** — screenshots show pixels but can't judge "does this look good" with nuance
- **Animation smoothness** — screenshots are static. Would need video recording + frame analysis
- **Network latency effects** — simulators have fast network. Use Network Link Conditioner for throttling
- **Real device behavior** — simulators/emulators differ from hardware (GPU, memory, thermal throttling)

### Can test but requires extra setup

- **Offline mode** — disable network on simulator: `xcrun simctl io booted setNetworkConditions` or airplane mode on Android
- **Slow network** — Network Link Conditioner (macOS) or `adb shell settings` for Android
- **Multiple devices** — run multiple simulators/emulators simultaneously
- **App updates / migrations** — install old version, populate data, install new version, verify migration

It is not acceptable to leave anything untested. The user must be informed so they can test themselves immediately and repeatedly
