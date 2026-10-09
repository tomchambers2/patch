#!/usr/bin/env bash
# dev-web-auth.sh — bring up an AUTHENTICATED local web session for testing.
#
# Why this exists: the web SPA is gated behind a surface-credential pairing
# screen (spec/10-auth). In production a surface is paired via the QR flow; in
# local dev / automated UI tests there's no paired surface, so the app sits on
# the pairing screen and every /api call 401s. This harness closes that gap:
#
#   1. ensures a WRITABLE dataDir (the docker test stack mounts /data read-only,
#      which is what blocked credential minting before)
#   2. mints a real `web` surface credential into it (bootstraps the singleton
#      account on first run; reuses the persisted keypair after)
#   3. starts the server on a DEDICATED port (default 3000) with that dataDir
#   4. starts the Vite DEV web server (import.meta.env.DEV === true, so the
#      `?credential=<jwt>` bypass in packages/web/src/lib/credential.ts works)
#      with its API/WS proxy repointed at our server via PATCH_API_PROXY
#   5. prints the ready-to-open authenticated URL
#
# The explicit 127.0.0.1 proxy target avoids the localhost→IPv6 trap where a
# stray `::1:13000` docker listener silently shadows the dev server.
#
# Usage:
#   scripts/dev-web-auth.sh                  # bring everything up, print the URL
#   scripts/dev-web-auth.sh --with-daemon    # also boot a host (SDK_BACKEND=mock)
#   scripts/dev-web-auth.sh --with-daemon --real
#                                            # boot the host in SDK_BACKEND=real
#                                            # mode — genuine streamed Claude
#                                            # completions via your `claude login`
#                                            # OAuth (Keychain on macOS,
#                                            # ~/.claude/.credentials.json on
#                                            # Linux). NEVER an API key. Implies
#                                            # --with-daemon. Requires you to have
#                                            # run `claude login` on this host.
#   scripts/dev-web-auth.sh --mint-only      # just mint + print URL (servers already up)
#   scripts/dev-web-auth.sh --stop           # stop servers started by this script
#
# Env overrides: PATCH_SERVER_PORT (default 3000), PATCH_DATA_DIR
# (default <project>/.dev-data), PATCH_INTERNAL_TOKEN (default a dev value).
#
# NO FALLBACKS: any step that fails aborts the script loudly.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DATA_DIR="${PATCH_DATA_DIR:-$ROOT/.dev-data}"
SERVER_PORT="${PATCH_SERVER_PORT:-3000}"
INTERNAL_TOKEN="${PATCH_INTERNAL_TOKEN:-dev-internal-token-0123456789}"
PID_FILE="$ROOT/.dev-data/.dev-web-auth.pids"
SERVER_LOG="/tmp/patch-dev-server.log"
WEB_LOG="/tmp/patch-dev-web.log"
DAEMON_LOG="/tmp/patch-dev-daemon.log"

free_port() { # $1=port — kill whatever still listens on it (TERM then KILL)
  local pids
  pids="$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  while read -r p; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done <<< "$pids"
  sleep 0.5
  pids="$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"
  while read -r p; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null || true; done <<< "$pids"
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  # Orphan sweep (NO FALLBACK on a half-dead stack): killing the recorded `pnpm`
  # PIDs leaves the `tsx watch` grandchildren running — reparented to init, they
  # keep ticking cron against the same data dir, which DOUBLE-FIRES every job.
  # Reclaim every dev port so no server/daemon/web process can survive --stop.
  for port in "${PATCH_SERVER_PORT:-3000}" 5173 "${PATCH_DAEMON_HEALTHZ_PORT:-3011}" \
    "${PATCH_DAEMON_AUDIO_PORT:-3013}"; do
    free_port "$port"
  done
  echo "stopped dev servers (recorded PIDs + reclaimed ports)"
}

mint() {
  mkdir -p "$DATA_DIR"
  local out="$DATA_DIR/.web-credential.json"
  pnpm --filter @patch/server fixtures:mint-surface-jwt \
    --account dev --surface web-dev-1 --kind web \
    --data-dir "$DATA_DIR" --ttl 86400 --output "$out" >/dev/null
  node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$out','utf8')).credential)"
}

wait_for() { # url, name
  local n=0
  until curl -sf "$1" >/dev/null 2>&1; do
    n=$((n + 1))
    if [[ $n -gt 60 ]]; then
      echo "ERROR: $2 did not come up at $1" >&2
      exit 1
    fi
    sleep 0.5
  done
}

