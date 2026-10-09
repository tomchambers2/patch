# Electron-specific testing

The web tests cover the SPA inside the Electron window. This file covers the parts that only exist in the Electron wrapper.

## Launching with remote debugging

```bash
open -a "Patch" --args --remote-debugging-port=9222
sleep 3
curl -s http://localhost:9222/json/version | jq
```

Once `localhost:9222` is up, attach Chrome DevTools MCP (`mcp__chrome-devtools__*`) to it the same way you'd attach to a normal Chromium tab. All web-side assertions run unchanged.

## Tray menu

Use the AppleScript batch-script approach from `macos-desktop.md`. The tray icon belongs to process `Patch` (or `Patch Helper` — verify with `pgrep -lif Patch`). The menu is on `menu bar 2` (system status bar).

Things to assert:

- Icon present
- "Manager" row at the top (with phone + mic icons)
- Recent chats list (5 rows max)
- "Quit Patch"

## Global hotkey

⌃Space pops the voice-note overlay targeting Manager. Test:

```bash
osascript -e 'tell application "System Events" to keystroke " " using control down'
sleep 0.5
# Screenshot the overlay window via the macos-desktop.md window-id pattern
```

The overlay should appear on top of whatever was frontmost. Pressing Esc should dismiss without sending.

## Native notifications

Patch uses Electron's `Notification`. To verify a notification fired without trying to read OSX Notification Center (which can't be programmatically inspected), assert via the renderer:

- The Electron main process logs to `~/Library/Logs/Patch/main.log`. A successful `Notification` shows `[notification] shown { id, channel, title }`.
- `tail -n 20 ~/Library/Logs/Patch/main.log` after triggering a `patch_notify({channel:'desktop'})`.

## Auto-update

`electron-updater` reads `latest-mac.yml` from the GitHub Release. Test by:

1. Build version `0.0.1`, install, launch.
2. Build version `0.0.2`, publish to a draft Release.
3. From the running `0.0.1` instance, check `~/Library/Logs/Patch/main.log` for `update-available` (electron-updater logs it). The app downloads in the background and applies on next launch.

## Window lifecycle

- Cmd+W hides the window but keeps the Patch process alive (tray + hotkey still work).
- Cmd+Q quits the process entirely.
- Click tray icon while window is hidden → window restored.

## Known gaps

- Notification Center _content_ can't be inspected programmatically. Trust the main-log line.
- Auto-update can't be fully tested in CI without a public Release. The local test uses a private GitHub Release.
