# macOS Desktop App Testing

Testing native macOS apps — including Tauri, Electron, and native Swift/AppKit apps — using batch test scripts with AppleScript, Accessibility APIs, and screenshot tools.

## The Focus Problem

AppleScript and cliclick **steal focus** from whatever the user is doing. This means:

- The user can't work while tests run
- Clicking elsewhere closes tray menus mid-test, causing false failures
- Interactive back-and-forth testing (read UI → tap → screenshot → repeat) is disruptive

**Solution: batch test scripts.** Write a single shell script that does all interactions in one fast burst, then returns focus to the previous app. This minimizes disruption to ~10-15 seconds.

## Recommended Approach: Batch Test Script

Instead of running AppleScript commands one at a time, write a test script that:

1. Saves the currently focused app
2. Runs all tests sequentially without pausing
3. Returns focus when done

### Script template

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="My App"
PROCESS_NAME="my-app"
APP_PATH="/Applications/My App.app"
SCREENSHOT_DIR="test-screenshots"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS=""

pass() { RESULTS="${RESULTS}PASS: $1\n"; echo "  ✓ $1"; }
fail() { RESULTS="${RESULTS}FAIL: $1\n"; echo "  ✗ $1"; }

mkdir -p "$SCREENSHOT_DIR"

# Save current focus
PREVIOUS_APP=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null || echo "Finder")

echo "=== Desktop Test Suite ==="

# ─── Tests go here ──────────────────────────────────────

# 1. Launch
pkill -x "$PROCESS_NAME" 2>/dev/null || true
sleep 1
open "$APP_PATH"
sleep 4
pgrep -x "$PROCESS_NAME" > /dev/null && pass "App launched" || fail "App did not launch"

