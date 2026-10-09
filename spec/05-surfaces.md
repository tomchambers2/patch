# Surfaces

Client UIs that attach to chats. All surfaces speak the wire protocol (`03-wire-protocol.md`) over WebSocket to the server.

Per-surface detailed design lives in dedicated docs:

- `13-design-terminal.md` — the `patch` CLI (thin wrapper over the agent, Happy-style)
- `14-design-web.md` — web app SPA at `/app`
- `15-design-mobile.md` — Android-native (Expo/RN).

This doc covers shared surface concerns: presence, editor, QR linking, lifecycle.

## Terminal (`patch` CLI)

Portable Node binary. Runs on any machine the user has — it talks over WebSocket to the server, which routes to the host that owns the chat. Run on a host itself, it also reaches that host over the local socket (`17-cli.md` § Hosts and the CLI).

The commands are listed once, in `17-cli.md` § Commands: chats, hosts, jobs,
hooks, threads, surfaces, auth, the local host service, logs and diagnostics.
Host management works from any machine, with each `hosts` subcommand defaulting
to the machine the CLI is running on.

The TUI renders the wire event stream inline — messages, tool calls, tool results, permission prompts. Same UX feel as `claude` native; we just render events from a remote source.

## Web app

Static SPA served by the server (subpath `/app`).

