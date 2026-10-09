#!/usr/bin/env bash
# patch-cli-sandbox.sh — an ISOLATED server+host stack for poking at the
# `patch` CLI by hand, on ALTERNATE ports + its own data dir, so it never
# collides with the dev web bring-up (ports 3000/5173). No web/vite — the
# CLI only needs server + host.
#
#   scripts/patch-cli-sandbox.sh up     # bring up server(:3100) + host
#   scripts/patch-cli-sandbox.sh down   # stop them
#   scripts/patch-cli-sandbox.sh env    # print the env to drive the CLI
#
# Then drive the real binary (UDS mode — talks straight to the host):
#   source <(scripts/patch-cli-sandbox.sh env)
#   patch chats list --json
#   patch chats spawn /tmp/demo --json
#   patch doctor --json
#
# NO FALLBACKS: any failing step aborts loudly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DATA_DIR="$ROOT/.dev-data-cli"
HOME_DIR="$DATA_DIR/home"
CLI_HOME="$DATA_DIR/cli-home"
SERVER_PORT=3100
DAEMON_HEALTHZ_PORT=3111
DAEMON_AUDIO_PORT=3113
INTERNAL_TOKEN="dev-internal-token-sandbox-0123456789"
PID_FILE="$DATA_DIR/.pids"
SERVER_LOG="/tmp/patch-cli-sandbox-server.log"
DAEMON_LOG="/tmp/patch-cli-sandbox-daemon.log"

print_env() {
  echo "export PATCH_HOME='$CLI_HOME'"
  echo "export PATCH_DAEMON_SOCKET='$HOME_DIR/daemon.sock'"
  echo "export PATCH_DAEMON_LOCAL_KEY='dev-local-key'"
  echo "export PATH='$ROOT/packages/cli/dist:'\"\$PATH\"  # so 'patch' resolves to the dev binary"
  echo "alias patch='node $ROOT/packages/cli/dist/index.js'"
}

down() {
  if [[ -f "$PID_FILE" ]]; then
    while read -r pid; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done < "$PID_FILE"
    rm -f "$PID_FILE"
    echo "sandbox stopped"
  else
    echo "no pid file — nothing to stop"
  fi
}

wait_for() {
  local n=0
  until curl -sf "$1" >/dev/null 2>&1; do
    n=$((n + 1)); [[ $n -gt 60 ]] && { echo "ERROR: $2 did not come up at $1" >&2; exit 1; }
    sleep 0.5
  done
}

up() {
  mkdir -p "$DATA_DIR" "$HOME_DIR" "$CLI_HOME"
  : > "$PID_FILE"

  # mint a surface credential (bootstraps the singleton account on first run)
  pnpm --filter @patch/server fixtures:mint-surface-jwt \
    --account dev --surface cli-sandbox-1 --kind web \
    --data-dir "$DATA_DIR" --ttl 86400 --output "$DATA_DIR/.web-credential.json" >/dev/null
  JWT="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$DATA_DIR/.web-credential.json','utf8')).credential)")"

  # register the host key (must exist before the server boots)
  pnpm --filter @patch/server fixtures:mint-daemon-key \
    --data-dir "$DATA_DIR" --patch-home "$HOME_DIR" \
    --daemon-id cli-sandbox-daemon --label cli-sandbox >/dev/null

  # CLI config home for REST mode (UDS mode is the default below)
  printf '%s' "$JWT" > "$CLI_HOME/credential.jwt"; chmod 600 "$CLI_HOME/credential.jwt"
  node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({serverUrl:'http://127.0.0.1:'+process.argv[2]},null,2))" \
    "$CLI_HOME/config.json" "$SERVER_PORT"

  PORT="$SERVER_PORT" HOST=127.0.0.1 PATCH_DATA_DIR="$DATA_DIR" \
    PATCH_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    nohup pnpm --filter @patch/server dev > "$SERVER_LOG" 2>&1 &
  echo "$!" >> "$PID_FILE"
  wait_for "http://127.0.0.1:$SERVER_PORT/api/healthz" "server"

  # A throwaway sandbox for driving the CLI: it needs a host on the other end
  # of the socket, not a working Claude or a working microphone — and a real turn
  # would spend real tokens on every sandbox boot.
  # mock-check:allow CLI sandbox; the host is only a socket peer here, and a real turn would spend tokens on every boot
  PATCH_HOME="$HOME_DIR" \
    PATCH_SERVER_WS_URL="ws://127.0.0.1:$SERVER_PORT/ws" \
    PATCH_SERVER_URL="http://127.0.0.1:$SERVER_PORT" \
    PATCH_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
    PATCH_DAEMON_LOCAL_KEY=dev-local-key \
    PATCH_DAEMON_HEALTHZ_PORT="$DAEMON_HEALTHZ_PORT" \
    PATCH_DAEMON_AUDIO_PORT="$DAEMON_AUDIO_PORT" \
    PATCH_MOCK_TURN_DELAY_MS=1500 \
    SDK_BACKEND=mock WHISPER_BACKEND=mock KOKORO_BACKEND=mock \
    nohup pnpm --filter @patch/daemon dev > "$DAEMON_LOG" 2>&1 &
  echo "$!" >> "$PID_FILE"
  wait_for "http://127.0.0.1:$DAEMON_HEALTHZ_PORT/healthz" "daemon"
  wait_for "http://127.0.0.1:$SERVER_PORT/api/daemon/healthz" "daemon-server-link"

  echo ""
  echo "=========================================================="
  echo " patch CLI sandbox UP"
  echo "   server: http://127.0.0.1:$SERVER_PORT   daemon link: OK"
  echo "   data:   $DATA_DIR"
  echo ""
  echo " Drive the CLI:"
  echo "   source <(scripts/patch-cli-sandbox.sh env)"
  echo "   patch doctor --json"
  echo "   patch chats list --json"
  echo "   patch chats spawn /tmp/demo --json"
  echo "   patch  (bare = interactive TUI; needs a real terminal)"
  echo ""
  echo " Stop: scripts/patch-cli-sandbox.sh down"
  echo "=========================================================="
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  env) print_env ;;
  *) echo "usage: $0 {up|down|env}" >&2; exit 1 ;;
esac
