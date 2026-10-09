#!/usr/bin/env bash
# Scheduled watcher for the voice-call path. Runs the full-path probe
# (scripts/voice-probe-fullpath.mjs) against production and pushes an ntfy
# alert naming the failed leg if — and only if — it fails. Quiet on pass.
#
# Installed as a cron entry on the Hetzner host (see testing-strategy.md
# § Voice). Needs ~/.patch/probe-credential.jwt — a surface credential the
# probe presents to POST /api/voice/token, same as a phone would.
#
# Each run costs one real agent turn on thread_manager (a one-line "say
# banana" exchange) plus one Groq transcription — that is the price of an
# honest end-to-end check.
set -u
cd "$(dirname "$0")/.."

LOG="$HOME/.patch/logs/voice-probe.log"
NTFY="${PATCH_NTFY_URL:-https://ntfy.sh/tomchambers-phone-hgzsxwk9kah}"
CRED="$HOME/.patch/probe-credential.jwt"

# Three cases, mirroring how the surfaces are actually used:
#   call        — the Talk button: every utterance is a turn, reply must come
#   ear-drop    — hands-free, unaddressed utterance: must be heard-and-dropped
#   ear-reply   — hands-free, "Patch, …" utterance: reply must come
FAILED=""
run_case() {
  local name="$1"
  shift
  local out code
  out=$(node scripts/voice-probe-fullpath.mjs --credential "$CRED" --json "$@" 2>&1)
  code=$?
  {
    echo "$(date -Is) case=$name exit=$code"
    echo "$out" | tail -3
  } >>"$LOG"
  if [ $code -ne 0 ]; then
    local detail
    detail=$(echo "$out" | grep '^FAIL at leg' | head -1)
    [ -z "$detail" ] && detail=$(echo "$out" | tail -2)
    FAILED="${FAILED}[$name] ${detail}
"
  fi
}

run_case call
run_case ear-drop --mode hands-free --expect-dropped --mic-wav scripts/fixtures/probe-unaddressed-16k.wav
run_case ear-reply --mode hands-free

if [ -n "$FAILED" ]; then
  curl -s \
    -H "Title: Patch voice BROKEN" \
    -H "Priority: high" \
    -H "Tags: rotating_light,telephone" \
    -d "Automated voice probe failed.
${FAILED}Full log: ~/.patch/logs/voice-probe.log on hetzner" \
    "$NTFY" >/dev/null
  exit 1
fi
exit 0
