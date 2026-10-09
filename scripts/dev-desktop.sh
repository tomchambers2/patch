#!/usr/bin/env bash
# dev-desktop.sh — run the INSTALLED /Applications/Patch.app against the LOCAL
# dev stack, so every code change auto-syncs into the desktop app via Vite HMR.
#
# Why this works without rebuilding the .app: the desktop shell is a thin
# Electron wrapper that just loads a URL (packages/desktop/src/main.ts). It
# already honours the PATCH_SERVER_URL env override AND preserves a `?credential=`
# query on it (the dev-auth bypass, packages/web/src/lib/credential.ts). So we
# launch the existing installed binary with PATCH_SERVER_URL pointed at the
# local vite dev server — no `pnpm dist`, no copy into /Applications. The .app
# bundle never has to change for a UI edit; the UI it shows is whatever the
# local server serves, hot-reloaded.
#
# What "auto-sync" means after this:
#   - Web / UI changes (the vast majority): live in the app on save via HMR.
#   - Desktop SHELL changes (main.ts: hotkeys, windows): re-run this script.
#
# Usage:
#   scripts/dev-desktop.sh                # boot/reuse the stack (+host), launch the app
#   scripts/dev-desktop.sh --real         # host in real Claude mode (genuine completions)
#   scripts/dev-desktop.sh --no-daemon    # shell only — no Manager/chats (rarely wanted)
#   scripts/dev-desktop.sh --stop         # stop the dev stack (and quit the app)
#
# A host runs BY DEFAULT (mock backend): the Manager/Telegram/Speakers threads
# are bootstrapped by the host, so without one the app shows no Manager.
#
# NO FALLBACKS: any failed step aborts loudly; a missing installed app is a hard
# error (build+install it once with `pnpm --filter @patch/desktop dist`).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_BIN="/Applications/Patch.app/Contents/MacOS/Patch"
SERVER_PORT="${PATCH_SERVER_PORT:-3000}"
WEB_PORT=5173
# The default `.dev-data` registry predates this session's auth rework and is
# schema-incompatible (its account record has no userPrivateKey, so surface-JWT
# minting fails). `.dev-data-ui` is the clean, current-schema dev registry.
# Override with PATCH_DATA_DIR if you maintain your own.
DATA_DIR="${PATCH_DATA_DIR:-$ROOT/.dev-data-ui}"
export PATCH_DATA_DIR="$DATA_DIR"
URL_FILE="$DATA_DIR/.web-url.txt"

quit_app() { osascript -e 'quit app "Patch"' >/dev/null 2>&1 || true; }

if [[ "${1:-}" == "--stop" ]]; then
  quit_app
  scripts/dev-web-auth.sh --stop
  exit 0
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: $APP_BIN not found." >&2
  echo "       Build+install the desktop app once first:" >&2
  echo "         pnpm --filter @patch/desktop dist" >&2
  exit 1
fi

# A host is booted BY DEFAULT: the special threads (Manager, Telegram,
# Speakers) are bootstrapped/replayed by the host on connect, so without one
# the app has no Manager and `/` falls through to the empty state — a confusing
# "everything disappeared" view. Pass --no-daemon for a chat-less shell only.
DAEMON_HEALTHZ_PORT="${PATCH_DAEMON_HEALTHZ_PORT:-3011}"
WANT_DAEMON=1
BOOT_ARGS=(--with-daemon)
for a in "$@"; do
  case "$a" in
    --no-daemon) WANT_DAEMON=0; BOOT_ARGS=() ;;
    --real) BOOT_ARGS=(--with-daemon --real) ;;
    --with-daemon) : ;; # already the default
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

# Reuse the stack only if EVERYTHING we need is healthy — including the host
# when one is wanted. Otherwise do a clean stop + full boot (a partial reuse
# can't add a host to an already-running server, and re-booting the server on
# an occupied port would fail).
stack_healthy() {
  curl -sf "http://127.0.0.1:$SERVER_PORT/api/healthz" >/dev/null 2>&1 \
    && lsof -tiTCP:$WEB_PORT -sTCP:LISTEN >/dev/null 2>&1 || return 1
  if [[ "$WANT_DAEMON" == 1 ]]; then
    curl -sf "http://127.0.0.1:$DAEMON_HEALTHZ_PORT/healthz" >/dev/null 2>&1 || return 1
  fi
  return 0
}

if stack_healthy; then
  echo "==> dev stack already healthy — minting fresh credential"
  scripts/dev-web-auth.sh --mint-only >/dev/null
else
  echo "==> booting local dev stack${BOOT_ARGS:+ (}${BOOT_ARGS[*]}${BOOT_ARGS:+)}"
  scripts/dev-web-auth.sh --stop >/dev/null 2>&1 || true
  scripts/dev-web-auth.sh "${BOOT_ARGS[@]}" >/dev/null
fi

if [[ ! -f "$URL_FILE" ]]; then
  echo "ERROR: $URL_FILE was not written — dev stack did not come up cleanly." >&2
  exit 1
fi
APP_URL="$(tail -n1 "$URL_FILE")"
if [[ -z "$APP_URL" ]]; then
  echo "ERROR: empty URL in $URL_FILE." >&2
  exit 1
fi

echo "==> pointing /Applications/Patch.app at: $APP_URL"
quit_app
sleep 0.5

# Launch the installed binary directly (Finder's `open` would NOT pass env).
PATCH_SERVER_URL="$APP_URL" nohup "$APP_BIN" >/tmp/patch-desktop-app.log 2>&1 &
echo "==> Patch desktop launched (pid $!). UI changes now hot-reload into the app."
echo "    logs: /tmp/patch-desktop-app.log    stop: scripts/dev-desktop.sh --stop"
