# Manual test plan — @patch/mobile (group 21)

End-to-end coverage that Maestro can't reach. Run on a physical Android
device (Pixel preferred) with the latest preview APK installed.

## Pre-flight

- [ ] `google-services.json` is present in `apps/mobile/` for the build
      under test. **NO FALLBACK** — its absence must fail the build.
- [ ] The test account has at least one active chat plus the special
      Manager thread (`thread_manager`).
- [ ] Host is healthy (Settings → Host shows "Online").
- [ ] Phone is logged in: Settings → Account → accountId visible.

## A. ConnectionService incoming-call (Manager)

1.  Background the app (home button — don't kill).
2.  From a desktop or CLI surface call `patch_call({ chatId: 'thread_manager' })`.
    - Expect: phone shows the **system incoming-call UI** (not just the
      patch in-app banner).
    - Lock screen: full-screen incoming call appears even with the screen
      off.
3.  Tap **Accept**.
    - Expect: app foregrounds into the **voice-call overlay**, timer
      ticking, mute + end-call buttons present.
    - Other media (Spotify, etc.) ducks during the call.
4.  Tap **End call**.
    - Expect: overlay closes, foreground service notification is removed.

Repeat with **Decline**:

5.  Trigger the call again, tap **Decline** in the system UI.
    - Expect: `chat.call_response { decision: 'decline' }` reaches the
      server (verify in host logs).
6.  Trigger the call again and **don't answer for 30s**.
    - Expect: server times out, falls back to a normal push notification
      with the original `reason` text.

## B. Push notifications

1.  Background the app.
2.  Trigger `patch_notify({ channel: 'push', message: 'manual test' })`
    from another surface.
    - Expect: standard system notification with the message body.
3.  Tap the notification.
    - Expect: app deep-links into the source chat detail.
4.  Foreground the app, repeat the notify (non-urgent).
    - Expect: notification suppressed (heartbeat-based suppression
      server-side).
5.  Repeat with `priority: 'urgent'`.
    - Expect: notification fires even while foregrounded.

## C. Voice-note (PTT) overlay

1.  Long-press the **Voice** bottom-tab button.
    - Expect: dark capsule overlay slides in, ripple animation around the
      mic icon, "Recording…" header.
2.  Speak a sentence, then release / tap **Send**.
    - Expect: overlay dismisses; transcript appears as a user message in
      the Manager thread.
3.  Long-press a chat row (any chat).
    - Expect: action sheet with `Send voice note` option; selecting it
      triggers the same overlay targeted at that chat.
4.  Tap × to cancel.
    - Expect: no message sent; overlay dismisses.

## D. Voice-call overlay (sustained)

The composer mic does NOT open this overlay — a tap there starts inline
dictation into the composer input instead (spec/07 § "Dictation into the
composer"; overlay-placement table says so explicitly: "Composer mic
(mobile or web/desktop chat) → None"). That's covered by
`maestro/flows/dictation.yml`, not here. The call/hands-free overlay is
reached from the phone icons in a chat's header.

1.  Open any chat detail. Tap the header's **phone icon** ("Start voice
    call").
    - Expect: full-screen voice-call overlay opens; audio focus requested
      (other media ducks); foreground service notification appears in the
      shade.
2.  Lock the screen.
    - Expect: foreground service keeps audio alive; overlay re-attaches
      on unlock.
3.  Tap **Mute** → speak → tap to unmute → tap **End**.
    - Expect: mute toggle visible; end terminates the WSS audio session.
4.  Repeat from the Manager row's **Call** / **Hands-free** buttons on the
    Chats tab.
    - Expect: same overlay, targeted at the Manager thread.

## E. QR pairing

1.  Fresh install (or Settings → Log out).
    - Expect: app opens to the **Pair this device** screen.
2.  On a linked desktop, run `patch pair`. A QR with a JSON payload
    `{ nonce: '…' }` displays.
3.  Point the phone camera at the QR.
    - Expect: the app posts to `/api/auth/pair/complete`, persists the
      returned JWT, and lands on the Chats tab.
4.  Verify Settings → Linked devices now lists the new mobile surface.

## F. Offline / reconnect

1.  Toggle aeroplane mode.
    - Expect: amber "Reconnecting…" banner at the top of the chat list;
      composer disabled in chat detail.
2.  Re-enable network.
    - Expect: banner clears; events that arrived during the outage
      replay (verify by checking that any messages sent from another
      surface during the gap appear in the chat).

## G. Settings sub-screens

1.  Settings → Jobs — list of jobs renders with toggles.
2.  Disable a job; verify it's disabled on another surface.
3.  Settings → Linked devices → revoke a desktop surface.
    - Expect: the desktop's WS disconnects + it returns to the pairing
      screen on next launch.

## H. Long-press launcher shortcuts

1.  From the Android launcher, long-press the patch icon. - Expect: shortcuts: `Manager voice note`, `New chat`, `Open
Speakers`. Wired via the `android.app.shortcuts` manifest meta-data +
    `res/xml/shortcuts.xml`, installed by the `withConnectionService`
    Expo config plugin. Each launches `MainActivity` with a `patch://`
    deep link that `app/_layout.tsx` resolves (`Manager voice note`
    opens the global voice-note overlay; `New chat` opens the new-chat
    folder picker; `Open Speakers` deep-links the Speakers thread).

## Sign-off

Tester: **\*\*\*\***\_\_**\*\*\*\*** Date: \***\*\_\_\_\*\***
Build: **\*\*\*\***\_\_\_**\*\*\*\*** Host SHA: \***\*\*\*\*\***\_\_\***\*\*\*\*\***
