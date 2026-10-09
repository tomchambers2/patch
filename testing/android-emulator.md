# Android Emulator Testing

## Prerequisites

| Tool                           | Purpose                                | Install                                        |
| ------------------------------ | -------------------------------------- | ---------------------------------------------- |
| Android SDK command-line tools | sdkmanager, avdmanager                 | `brew install --cask android-commandlinetools` |
| Java 17                        | Required by SDK tools                  | `brew install openjdk@17`                      |
| Android SDK components         | Emulator, platform-tools, system image | Via sdkmanager (see below)                     |

## Environment Variables

These must be set for every session:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

## Installing SDK Components

```bash
yes | sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" \
  "emulator" \
  "platforms;android-35" \
  "system-images;android-35;google_apis;arm64-v8a"
```

## Creating an AVD

avdmanager can be unreliable. Creating the AVD config manually is more reliable:

```bash
AVD_NAME="Pixel_7"
mkdir -p "$HOME/.android/avd/${AVD_NAME}.avd"

# INI pointer file
cat > "$HOME/.android/avd/${AVD_NAME}.ini" << EOF
avd.ini.encoding=UTF-8
path=$HOME/.android/avd/${AVD_NAME}.avd
path.rel=avd/${AVD_NAME}.avd
target=android-35
EOF

# Config file
cat > "$HOME/.android/avd/${AVD_NAME}.avd/config.ini" << EOF
AvdId=${AVD_NAME}
PlayStore.enabled=false
abi.type=arm64-v8a
avd.ini.displayname=Pixel 7
hw.cpu.arch=arm64
hw.cpu.ncore=4
hw.gpu.enabled=yes
hw.gpu.mode=auto
hw.lcd.density=420
hw.lcd.height=2400
hw.lcd.width=1080
hw.ramSize=4096
image.sysdir.1=$ANDROID_HOME/system-images/android-35/google_apis/arm64-v8a/
tag.display=Google APIs
tag.id=google_apis
EOF

# Verify
$ANDROID_HOME/emulator/emulator -list-avds
```

## Booting the Emulator

```bash
# With GUI
$ANDROID_HOME/emulator/emulator -avd Pixel_7 &

# Headless (for CI / background testing)
$ANDROID_HOME/emulator/emulator -avd Pixel_7 -no-window -no-audio &

# Wait for boot
$ANDROID_HOME/platform-tools/adb wait-for-device
# Poll until fully booted:
$ANDROID_HOME/platform-tools/adb shell getprop sys.boot_completed
# Returns "1" when ready
```

## Building and Running Apps

### Expo / React Native

```bash
npx expo run:android
# Or if already built:
npx expo start --port 8081
$ADB shell am start -n <package>/.MainActivity
```

### Native Android

```bash
./gradlew installDebug
$ADB shell am start -n <package>/<activity>
```

## The Testing Loop

### 1. Read the UI tree

```bash
$ADB exec-out uiautomator dump /dev/tty
```

Parse the XML to find element coordinates:

```bash
$ADB exec-out uiautomator dump /dev/tty | python3 -c "
import sys, re
xml = sys.stdin.read()
for m in re.finditer(r'text=\"([^\"]*?)\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"', xml):
    text, x1, y1, x2, y2 = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
    if text:
        print(f'\"{text}\" @ ({(x1+x2)//2}, {(y1+y2)//2})')
"
```

### 2. Tap an element

```bash
$ADB shell input tap <x> <y>
```

### 3. Take a screenshot

```bash
$ADB exec-out screencap -p > /path/to/output.png
```

## Other Interactions

```bash
# Swipe / scroll down
$ADB shell input swipe 540 1500 540 500

# Swipe / scroll up
$ADB shell input swipe 540 500 540 1500

# Type text
$ADB shell input text "hello world"

# Press keys
$ADB shell input keyevent KEYCODE_HOME
$ADB shell input keyevent KEYCODE_BACK
$ADB shell input keyevent KEYCODE_ENTER

# Long press (swipe with no movement, 1000ms duration)
$ADB shell input swipe 540 960 540 960 1000
```

## App Lifecycle

```bash
# Launch
$ADB shell am start -n <package>/<activity>

# Force stop
$ADB shell am force-stop <package>

# Open a URL / deep link
$ADB shell am start -a android.intent.action.VIEW -d "myapp://path"
```

## Permissions

```bash
# Grant a permission
$ADB shell pm grant <package> android.permission.POST_NOTIFICATIONS

# Revoke a permission
$ADB shell pm revoke <package> android.permission.POST_NOTIFICATIONS

# List granted permissions
$ADB shell dumpsys package <package> | grep "granted=true"
```

## Coordinate System

Android ADB uses **pixels**, not density-independent points:

- Pixel 7 AVD: 1080 × 2400 pixels at 420dpi

This is different from iOS which uses points. Don't mix them up.

## Key Gotchas

- **uiautomator dump is slow** — takes 2-3 seconds. Don't call it in a tight loop.
- **No simulated push notifications** — unlike iOS, Android has no `simctl push` equivalent. You must rely on local notifications or FCM test messages.
- **SCHEDULE_EXACT_ALARM** — on Android 12+, apps need this permission for precise notification scheduling. May need manual grant via Settings or ADB.
- **First boot is slow** — 1-2 minutes for the emulator to fully boot. Be patient.
- **React Native accessibility** — same issue as iOS: add `accessibilityLabel` to elements you need to target.
