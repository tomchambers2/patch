#!/usr/bin/env bash
# Nightly restic backup of /data (spec/11-deployment.md § Backup).
#
# `/data` is the only stateful volume on the box: it holds the registry, jobs,
# runs, webhook logs, pending buffer, AND (via the host's bind mounts under
# ./data/patch + ./data/claude) the host metadata + Claude Code's native chat
# history. Backing up ./data therefore covers everything stateful.
#
# Installed as a nightly cron by deploy/install-backup-cron.sh. NO FALLBACKS:
# any failed step aborts non-zero so the cron's MAILTO / wrapper surfaces it.
#
# Required env (sourced from deploy/.env or the cron environment):
#   RESTIC_REPOSITORY  — e.g. sftp:u123@u123.your-storagebox.de:/restic
#                        (Hetzner Storage Box) or any restic-supported remote.
#   RESTIC_PASSWORD    — repository encryption password.
#
# Optional:
#   PATCH_DATA_DIR     — path to the data dir to back up. Defaults to the
#                        deploy/data dir next to this script.
#   RESTIC_KEEP_DAILY  — daily snapshots to retain (default 7).
#   RESTIC_KEEP_WEEKLY — weekly snapshots to retain (default 4).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# Load deploy/.env if present so cron runs get the repo + password without a
# wrapper. `set -a` exports everything the file defines.
if [[ -f "$HERE/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/.env"
  set +a
fi

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required (restic remote, e.g. Hetzner Storage Box sftp URL)}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required (restic repo encryption password)}"

DATA_DIR="${PATCH_DATA_DIR:-$HERE/data}"
KEEP_DAILY="${RESTIC_KEEP_DAILY:-7}"
KEEP_WEEKLY="${RESTIC_KEEP_WEEKLY:-4}"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "FATAL: data dir $DATA_DIR does not exist — refusing to back up nothing." >&2
  exit 1
fi

# Initialise the repo on first run (idempotent: a second init errors, which we
# tolerate by checking first).
if ! restic snapshots >/dev/null 2>&1; then
  echo "==> restic repo not initialised — initialising $RESTIC_REPOSITORY"
  restic init
fi

echo "==> restic backup $DATA_DIR → $RESTIC_REPOSITORY"
restic backup --tag patch-data "$DATA_DIR"

echo "==> restic forget (keep daily=$KEEP_DAILY weekly=$KEEP_WEEKLY) + prune"
restic forget --tag patch-data \
  --keep-daily "$KEEP_DAILY" \
  --keep-weekly "$KEEP_WEEKLY" \
  --prune

echo "==> latest snapshot:"
restic snapshots --tag patch-data --latest 1

echo "==> backup complete"
