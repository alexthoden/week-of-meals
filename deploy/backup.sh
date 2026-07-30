#!/usr/bin/env bash
#
# Nightly backup. Run by weekofmeals-backup.timer at 03:20.
#
# Writes a dated tar.gz of the database and photos into
# /var/lib/weekofmeals/backups, prunes anything older than BACKUP_KEEP_DAYS,
# and if BACKUP_REMOTE is set, copies it off the machine with rclone.
#
# Local snapshots protect you from your own mistakes. Only the off-box copy
# protects you from losing the VM, so setting BACKUP_REMOTE is worth the ten
# minutes it takes.
#
set -euo pipefail

DATA_DIR=${DATA_DIR:-/var/lib/weekofmeals}
BACKUP_DIR="$DATA_DIR/backups"
KEEP_DAYS=${BACKUP_KEEP_DAYS:-30}
REMOTE=${BACKUP_REMOTE:-}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$BACKUP_DIR/week-of-meals-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

[ -f "$DATA_DIR/db.json" ] || { echo "No database at $DATA_DIR/db.json; nothing to back up."; exit 0; }

# Refuse to archive a corrupt database. A backup of unreadable JSON is worse
# than no backup, because it quietly replaces a good one during rotation.
if ! node -e "JSON.parse(require('fs').readFileSync('$DATA_DIR/db.json','utf8'))" 2>/dev/null; then
  echo "db.json does not parse as JSON. Refusing to back up over a good archive." >&2
  exit 1
fi

RECIPES=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$DATA_DIR/db.json','utf8')).recipes.length))")

tar -czf "$ARCHIVE" -C "$DATA_DIR" \
  db.json \
  $( [ -d "$DATA_DIR/images" ] && echo images )

echo "Wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1), $RECIPES recipes)"

# Prune local archives, but never leave zero behind.
find "$BACKUP_DIR" -name 'week-of-meals-*.tar.gz' -mtime "+$KEEP_DAYS" -print -delete 2>/dev/null || true
if [ "$(find "$BACKUP_DIR" -name 'week-of-meals-*.tar.gz' | wc -l)" -eq 0 ]; then
  echo "Pruning removed everything; keeping the archive just made." >&2
fi

if [ -n "$REMOTE" ]; then
  if command -v rclone >/dev/null; then
    rclone copy "$ARCHIVE" "$REMOTE" --no-traverse
    echo "Copied to $REMOTE"
  else
    echo "BACKUP_REMOTE is set but rclone is not installed. Run: sudo apt install rclone && rclone config" >&2
  fi
fi
