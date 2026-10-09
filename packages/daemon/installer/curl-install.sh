#!/bin/sh
# Install route 1 (spec/02 § Installation): a single shell command, on any
# machine that has a shell.
#
#   curl -fsSL https://<server>/api/daemon/install.sh | sh -s -- --code <code>
#
# It works out what machine it is on, fetches that machine's artifact from the
# server that served this script, verifies the artifact against the digest in
# the server's manifest, unpacks it and hands over to the artifact's own
# installer. It needs nothing but a shell, curl (or wget) and tar.
#
# NO FALLBACK: an unknown platform, a missing artifact or a digest mismatch
# stops here rather than installing something unverified.
set -eu

SERVER_URL="${PATCH_SERVER_URL:-@@PATCH_SERVER_URL@@}"
ARGS=""
for a in "$@"; do
  case "$a" in
    --server) NEXT_IS_SERVER=1 ;;
    *) if [ "${NEXT_IS_SERVER:-0}" = "1" ]; then SERVER_URL="$a"; NEXT_IS_SERVER=0; fi ;;
  esac
done

case "$SERVER_URL" in
  @@*|'') echo "patch install: no server URL. Pass --server <url> or set PATCH_SERVER_URL." >&2; exit 64 ;;
esac

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "patch install: patch installs on macOS and Linux, not $(uname -s)" >&2; exit 65 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) echo "patch install: unsupported machine architecture $(uname -m)" >&2; exit 65 ;;
esac
TARGET="$OS-$ARCH"

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "patch install: neither curl nor wget is available" >&2
    exit 69
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "patch install: this machine is $TARGET; asking $SERVER_URL what to install"
fetch "$SERVER_URL/api/daemon/daemon-latest.json" "$TMP/manifest.json"

FILE=$(awk -v t="$TARGET" '
  /"target"/ { intgt = (index($0, "\"" t "\"") > 0) }
  intgt && /"file"/ { sub(/.*"file"[ \t]*:[ \t]*"/, ""); sub(/".*/, ""); print; exit }
' "$TMP/manifest.json")
if [ -z "$FILE" ]; then
  echo "patch install: the server publishes no daemon artifact for $TARGET" >&2
  exit 65
fi
DIGEST=$(awk -v f="$FILE" '
  /"file"/ { infile = (index($0, f) > 0) }
  infile && /"sha256"/ { sub(/.*"sha256"[ \t]*:[ \t]*"/, ""); sub(/".*/, ""); print; exit }
' "$TMP/manifest.json")
if [ -z "$DIGEST" ]; then
  echo "patch install: the server manifest carries no digest for $FILE — refusing to install unverified bytes" >&2
  exit 65
fi

echo "patch install: downloading $FILE"
fetch "$SERVER_URL/api/daemon/$FILE" "$TMP/$FILE"

if command -v shasum >/dev/null 2>&1; then
  GOT=$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)
elif command -v sha256sum >/dev/null 2>&1; then
  GOT=$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)
else
  echo "patch install: no sha256 tool available to verify the download" >&2
  exit 69
fi
if [ "$GOT" != "$DIGEST" ]; then
  echo "patch install: the downloaded artifact does not match the server's digest" >&2
  echo "  expected $DIGEST" >&2
  echo "  got      $GOT" >&2
  exit 65
fi
echo "patch install: digest verified"

tar -xzf "$TMP/$FILE" -C "$TMP"
UNPACKED=$(find "$TMP" -maxdepth 1 -type d -name 'patch-daemon-*' | head -n 1)
if [ -z "$UNPACKED" ]; then
  echo "patch install: the artifact did not unpack as expected" >&2
  exit 65
fi

exec "$UNPACKED/install" --server "$SERVER_URL" "$@"
