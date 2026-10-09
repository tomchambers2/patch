#!/usr/bin/env bash
# Fetch the voice model files into ./models on first run
# (spec/11-deployment.md § Env: "Whisper and Kokoro models are downloaded to
# ./models/ on first run. medium.en is ~1.5 GB; Kokoro is ~310 MB.").
#
# Idempotent + present/missing aware: each model is checked for its sentinel
# file and only downloaded when absent. Re-running on a fully-populated ./models
# is a fast no-op. NO FALLBACKS — a failed download aborts non-zero.
#
#   ./scripts/fetch-models.sh            # fetch whatever is missing
#   ./scripts/fetch-models.sh --check    # report present/missing, download nothing
#   ./scripts/fetch-models.sh --force    # re-download even if present
#
# Requires the `hf` CLI from huggingface_hub (`pip install -U huggingface_hub`
# or `uv tool install huggingface_hub`). The legacy `huggingface-cli download`
# entrypoint is deprecated and no longer performs downloads. The Kokoro TTS
# sidecar uses
# kokoro-v1_0.pth + config.json; the faster-whisper backend uses the
# ctranslate2 medium.en directory (model.bin + tokenizer + vocab + config).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="${PATCH_MODELS_DIR:-$ROOT/models}"

# HF source repos (the upstream the local copies came from).
KOKORO_REPO="hexgrad/Kokoro-82M"
WHISPER_REPO="Systran/faster-whisper-medium.en"

# Silero VAD ships as a single ONNX file (no HF repo) — pin the canonical
# upstream. VAD is internal/free/on-box and runs real by default (VAD_BACKEND
# defaults to silero), so the model must be present for a real host boot.
VAD_URL="https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx"

# Sentinel files that mark a model as fully present.
KOKORO_SENTINEL="$MODELS_DIR/kokoro/kokoro-v1_0.pth"
WHISPER_SENTINEL="$MODELS_DIR/whisper/medium.en/model.bin"
VAD_SENTINEL="$MODELS_DIR/vad/silero_vad.onnx"

MODE="fetch"
case "${1:-}" in
  --check) MODE="check" ;;
  --force) MODE="force" ;;
  '') MODE="fetch" ;;
  *) echo "unknown arg: $1 (expected --check | --force)" >&2; exit 2 ;;
esac

present() { [[ -f "$1" ]]; }

report() {
  local name="$1" sentinel="$2"
  if present "$sentinel"; then
    echo "present  $name  ($sentinel)"
  else
    echo "MISSING  $name  ($sentinel)"
  fi
}

if [[ "$MODE" == "check" ]]; then
  report "kokoro"        "$KOKORO_SENTINEL"
  report "whisper-medium.en" "$WHISPER_SENTINEL"
  report "silero-vad"    "$VAD_SENTINEL"
  # Exit non-zero if anything is missing, so callers can gate on it.
  present "$KOKORO_SENTINEL" && present "$WHISPER_SENTINEL" && present "$VAD_SENTINEL"
  exit $?
fi

if ! command -v hf >/dev/null 2>&1; then
  echo "FATAL: hf not found. Install it: pip install -U huggingface_hub" >&2
  exit 1
fi

fetch_one() {
  local name="$1" repo="$2" sentinel="$3" dest="$4"
  if [[ "$MODE" != "force" ]] && present "$sentinel"; then
    echo "==> $name already present — skipping (use --force to re-download)"
    return 0
  fi
  echo "==> fetching $name from $repo → $dest"
  mkdir -p "$dest"
  hf download "$repo" --local-dir "$dest"
  if ! present "$sentinel"; then
    echo "FATAL: $name download finished but sentinel $sentinel is missing." >&2
    exit 1
  fi
  echo "==> $name ready"
}

# Single-file fetch over HTTP (Silero is not on HF). NO FALLBACK — curl -f
# aborts non-zero on any HTTP error, and the sentinel check confirms the file.
fetch_url() {
  local name="$1" url="$2" sentinel="$3"
  if [[ "$MODE" != "force" ]] && present "$sentinel"; then
    echo "==> $name already present — skipping (use --force to re-download)"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "FATAL: curl not found — needed to fetch $name." >&2
    exit 1
  fi
  echo "==> fetching $name from $url → $sentinel"
  mkdir -p "$(dirname "$sentinel")"
  curl -fSL "$url" -o "$sentinel"
  if ! present "$sentinel"; then
    echo "FATAL: $name download finished but sentinel $sentinel is missing." >&2
    exit 1
  fi
  echo "==> $name ready"
}

fetch_one "kokoro"            "$KOKORO_REPO"  "$KOKORO_SENTINEL"  "$MODELS_DIR/kokoro"
fetch_one "whisper-medium.en" "$WHISPER_REPO" "$WHISPER_SENTINEL" "$MODELS_DIR/whisper/medium.en"
fetch_url "silero-vad"        "$VAD_URL"      "$VAD_SENTINEL"

echo "==> all models present in $MODELS_DIR"