# --- host dev-registration (no QR) ---
DAEMON_HOME="$DATA_DIR/home"
DAEMON_HEALTHZ_PORT="${PATCH_DAEMON_HEALTHZ_PORT:-3011}"
DAEMON_AUDIO_PORT="${PATCH_DAEMON_AUDIO_PORT:-3013}"
DAEMON_ID="dev-daemon-1"

# Registers the host key in registry.json AND writes <home>/daemon.key.
# MUST run before the server boots (server loads registry.json once at startup).
mint_daemon() {
  mkdir -p "$DAEMON_HOME"
  pnpm --filter @patch/server fixtures:mint-daemon-key \
    --data-dir "$DATA_DIR" --patch-home "$DAEMON_HOME" \
    --daemon-id "$DAEMON_ID" --label local-dev >/dev/null
}

# --- CLI dev config provisioning (TG1 e2e seam) ---------------------------
#
# The `patch` CLI (packages/cli) reaches the host two ways (spec/17 § Auth):
#   - UDS mode:  PATCH_DAEMON_SOCKET=<home>/daemon.sock + PATCH_DAEMON_LOCAL_KEY
#   - REST mode: config.json serverUrl + a credential.jwt bearer
# This writes a DEDICATED CLI config home ($DATA_DIR/cli-home) wired to the dev
# stack so the plan-encoded CLI e2e tests can drive the real binary. GATED to
# dev: it only mints against the dev dataDir and the local-dev host key; it
# is never invoked under NODE_ENV=production. NO FALLBACK — the credential and
# config are written explicitly, not guessed at runtime.
CLI_HOME="$DATA_DIR/cli-home"
provision_cli() {
  local jwt="$1"
  mkdir -p "$CLI_HOME"
  printf '%s' "$jwt" > "$CLI_HOME/credential.jwt"
  chmod 600 "$CLI_HOME/credential.jwt"
  node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({serverUrl:'http://127.0.0.1:'+process.argv[2]},null,2))" \
    "$CLI_HOME/config.json" "$SERVER_PORT"
}

WITH_DAEMON=0
SDK_MODE=mock
for a in "$@"; do
  case "$a" in
    --stop) stop; exit 0 ;;
    --with-daemon) WITH_DAEMON=1 ;;
    --real) WITH_DAEMON=1; SDK_MODE=real ;;
    --mint-only)
      JWT="$(mint)"
      echo "credential minted. open:"
      echo "  http://localhost:5173/app/?credential=$JWT"
      exit 0
      ;;
  esac
done

# Mint BEFORE booting the server: the server loads registry.json into memory at
# boot, so the account (and, with --with-daemon, the host key record) must
# already exist in it.
JWT="$(mint)"
[[ "$WITH_DAEMON" == 1 ]] && mint_daemon
provision_cli "$JWT"

mkdir -p "$DATA_DIR"
: > "$PID_FILE"

# TD1 dev/test seams (spec/06 special threads) — gated to dev only:
#   PATCH_TELEGRAM_MOCK=1    inject a recording mock Telegram backend (dev has no
#                            bot token) so /telegram/webhook + reply-routing live.
#   TELEGRAM_ALLOWED_USER_ID register the allowed-user ingress filter (D1-3/D1-4).
#   TELEGRAM_WEBHOOK_SECRET  make /api/telegram/webhook accept signed updates.
#   PATCH_SPEAKERS_MOCK=1    record speakers-channel TTS notifies so D1-6 is
#                            assertable without a physical voice device.
#   PATCH_JOBS_DIAG=1        mount the gated TD2 jobs seam
#                            (POST /internal/diag/jobs/fire-cron {jobId}) so a
#                            cron job's action can be fired synchronously instead
#                            of waiting up to a minute for the wall-clock tick.
# These also mount the gated /internal/diag/* read/inject routes (internal-token
# guarded). NONE are ever active when NODE_ENV=production.
TELEGRAM_ALLOWED_USER_ID="${PATCH_DEV_TELEGRAM_ALLOWED_USER_ID:-424242}"
TELEGRAM_WEBHOOK_SECRET="${PATCH_DEV_TELEGRAM_WEBHOOK_SECRET:-dev-telegram-webhook-secret}"

