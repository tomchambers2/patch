# Desktop packaging notes

Implementation notes for the Electron shell, kept out of `spec/` because they name
code, scripts and tool output. The spec states the behaviour; this states how it is
achieved on this machine.

## Code signing

The shell is signed with a self-signed certificate, not an Apple Developer ID.
This is not a shortcut — it is the difference between the updater working and not.

Why signing is mandatory. Squirrel.Mac refuses to apply an update to an
adhoc-signed app. The observed failure:

```
Code signature at URL file:///…/io.github.tomchambers2.patch.ShipIt/update.…/Patch.app/
did not pass validation: code has no resources but signature indicates they must be present
```

The app checks and downloads fine, then dies at install. `CSC_IDENTITY_AUTO_DISCOVERY=false`
in `build:desktop` is what produced that adhoc build, so the shell could not
self-update.

Why self-signed is sufficient. `codesign` generates a designated requirement of

```
identifier "io.github.tomchambers2.patch" and certificate root = H"<leaf hash>"
```

with no `anchor apple` clause, so Squirrel only requires an update to carry the
same certificate — Apple's is not special. Verified end-to-end: a self-signed
`0.1.323` app found `0.1.400` on the feed, downloaded it, passed validation
(`codesign --verify --strict -R=<the requirement>` → exit 0) and installed it on
quit. Squirrel applies a staged update when the app quits, not only via an
explicit quit-and-install — worth knowing before publishing a throwaway version.

The cost. Hardened runtime enforces that a process and the libraries it maps
share a Team ID, and a self-signed cert has none (`TeamIdentifier=not set`), so the
app cannot load its own Electron framework and crashes at launch with
`Library not loaded: @rpath/Electron Framework.framework/Electron Framework —
different Team IDs`. Fixed by `com.apple.security.cs.disable-library-validation` in
`build/entitlements.mac.plist`, which is a real if modest reduction in hardening.
A Developer ID would supply the Team ID and let that entitlement be removed.

Setup (machine-specific; the identity lives in the developer's login keychain):

1. Create a self-signed Code Signing certificate (Keychain Access → Certificate
   Assistant), or generate one with openssl. If exporting a `.p12` with OpenSSL 3.x
   you MUST use legacy algorithms — `-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
-macalg sha1` — because macOS `security import` cannot read the modern
   AES-256/SHA-256 default (`MAC verification failed`, Keychain Access `OSStatus -26276`).
2. Mark it Always Trust for code signing. Until trusted, macOS reports
   `CSSMERR_TP_NOT_TRUSTED` and both electron-builder and `codesign` refuse to use
   it — `codesign` will not sign with an untrusted identity even given its private
   key and `--keychain`.
3. Set `CSC_NAME` to the cert's common name in `scripts/local/deliver.mjs`.

Notarization stays off (`PATCH_SKIP_NOTARIZE=1`) — it needs a paid Apple account, and
these builds are installed by direct copy so nothing is ever quarantined. The
certificate expires; `pnpm ship desktop` refuses to publish if the identity is
missing from `security find-identity -v -p codesigning`, and asserts the built
bundle is non-adhoc and passes `codesign --verify --deep --strict` before shipping.

## Runtime invariants (caught by the integration smoke)

`scripts/smoke-integration.cjs` (`pnpm --filter @patch/desktop smoke:integration`) drives the real desktop-shell entry point on a live Electron runtime. The invariants that must hold:

- `createMainWindow()` owns the singleton. The factory must assign the module `mainWindow` itself. If it only returns the window, `getMainWindow()` stays null and every guarded site (`if (!mainWindow) mainWindow = createMainWindow()` — notification click, ⌃⇧Space call, `raiseMainWindow`, tray "Open Patch") spawns a second, orphaned main window.
- The menu-bar heartbeat gate is driven from imperative call sites rather than window events. `BrowserWindow.hide()` is unreliable on macOS — it genuinely hides the window yet the `'hide'` event frequently does not fire. So `patch:menubar-visibility` is sent from `showTrayPopover` (true) / `hideTrayPopover` (false), not `win.on('show'/'hide')`. Otherwise the dropdown closes but the renderer keeps beating `surface.heartbeat` forever.
- An update installs itself, and the install must actually quit. `update-downloaded` calls `installUpdate()` unconditionally — there is no "restart to install" prompt, because Patch deploys ~20x a day and the answer was always yes. That makes the `app.isQuitting` rule load-bearing rather than incidental: `quitAndInstall` closes every window and then quits, and the main window's `close` handler cancels any close it hasn't been told is a real quit, so without the flag ~20 prompts a day become ~20 silent app deaths on the old build. One wrapper (`quitAndInstallNow`, `updater.ts`) sets the flag, force-relaunches, and hands a refusal to the version panel.
- Main→renderer "start" IPC must be readiness-gated (`sendWhenReady`). A freshly created window's `loadURL` is async; a synchronous `webContents.send` right after creation is dropped because the renderer hasn't registered its listeners. The voice-note overlay is lazily created, so the first ⌃Space press would open the overlay without starting recording. Sends defer to `did-finish-load` while loading.