# 2. Screenshot (doesn't need focus)
WINDOW_ID=$(swift -e '
import Foundation; import CoreGraphics
let wl = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
var best = -1; var area = 0
for w in wl {
  guard let o = w["kCGWindowOwnerName"] as? String, o == "'"$APP_NAME"'",
        let b = w["kCGWindowBounds"] as? [String: Any],
        let W = b["Width"] as? Int, let H = b["Height"] as? Int,
        W > 200, H > 200, let id = w["kCGWindowNumber"] as? Int
  else { continue }
  if W*H > area { area = W*H; best = id }
}
if best >= 0 { print(best) } else { exit(1) }
' 2>/dev/null || echo "")
if [[ -n "$WINDOW_ID" ]]; then
  screencapture -l "$WINDOW_ID" -o "$SCREENSHOT_DIR/desktop-${TIMESTAMP}.png"
  pass "Window screenshot saved"
else
  fail "Could not find window"
fi

# 3. Tray menu (needs focus — do it fast)
# ... AppleScript interactions ...

# ─── Return focus ───────────────────────────────────────

osascript -e "tell application \"$PREVIOUS_APP\" to activate" 2>/dev/null || true

# ─── Summary ────────────────────────────────────────────

PASS_COUNT=$(echo -e "$RESULTS" | grep -c "^PASS:" || true)
FAIL_COUNT=$(echo -e "$RESULTS" | grep -c "^FAIL:" || true)
echo "Passed: $PASS_COUNT, Failed: $FAIL_COUNT"
```

## Prerequisites

| Tool      | Purpose                                    | Install                  |
| --------- | ------------------------------------------ | ------------------------ |
| osascript | AppleScript automation (built into macOS)  | Pre-installed            |
| cliclick  | Mouse click/move at coordinates (fallback) | `brew install cliclick`  |
| swift     | Finding window IDs via CoreGraphics        | Pre-installed with Xcode |

## Screenshots (no focus needed)

Screenshots via `screencapture -l <windowID>` work **without stealing focus** — they capture by window ID regardless of which app is frontmost. Use these freely for visual verification.

### Find window ID

```bash
# Replace APP_NAME with the actual window owner name
swift -e '
import Foundation; import CoreGraphics
let wl = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
var best = -1; var area = 0
for w in wl {
  guard let o = w["kCGWindowOwnerName"] as? String, o == "APP_NAME",
        let b = w["kCGWindowBounds"] as? [String: Any],
        let W = b["Width"] as? Int, let H = b["Height"] as? Int,
        W > 200, H > 200, let id = w["kCGWindowNumber"] as? Int
  else { continue }
  if W*H > area { area = W*H; best = id }
}
if best >= 0 { print(best) } else { exit(1) }
'
```

### Capture

```bash
screencapture -l "$WINDOW_ID" -o /path/to/screenshot.png
```

## AppleScript Interactions (needs focus)

All of these steal focus. Use them inside batch scripts, not interactively.

### System tray / menu bar

```bash
# Read tray menu contents
osascript -e '
tell application "System Events"
  tell process "My App"
    click menu bar item 1 of menu bar 2
    delay 1.0
    set menuItems to every menu item of menu 1 of menu bar item 1 of menu bar 2
    set output to ""
    repeat with mi in menuItems
      try
        set n to name of mi
        try
          set sc to count of menu items of menu 1 of mi
          set output to output & n & " [submenu:" & sc & "]" & linefeed
        on error
          set output to output & n & linefeed
        end try
      on error
        set output to output & "(separator)" & linefeed
      end try
    end repeat
    key code 53
    return output
  end tell
end tell
'
```

**Important**: Use `delay 1.0` (not 0.3 or 0.5) after clicking the tray icon. Shorter delays cause the menu to not fully render before enumeration, leading to flaky failures.

### Navigate tray submenus

```bash
osascript -e '
tell application "System Events"
  tell process "My App"
    click menu bar item 1 of menu bar 2
    delay 0.5
    click menu item "Submenu Label" of menu 1 of menu bar item 1 of menu bar 2
    delay 0.3
    click menu item "Item" of menu 1 of menu item "Submenu Label" of menu 1 of menu bar item 1 of menu bar 2
  end tell
end tell
'
```

### Window management

```bash
# Close window (Cmd+W)
osascript -e '
tell application "System Events"
  tell process "My App"
    set frontmost to true
    keystroke "w" using command down
  end tell
end tell
'

# Check window count
osascript -e '
tell application "System Events"
  tell process "My App"
    return count of windows
  end tell
end tell
'

# Get window position and size
osascript -e '
tell application "System Events"
  tell process "My App"
    set p to position of window 1
    set s to size of window 1
  end tell
end tell
return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
'

# Resize window
osascript -e '
tell application "System Events"
  tell process "My App"
    set size of window 1 to {800, 600}
  end tell
end tell
'
```

### Click buttons and menu items

```bash
# Click a button by name
osascript -e '
tell application "System Events"
  tell process "My App"
    click button "OK" of window 1
  end tell
end tell
'

# Click a menu bar item (menu bar 1 = app menu)
osascript -e '
tell application "System Events"
  tell process "My App"
    click menu item "Preferences..." of menu "My App" of menu bar 1
  end tell
end tell
'
```

## Webview-Based Apps (Tauri, Electron)

Apps built with Tauri or Electron render web content in a native window. Test at two levels:

### Level 1: Native shell (window, tray, menus)

Use the batch script approach above. This tests the real native experience — what the user actually sees and interacts with.

### Level 2: Webview content

- **Tauri**: Uses WebKit. No Chrome DevTools access. Test the web content separately via Playwright against the same URL the webview loads (production URL or localhost dev server).
- **Electron**: Uses Chromium. Launch with `--remote-debugging-port=9222`, then use Chrome DevTools MCP for full interaction within the native window.

For Tauri, the webview is effectively the same as the web deployment, so testing it via the web URL gives equivalent coverage of the web content. The batch script covers everything the web tests can't: tray menus, window lifecycle, native app behavior.

## Mouse Automation with cliclick (fallback)

When AppleScript can't reach a UI element (canvas, custom views):

```bash
cliclick c:500,300      # Click
cliclick dc:500,300     # Double-click
cliclick rc:500,300     # Right-click
cliclick m:500,300      # Move mouse
cliclick dd:500,300 du:600,400  # Drag
```

**Warning**: cliclick uses absolute screen coordinates. On multi-monitor setups, coordinates can be offset. Always check window position first.

## App Lifecycle

```bash
# Launch
open "/Applications/My App.app"

# Quit gracefully
osascript -e 'tell application "My App" to quit'

# Force quit
pkill -x "my-app-binary-name"

# Check if running
pgrep -x "my-app-binary-name"

# Activate (bring to front)
osascript -e 'tell application "My App" to activate'

# Hide
osascript -e 'tell application "System Events" to set visible of process "My App" to false'
```

## Key Gotchas

- **Batch everything**: Never run AppleScript interactions one-at-a-time during a conversation. The user will click somewhere and break your test. Write a script, run it once.
- **Delay after tray click**: Use `delay 1.0` after clicking a tray icon. The menu takes time to render. `delay 0.3` causes flaky failures.
- **Accessibility permissions**: AppleScript needs "Accessibility" permission in System Settings > Privacy. The terminal running the commands must be allowed.
- **Menu bar 1 vs menu bar 2**: `menu bar 1` = app's main menu (File, Edit...). `menu bar 2` = system status bar (right side, where tray icons live).
- **Tauri webview isolation**: Can't use Chrome DevTools MCP on Tauri's WebKit webview. Test web content separately.
- **Multi-monitor**: cliclick screen coordinates are absolute. Check window position to calculate offsets.
- **Close vs Quit**: Many desktop apps hide the window on close (Cmd+W) but keep the process running. Test both behaviors: `pgrep` to check process, window count to check visibility.