# mock-check:allow dev box has no Telegram chat to post into and no speaker to talk to, so those two channels RECORD instead of send; both are exercised for real against the live server
PORT="$SERVER_PORT" HOST=127.0.0.1 PATCH_DATA_DIR="$DATA_DIR" \
  PATCH_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  PATCH_TELEGRAM_MOCK=1 PATCH_SPEAKERS_MOCK=1 PATCH_JOBS_DIAG=1 \
  TELEGRAM_ALLOWED_USER_ID="$TELEGRAM_ALLOWED_USER_ID" \
  TELEGRAM_WEBHOOK_SECRET="$TELEGRAM_WEBHOOK_SECRET" \
  nohup pnpm --filter @patch/server dev > "$SERVER_LOG" 2>&1 &
echo "$!" >> "$PID_FILE"
wait_for "http://127.0.0.1:$SERVER_PORT/api/healthz" "server"

if [[ "$WITH_DAEMON" == 1 ]]; then
  # In --real mode the host drives the GENUINE Claude Agent SDK against the
  # operator's `claude login` OAuth (Keychain on macOS, ~/.claude/.credentials.json
  # on Linux). Preflight that a credential actually resolves so we fail LOUDLY up
  # front instead of only on the first user turn (NO FALLBACK to an API key).
  if [[ "$SDK_MODE" == "real" ]]; then
    if ! node -e "require('$ROOT/packages/auth/dist/index.js').loadClaudeOAuth()" 2>"$DATA_DIR/.oauth-preflight.err"; then
      echo "ERROR: --real requires a Claude Code OAuth credential, but none resolved." >&2
      echo "       Run \`claude login\` on this host first, then retry." >&2
      cat "$DATA_DIR/.oauth-preflight.err" >&2 || true
      exit 1
    fi
    echo "real mode: Claude OAuth preflight OK — daemon will use SDK_BACKEND=real"
  fi
  # The host reads <home>/daemon.key (written by mint_daemon) and dials the
  # dev server's /ws; on connect it bootstraps + replays the special threads.
  # Voice backends stay mock (no audio models needed for chat e2e). The SDK
  # backend is mock by default and real under --real.
  #   - mock: PATCH_MOCK_TURN_DELAY_MS gives a genuine running-query window.
  #   - real: the SDK reads its own OAuth credential; the host ALSO resolves
  #     and passes it as CLAUDE_CODE_OAUTH_TOKEN, and strips ANTHROPIC_API_KEY.
  #     claudeProjectsRoot auto-defaults to the operator's ~/.claude/projects.
  # CLAUDE_CONFIG_PATH / CLAUDE_CREDENTIALS_PATH (sandbox copies, for safely
  # exercising the Settings "disconnect" credential-clear without touching the
  # host Keychain) are inherited from the parent environment when exported.
  # This host exists so the WEB surface has something to talk to; voice is not
  # what you brought this stack up to look at, and wiring it real would demand
  # GROQ_API_KEY, the Kokoro sidecar and the silero model before the page loads.
  # SDK_BACKEND stays parameterised ($SDK_MODE) precisely so a real turn IS one
  # flag away.
  # mock-check:allow dev stack for the web surface; voice off so the page comes up without credentials, SDK still selectable via $SDK_MODE
  PATCH_HOME="$DAEMON_HOME" \
    PATCH_SERVER_WS_URL="ws://127.0.0.1:$SERVER_PORT/ws" \
    PATCH_SERVER_URL="http://127.0.0.1:$SERVER_PORT" \
    PATCH_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    PATCH_DAEMON_LOCAL_KEY=dev-local-key \
    PATCH_DAEMON_HEALTHZ_PORT="$DAEMON_HEALTHZ_PORT" \
    PATCH_DAEMON_AUDIO_PORT="$DAEMON_AUDIO_PORT" \
    PATCH_MOCK_TURN_DELAY_MS="${PATCH_MOCK_TURN_DELAY_MS:-2500}" \
    SDK_BACKEND="$SDK_MODE" WHISPER_BACKEND=mock KOKORO_BACKEND=mock VAD_BACKEND=mock \
    nohup pnpm --filter @patch/daemon dev > "$DAEMON_LOG" 2>&1 &
  echo "$!" >> "$PID_FILE"
  wait_for "http://127.0.0.1:$DAEMON_HEALTHZ_PORT/healthz" "daemon"
fi

