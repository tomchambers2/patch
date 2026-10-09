#!/usr/bin/env bash
# Install the nightly restic backup cron on the Hetzner box
# (spec/11-deployment.md § Backup: "restic to remote storage nightly").
#
# Idempotent: re-running replaces the patch-backup crontab line in place rather
# than appending a duplicate. Run once on the box after the first deploy:
#
#     ./deploy/install-backup-cron.sh
#
# Verify afterwards with:
#     crontab -l | grep patch-backup
#     restic snapshots --tag patch-data --latest 1   # after the first run

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SH="$HERE/backup.sh"
# 03:17 nightly — odd minute to avoid the top-of-hour cron stampede.
SCHEDULE="${PATCH_BACKUP_SCHEDULE:-17 3 * * *}"
MARKER="# patch-backup (managed by install-backup-cron.sh)"

if [[ ! -x "$BACKUP_SH" ]]; then
  echo "FATAL: $BACKUP_SH is not executable (run chmod +x)." >&2
  exit 1
fi

# Read current crontab (empty if none), strip any existing patch-backup block,
# append the fresh one.
current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$current" | grep -v -F "$MARKER" | grep -v -F "$BACKUP_SH" || true)"

{
  printf '%s\n' "$filtered"
  printf '%s\n' "$MARKER"
  printf '%s %s >> /var/log/patch-backup.log 2>&1\n' "$SCHEDULE" "$BACKUP_SH"
} | crontab -

echo "==> installed nightly restic cron:"
crontab -l | grep -A1 -F "$MARKER"
