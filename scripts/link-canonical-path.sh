#!/usr/bin/env bash
# Bind the canonical patch working-copy path (~/projects/patch) to the real
# checkout, idempotently.
#
# `patch` is its own repo but on some machines the checkout lives nested inside
# the portfolio monorepo (~/projects/portfolio/projects/patch). The spec,
# plans, and build harness all address files by the canonical absolute root
# ~/projects/patch, so that path MUST resolve to the live checkout for those
# paths to be valid.
#
# This is a required, reproducible setup step — run it once after locating the
# repo. It is a no-op when ~/projects/patch already IS (or already points at)
# the real checkout, so it is safe to re-run.
set -euo pipefail

# Resolve the real checkout = the directory this script lives in, two levels up
# (scripts/ -> repo root), fully dereferenced.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REAL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

CANONICAL="$HOME/projects/patch"

# If the canonical path already resolves to the real checkout, nothing to do
# (covers: it IS the real checkout, or it already points there).
if [ -e "$CANONICAL" ] && [ "$(cd "$CANONICAL" && pwd -P)" = "$REAL_ROOT" ]; then
  echo "canonical path already bound: $CANONICAL -> $REAL_ROOT"
  exit 0
fi

# Refuse to clobber a real (non-symlink) directory that isn't the checkout.
if [ -e "$CANONICAL" ] && [ ! -L "$CANONICAL" ]; then
  echo "ERROR: $CANONICAL exists and is not a symlink, and is not the real checkout ($REAL_ROOT)." >&2
  echo "       Refusing to overwrite it. Move/remove it manually, then re-run." >&2
  exit 1
fi

mkdir -p "$(dirname "$CANONICAL")"
# Replace any stale symlink, then point the canonical path at the real checkout.
rm -f "$CANONICAL"
ln -s "$REAL_ROOT" "$CANONICAL"
echo "bound canonical path: $CANONICAL -> $REAL_ROOT"