# The web dev server MUST own 5173 — the .web-url.txt discovery contract and the
# frontend e2e tests both hardcode http://localhost:5173/app/. vite.config.ts now
# sets strictPort, so a squatter on 5173 would make `vite` abort rather than
# silently bump to 5174 (which previously hid the patch app on a port the
# reviewer never tested, and left an unrelated app answering on 5173). Reclaim
# 5173 from any stray dev server before launching. NO FALLBACK: we never accept
# a port other than 5173.
WEB_PORT=5173
free_web_port() {
  local pids
  pids="$(lsof -tiTCP:$WEB_PORT -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "port $WEB_PORT is occupied (pids: $pids) — reclaiming for patch web"
    while read -r p; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done <<< "$pids"
    sleep 1
    pids="$(lsof -tiTCP:$WEB_PORT -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      while read -r p; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null || true; done <<< "$pids"
      sleep 1
    fi
  fi
}
free_web_port

PATCH_API_PROXY="http://127.0.0.1:$SERVER_PORT" \
  PATCH_DEV_WEB_CREDENTIAL="$JWT" \
  nohup pnpm --filter @patch/web dev > "$WEB_LOG" 2>&1 &
echo "$!" >> "$PID_FILE"

# Wait for the web server to come up ON 5173. strictPort means vite exits if it
# can't bind 5173, so a missing 'Local:' line within the window is a hard error.
n=0
until grep -qE "localhost:$WEB_PORT/app" "$WEB_LOG" 2>/dev/null; do
  n=$((n + 1))
  if [[ $n -gt 60 ]]; then
    echo "ERROR: web dev server did not bind http://localhost:$WEB_PORT/app — see $WEB_LOG" >&2
    tail -20 "$WEB_LOG" >&2 || true
    exit 1
  fi
  sleep 0.5
done

# Stable discovery file for automated frontend e2e: the FULL authenticated web
# URL (carries the dev ?credential= bypass). The minted JWT changes every run,
# so test executors read this file rather than guessing the URL/port. Dev-only.
printf 'http://localhost:%s/app/?credential=%s\n' "$WEB_PORT" "$JWT" > "$DATA_DIR/.web-url.txt"

echo ""
echo "============================================================"
echo " patch dev web — AUTHENTICATED"
echo "   server:  http://127.0.0.1:$SERVER_PORT   (dataDir: $DATA_DIR)"
if [[ "$WITH_DAEMON" == 1 ]]; then
echo "   daemon:  http://127.0.0.1:$DAEMON_HEALTHZ_PORT/healthz  (id: $DAEMON_ID, home: $DAEMON_HOME, SDK_BACKEND=$SDK_MODE)"
if [[ "$SDK_MODE" == "real" ]]; then
echo "            REAL Claude backend — chats produce genuine streamed completions via your \`claude login\` OAuth (no API key)."
fi
fi
echo "   web:     http://localhost:$WEB_PORT/app/"
echo ""
echo "   patch CLI (dev config home: $CLI_HOME)"
echo "     REST mode:  PATCH_HOME=$CLI_HOME  (config.json serverUrl + credential.jwt)"
if [[ "$WITH_DAEMON" == 1 ]]; then
echo "     UDS  mode:  PATCH_HOME=$CLI_HOME \\"
echo "                 PATCH_DAEMON_SOCKET=$DAEMON_HOME/daemon.sock \\"
echo "                 PATCH_DAEMON_LOCAL_KEY=dev-local-key"
echo "       e.g. PATCH_HOME=$CLI_HOME PATCH_DAEMON_SOCKET=$DAEMON_HOME/daemon.sock PATCH_DAEMON_LOCAL_KEY=dev-local-key node packages/cli/dist/index.js chats list --json"
fi
echo ""
echo "   TD1 seams (dev-only): telegram-mock + speakers-recorder on"
echo "     webhook:  POST /api/telegram/webhook  (X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET)"
echo "     allowed user id: $TELEGRAM_ALLOWED_USER_ID"
echo "     diag (X-Patch-Internal-Token: $INTERNAL_TOKEN):"
echo "       GET  /internal/diag/telegram/sent"
echo "       GET  /internal/diag/speakers/sent"
echo "       POST /internal/diag/voice-device/transcript {deviceId,transcript}"
echo "   TD2 seam (dev-only): jobs cron-fire on"
echo "     diag (X-Patch-Internal-Token: $INTERNAL_TOKEN):"
echo "       POST /internal/diag/jobs/fire-cron {jobId}   (fire a cron job now)"
if [[ "$WITH_DAEMON" == 1 ]]; then
echo "     daemon link-drop (D2-12 offline buffering): POST control-UDS /internal/diag/drop-link"
fi
echo ""
echo "   OPEN THIS (authenticates via the dev ?credential= bypass):"
echo "   http://localhost:$WEB_PORT/app/?credential=$JWT"
echo ""
echo "   stop with: scripts/dev-web-auth.sh --stop"
echo "============================================================"
