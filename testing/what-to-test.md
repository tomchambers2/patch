# What To Test — Comprehensive Checklist

This checklist applies to any app across all platforms (iOS, Android, macOS desktop). Not every item applies to every app — skip what's irrelevant. The point is to not forget things.

## Core UI

- [ ] App launches without crash
- [ ] All screens/views render correctly
- [ ] All text is visible and not truncated
- [ ] Dark mode / light mode appearance (if supported)
- [ ] Scroll behavior — content scrolls, doesn't bounce incorrectly
- [ ] Safe area handling (status bar, notch, home indicator on iOS)
- [ ] Landscape orientation (if supported)
- [ ] Keyboard appears and doesn't cover input fields
- [ ] Keyboard dismisses when expected

## Every Interactive Element

For each button, input, toggle, picker, or link in the app:

- [ ] Tap/click it — does it respond?
- [ ] Does the visual state change (highlight, selection, focus ring)?
- [ ] Does the expected action happen?
- [ ] Tap it again — does it toggle/deselect/undo correctly?
- [ ] Tap rapidly — does it break or duplicate actions?
- [ ] Tap while loading — does it handle the race?

## Navigation

- [ ] Navigate to every screen
- [ ] Back navigation works from every screen
- [ ] Deep links open the correct screen
- [ ] Tab bar / bottom navigation highlights the correct tab
- [ ] Swipe-back gesture (iOS)
- [ ] Hardware back button (Android)
- [ ] Navigation doesn't leave orphan screens in the stack

## Data Input

- [ ] Text input — type, edit, clear, paste
- [ ] Numeric input — keyboard type is correct (number pad vs full keyboard)
- [ ] Form validation — empty fields, invalid values, boundary values
- [ ] Form submission — data saves correctly
- [ ] Form pre-population — editing existing data shows current values
- [ ] Picker/dropdown selection
- [ ] Date/time picker
- [ ] Toggle/switch
- [ ] Slider
- [ ] Multi-select

## Data Display

- [ ] List renders with correct data
- [ ] List handles 0 items (empty state)
- [ ] List handles many items (performance, scroll)
- [ ] Data refreshes after changes
- [ ] Stale data doesn't persist after updates
- [ ] Timestamps display in correct timezone and format
- [ ] Numbers format correctly (decimals, units, currency)

## Data Persistence

- [ ] Created data appears in the correct list/view
- [ ] Edited data reflects changes everywhere
- [ ] Deleted data disappears from all views
- [ ] Data survives app restart (cold start)
- [ ] Data survives background/foreground cycle
- [ ] Data syncs to remote server (if applicable)
- [ ] Sync errors are displayed to the user
- [ ] Offline changes sync when connectivity returns (if applicable)
- [ ] Conflict resolution between local and remote data

## Notifications (Mobile)

- [ ] Permission dialog appears on first launch
- [ ] "Allow" grants permission and notifications work
- [ ] "Don't Allow" is handled gracefully (no crashes, degraded UX explained)
- [ ] Local notifications fire at scheduled times
- [ ] Notification banner shows correct title and body
- [ ] Notification category and action buttons appear (long-press on iOS)
- [ ] Tapping a notification opens the app to the correct screen
- [ ] Action buttons work (e.g., "Yes", "No", "Snooze")
- [ ] Notifications don't fire after being cancelled
- [ ] Rescheduling works when settings change
- [ ] Badge count updates (if used)
- [ ] Notification sound plays (if used)
- [ ] Notifications work when app is in foreground
- [ ] Notifications work when app is backgrounded
- [ ] Notifications work when app is killed

## Notifications (Desktop)

- [ ] macOS notification permission granted
- [ ] Native notifications appear in Notification Center
- [ ] Notification actions work
- [ ] Do Not Disturb respects the setting

## System Tray / Menu Bar (Desktop)

- [ ] Tray icon appears
- [ ] Tray icon shows correct image
- [ ] Clicking tray icon opens menu
- [ ] All menu items are present and correctly labeled
- [ ] Submenus open correctly
- [ ] Menu actions trigger the correct behavior
- [ ] Menu reflects current app state (dynamic items update)
- [ ] "Quit" exits the app
- [ ] "Open" shows the main window

## App Lifecycle

- [ ] Fresh install — app seeds default data
- [ ] Cold start (app was killed) — loads correctly
- [ ] Warm start (app was backgrounded) — resumes correctly
- [ ] Background → foreground — data refreshes
- [ ] Foreground → background — pending work is saved/finalized
- [ ] Close window (desktop) — expected behavior (hide vs quit)
- [ ] Reopen from dock/taskbar (desktop)
- [ ] App update — data migration works
- [ ] Data migration from old format to new format

## Network & Sync

- [ ] API calls succeed and data appears
- [ ] API errors show user-friendly messages
- [ ] Timeout handling — slow network doesn't freeze the app
- [ ] Retry logic — transient failures recover
- [ ] Offline state — app is usable without network
- [ ] Sync status indicator — user knows if data is synced
- [ ] Concurrent edits — multiple devices don't corrupt data
- [ ] Large payloads — don't crash or truncate

## Permissions

- [ ] Camera permission (if used)
- [ ] Location permission (if used)
- [ ] Notification permission
- [ ] Contacts/calendar permission (if used)
- [ ] Storage permission (Android)
- [ ] Permission denied — app handles gracefully
- [ ] Permission revoked mid-session — app handles gracefully

## Error Handling

- [ ] Network failure doesn't crash
- [ ] Invalid server response doesn't crash
- [ ] Corrupted local data doesn't crash (AsyncStorage, SQLite, etc.)
- [ ] Out of memory / disk space — handled gracefully
- [ ] Unexpected null/undefined values in data

## Performance

- [ ] App launch time — under 3 seconds
- [ ] Screen transitions — smooth, no jank
- [ ] Scrolling long lists — 60fps, no dropped frames
- [ ] Memory usage doesn't grow unbounded
- [ ] Battery drain — no excessive background activity

## Platform-Specific

### iOS

- [ ] Safe area insets (Dynamic Island, home indicator)
- [ ] Swipe-back gesture
- [ ] Haptic feedback (if used)
- [ ] App Tracking Transparency (if used)
- [ ] iOS version compatibility

### Android

- [ ] Back button behavior
- [ ] Material Design conventions respected
- [ ] Edge-to-edge display
- [ ] Different screen sizes and densities
- [ ] Android version compatibility (API level)
- [ ] SCHEDULE_EXACT_ALARM permission (for notifications)

### macOS

- [ ] Window resizing
- [ ] Full screen mode
- [ ] Keyboard shortcuts
- [ ] Menu bar integration
- [ ] Dock icon behavior
- [ ] Close vs Quit behavior (Cmd+W vs Cmd+Q)

## How to Use This List

1. **Before testing**: Read through and mentally mark which items apply to your app
2. **During testing**: Work through each applicable item. For each one:
   - Read the UI tree / take a screenshot
   - Perform the action
   - Verify the result
   - Document any failures
3. **After testing**: Summarize what passed, what failed, and what couldn't be tested
4. **Be honest**: If you didn't test something, say so. "Untested" is better than "assumed working"