- Chat list grouped by (host, folder) — projects emerge from folders, and a folder is only a project on the host it lives on, so the same path on two hosts stays two groups.
- Chat view with live message stream, editor pane (Monaco — the VS Code editor — read/write files in the chat's folder), voice button.
- Chat search by ID prefix.
- Job management UI: create/edit/delete jobs (see `08-triggers-and-jobs.md`).
- Presence heartbeat while tab is foregrounded.

## Phone app

- Android: native via Expo/React Native (matches Happy's stack for easy code reuse).
- Push notifications via Expo's push API (see `09-notifications.md`).
- Voice button per chat, Manager voice.

## Desktop notifier

Optional small process on Mac/Linux that subscribes to `notify` events with `channel: desktop` and shows OS-native notifications. Pure surface — connects to the server like any other client, doesn't host chats.

On macOS, a notification carrying `actions` (`09-notifications.md` § Notification actions) renders its Reply field and/or action buttons using the OS notification's own reply/action support. Tapping an action or submitting a reply hands the decision to the main Patch app — the desktop shell has no WS connection of its own to answer with, and the app does, including its guaranteed-delivery retry. A delivered action updates the notification to "Sent"; one that can't be delivered updates it to "Not sent — tap to retry", keeping the typed text, and tapping it again retries the same thing. Windows/Linux show the plain toast with no actions, since the OS has no equivalent affordance.

## Menu-bar (system tray) surface

A small native menu-bar item on macOS (system-tray equivalent on Linux/Windows). Always-on, lives even when the full app is closed. Reference mock: `design/web-hi-fi-menubar.html`. Two interactions:

- Click the icon → 360px dropdown panel with: a Manager row (with phone + mic affordances for voice call / voice note), a compact list of the most-recent active chats with status badges, and a single text input that fires as a user turn into Manager.
- Global hotkey (default: `⌃ Space`, user-configurable) → opens the voice-note overlay (see `07-voice-app.md` § Overlay surfaces) targeting Manager. Press-and-hold for hold-to-talk; tap once for toggle (Superwhisper-style).

The menu-bar surface is read-mostly and write-narrow — typing and voice are both scoped to Manager. Reading transcripts of other chats requires opening the full app (clicking a row in the dropdown launches it focused on that chat).

The menu-bar process is itself a surface — it speaks the wire protocol like any other client and emits `surface.heartbeat` while open. When the dropdown is closed but the icon is still visible, no heartbeat fires (the icon is OS chrome, not focus). Voice-note overlay session counts as foregrounded.

The mobile equivalent is OS-level (persistent foreground notification + launcher long-press shortcuts) — see `15-design-mobile.md` § Mobile equivalent of the menu bar.

### Desktop packaging (Electron)

The macOS desktop app (`@patch/desktop`) wraps the deployed web app in an Electron shell, plus the menu-bar surface above.

The app installs and manages a host on its own Mac as a separate OS service
with its own lifetime, and shows that host's status alongside every other host.
See `02-daemon.md` § Desktop app and the local host.

Only one desktop process may own a user profile. Launching another copy exits
that copy and shows the existing window, restoring it if minimised. The saved
sign-in survives duplicate launches and restarts.

#### Window placement

The main window reopens where it was left: same position, same size and on the
same display, after any restart, updates included. Placement is saved when the
window moves, resizes, hides or the app quits, and restored on launch. A window
that was maximised or full-screen comes back that way.

The only fallback is a display that no longer exists: the window then opens at
the default size, centred on the primary display. On a display that is still
attached but has changed resolution, the saved size is shrunk and the position
moved just enough to fit its work area. A missing or unreadable saved
placement is the first-run state and gets the default; it is not an error.

#### Window chrome

The shell's document windows — the main window and every window from
`14-design-web.md` § New windows — have no native title bar. The app runs to
the window's top edge. The window controls stay: the bar behind them is hidden
rather than the whole frame removed, so close, minimise and zoom still work.
Dropping the frame outright would leave no way to close a window at all, since
the shell's own close gesture only hides the main window.

This is a macOS behaviour. On a platform whose window controls do not survive
hiding the bar, the windows keep their native frame.

Two things follow for the SPA, which the shell tells whether its window has a
title bar:

- The window controls float over the app's top-left with nothing behind them,
  so the top row keeps a strip clear for them: the sidebar brand row while the
  sidebar is up, and the sidebar expand control plus the chat header while it
  is collapsed — which is also how a chat opened in its own window starts. They
  are pinned to that row's own centre-line, so the brand wordmark immediately
  right of them reads as part of the same row rather than staggered under it.
- With no title bar there is nothing left to drag the window by, so the sidebar
  brand row and the chat header are drag regions. Their controls, the folder
  crumb and the chat title opt back out, since a drag region does not pass
  clicks through to what is inside it. So does the sidebar expand control,
  which overlaps the chat header. The window folds these regions together in
  document order, each overriding what came before regardless of stacking, so
  an opted-out control that overlaps a drag region comes after it in the
  document.

The signed-out screen also keeps a full-width draggable strip at the top,
clear of its sign-in fields. A missing credential must never leave a window
immovable. Browser pages do not reserve this desktop strip.

The menu-bar popover and the voice overlay are separate: they have no title bar
and no window controls to begin with, so they reserve no strip.

Packaging invariants that must hold:

- Bootstrap must run when packaged. The `whenReady` bootstrap (window + tray + hotkeys) is gated so a test harness that imports `main.js` doesn't spawn windows. A packaged app is always the entry, but Electron loads `main` from `package.json` so `process.argv[1]` is not `main.js` — an argv-only entry check false-negatives and the app launches with no window ("won't launch"). The gate is therefore `app.isPackaged || isAppEntry()`.
- Ship the tray template icon. `createTray` reads `build/trayIconTemplate.png` (+ `@2x`) from inside the asar. The `files` glob must list them explicitly (it bundles `dist/**` + `package.json` only by default), else the asset is absent and the tray throws on every launch.
- App icon is `build/icon.png` — a green rounded square with a cream italic "p" (matches the web favicon's mark, square not circular). electron-builder generates the `.icns`.
- Auto-updater needs `app-update.yml`. That config only ships in real published dmg/zip builds; a local `--dir` dev build is packaged but has no update config, so the updater is skipped when the file is absent (no unhandled rejection).
- Local `--dir` builds skip signing, leaving a stale `Identifier=Electron` ad-hoc signature that Apple Silicon refuses to launch from Finder. Re-sign ad-hoc (`codesign --force --deep --sign -`) so the identifier becomes `io.github.tomchambers2.patch`; real release builds sign with the project's signing identity (`11-deployment.md` § Desktop code signing).

#### Desktop first run

No server address is built into the app. A launch with no remembered connection asks one question, in a window of its own: "On this Mac" or "On my server". The answer is remembered (`connection.json` in the app's data directory, 0600, with the app's credential on that server) and the question is not asked again; App menu → Switch Server… forgets it and asks on the next launch. Closing the question unanswered quits.

- On this Mac. The app runs a Patch server of its own and a host beside it, and nothing has to be installed. The server is the release the app carries, started with the app's own Node, listening on a loopback port chosen once and kept; its data lives in the app's data directory. The app makes the account, and sets this Mac up as a host with the host build the app carries, served from that server's own download channel like any other (`11-deployment.md` § Host installation). The server holds a relay channel (`10-auth.md` § Relay) so a phone can join it by QR from anywhere. Quitting the app stops the server. Choosing this again after Switch Server… picks the same account up. This app takes no updates from a server it runs itself; a newer app is installed over it.
- On my server. The user pastes the pairing code their server printed (`patch-server pair`, `11-deployment.md` § Server installation). A code naming the server's address pairs with it directly and loads its web app. A code naming a relay pairs through the relay and loads the web app from a loopback listener on this Mac that carries every request and WebSocket through the encrypted session (`10-auth.md` § Relay), so the page cannot tell. The app's updates come from the feed the connected server publishes.

A step that fails says why, on the question's own window, and the question is asked again. The page the shell loads receives the credential in the URL fragment (`/app/#credential=…`), which is never sent anywhere and is taken only inside the shell.

#### Runtime invariants

The shell's runtime invariants — window singleton ownership, the menu-bar
heartbeat gate, and readiness-gated main-to-renderer IPC — are recorded with their
failure modes in `docs/desktop-packaging.md`.

## Editor (inside web + phone surfaces)

- Monaco — the editor that powers VS Code, embedded via the standard package, using its built-in diff editor and editor.
- Scope: view files in the chat's folder, view unified diffs of tool edits, light editing (saves back to filesystem via host-mediated write). For quick peeks and corrections, not full IDE work.

## Presence

Every connected surface emits `surface.heartbeat` every 10s while foregrounded. Timeout 30s. Server tracks per-account "is any surface active right now?" used by notification routing.

Foregrounded = tab visible (web), app in foreground (phone), desktop notifier running (desktop). When all surfaces are backgrounded/absent for 30s, push-to-phone becomes the active notification channel. See `09-notifications.md`.

## QR-code linking

A linked surface shows a single-use pairing nonce as a QR and a short code; the new surface takes it and receives a server-issued credential bound to the account. Any linked surface can link another. See `10-auth.md` § Surface linking (QR flow).

### Canonical QR payload

Every surface-pairing QR — wherever it is generated (web Link a device, the phone's Link a device, `patch-server pair`, or `patch auth pair` on the CLI) — encodes the same payload: a `patch-pair://` URI. Adding a host uses the separate daemon-registration nonce (`10-auth.md` § Host registration), which a QR and a short code render identically and which the installer submits.

```
patch-pair://<host>?nonce=<nonce>[&s=http]
patch-pair://?nonce=<nonce>&relay=<wss url>&ch=<channel>&pk=<server key>
```

- The first names a server reached directly. `<host>` is the server's origin without its scheme (`patch.example.com`, `192.168.1.20:3000`); the scheme is https unless `s=http` says otherwise. The second names a server reached through a relay: `relay` is the relay's address, `ch` the channel and `pk` the server's public key, which the scanner pins (`10-auth.md` § Relay). A code names exactly one of the two.
- The server makes the code (`POST /api/auth/pair/start` answers with it): its public address when it has one, else its relay. A surface that draws a QR uses that code; failing that, the way it itself reaches the server.
- `<nonce>` is the single-use pairing nonce, percent-encoded.

The nonce is the only secret the code carries. The scanning (new) surface has no server of its own: the code is how it learns where to go, and it keeps that as its route once pairing has worked. It generates its own device keypair locally and sends only its public key to `/api/auth/pair/complete`. A scanner MUST reject any payload that is not a `patch-pair://` URI carrying a `nonce` and a server or a relay (no JSON, no bare token, no other scheme) and surface the error rather than silently retrying. This one format is binding on all generators and all scanners; divergence is a bug.

The phone's pairing screen also accepts the code pasted as text, so a device with no server yet and no camera access can still pair. A pasted code is validated exactly as a scanned one.

## Cross-refs

- Wire events each surface emits/receives: `03-wire-protocol.md`
- Notification rules: `09-notifications.md`
- Auth/trust: `10-auth.md`
- Voice button behaviour: `07-voice-app.md`
