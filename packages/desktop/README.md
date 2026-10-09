# @patch/desktop

Patch's macOS desktop shell — a thin Electron wrapper around the web SPA.
Reference: `spec/05-surfaces.md` § Menu-bar surface, `spec/14-design-web.md`
§ Menu-bar surface, `spec/18-tech-stack.md` § Desktop shell.

## What it gives you

- **Main window** loading the deployed SPA (`PATCH_SERVER_URL`) in
  production, or the vite dev server (`http://localhost:5173/app/`) in dev.
- **Tray icon** in the macOS menu bar:
  - Click → 360px popover (manager row + recent chats + manager input,
    matching `design/web-hi-fi-menubar.html`).
  - Right-click → context menu with `Open Patch` / `Quit Patch`.
- **Global hotkey** `⌃ Space` opens a small frameless voice-note overlay
  targeting Manager. Registered via Electron's `globalShortcut`.

  > **Conflict warning**: macOS uses `⌃ Space` by default for "Select
  > previous input source". Override the Patch hotkey via the
  > `PATCH_GLOBAL_HOTKEY` env var (e.g. `Alt+Space`,
  > `CommandOrControl+Shift+P`) — see Electron `globalShortcut` accelerator
  > syntax.

- **Native macOS notifications** via `electron`'s `Notification` API. Click
  the toast → focus the app and navigate to the originating chat.
- **Auto-update** via `electron-updater` reading from the GitHub Release
  attached to the patch repo.
- **Lifecycle**: Cmd+W hides (tray + hotkey stay alive); Cmd+Q quits.

## Scripts

| Script                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @patch/desktop build`             | Compile main + preload TS via `tsc -b` → `dist/main.js`, `dist/preload.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm --filter @patch/desktop dev`               | Build + launch Electron against the dev SPA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm --filter @patch/desktop test`              | `node:test` smoke checks against the source-level contracts.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm --filter @patch/desktop smoke`             | Real-Electron smoke: boots Electron, creates the Tray, loads the 360px `/menubar` popover + `/voice-overlay`, registers ⌃Space/⌃⇧Space against the live API (needs the dev SPA on :5173). Prints `SMOKE_RESULT` JSON; exit 0 = pass.                                                                                                                                                                                                                                                                             |
| `pnpm --filter @patch/desktop smoke:integration` | Real-Electron **integration** smoke: drives the ACTUAL `main.ts` exports (createMainWindow, onGlobalVoiceNote/CallHotkey, raiseMainWindow, bootstrap, tray click, IPC) and asserts genuine side effects — window singleton, Cmd+W hide, tray→360px popover toggle, the menu-bar heartbeat gate, Manager-targeted voice IPC delivery, notification→navigate, external-link routing, lifecycle. Loads the deployed SPA by default (`PATCH_SERVER_URL` overrides). Prints `INTEGRATION_RESULT` JSON; exit 0 = pass. |
| `pnpm --filter @patch/desktop smoke:iab`         | Real-Electron **in-app browser** smoke (patch/todo.md "In-app browser like Claude"): opens external links in the embedded `WebContentsView` panel and asserts the toolbar/page layout, the `window.iab` bridge, resize re-layout, same-panel reuse, back/forward/reload/open-in-browser/close IPC, and that links never leak to the real browser. Prints `IAB_RESULT` JSON; exit 0 = pass.                                                                                                                       |
| `pnpm --filter @patch/desktop dist:dry`          | Run `electron-builder --dir` (no .dmg) to validate the config.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm --filter @patch/desktop dist`              | Full release: `.dmg` + `.zip` + `latest-mac.yml` (requires signing).                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Codesigning + notarisation

`electron-builder.yml` is wired for the macOS hardened runtime + notary
service. The build reads these env vars (don't commit them):

| Variable                      | Purpose                                |
| ----------------------------- | -------------------------------------- |
| `APPLE_ID`                    | Apple Developer Apple-ID               |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for `notarytool` |
| `APPLE_TEAM_ID`               | Developer Team ID                      |
| `CSC_LINK`                    | Path or base64 `.p12` certificate      |
| `CSC_KEY_PASSWORD`            | `.p12` password                        |

NO FALLBACK: any missing var at `pnpm dist` time fails the build loudly.

The entitlements live at `build/entitlements.mac.plist` — JIT for V8,
microphone for the voice overlay, and network client.

## Auto-update

The shell checks the feed at launch and hourly in packaged builds, and
`window.patch.checkAndInstallUpdate()` makes a landed deploy trigger a
check immediately. Anything downloaded installs itself and relaunches —
there is no restart prompt and no renderer-side install control (see
`quitAndInstallNow` in `src/updater.ts`). The publish target in
`electron-builder.yml` points at `tomchambers2/patch` — `pnpm dist`
attaches the `.dmg` + `latest-mac.yml` artifacts to the matching release.

## Manual smoke (not in CI)

End-to-end tray click → popover, hotkey press → voice overlay, and
notification → app focus all need a headed Electron run. The vitest
smoke tests assert the source-level contracts (`createMainWindow`,
`globalShortcut.register('Control+Space')`, etc.); the visual smoke is
manual:

```sh
pnpm --filter @patch/desktop dev
# In another tab: open the SPA in the dev server (http://localhost:5173/app)
# Click the tray, ⌃Space the hotkey, and verify the desktop notification.
```

## What's not in this group

- Linux + Windows targets — config stays generic but disabled per spec/18.
- Voice WSS audio capture inside the overlay — group 17 (web) ports here.
