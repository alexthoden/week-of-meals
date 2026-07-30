#!/usr/bin/env bash
#
# Nightly backup. Run by weekofmeals-backup.timer at 03:20.
#
# Writes a dated tar.gz of the registry, every household's database, and the
# photos into
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

[ -f "$DATA_DIR/households.json" ] || { echo "No registry at $DATA_DIR/households.json; nothing to back up."; exit 0; }

# Refuse to archive a corrupt database. A backup of unreadable JSON is worse
# than no backup, because it quietly replaces a good one during rotation.
#
# Every household is checked, not just the registry: one unreadable household
# file is exactly the case where you most want last night's archive intact.
RECIPES=$(node -e '
  const fs = require("fs"), path = require("path");
  const root = process.argv[1];
  const registry = JSON.parse(fs.readFileSync(path.join(root, "households.json"), "utf8"));
  let total = 0;
  for (const h of registry.households || []) {
    const file = path.join(root, "households", h.id + ".json");
    if (!fs.existsSync(file)) continue;
    total += (JSON.parse(fs.readFileSync(file, "utf8")).recipes || []).length;
  }
  process.stdout.write(String(total));
' "$DATA_DIR") || {
  echo "The database does not parse as JSON. Refusing to back up over a good archive." >&2
  exit 1
}

HOUSEHOLDS=$(node -e 'process.stdout.write(String((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).households||[]).length))' "$DATA_DIR/households.json")

# secret.key is deliberately NOT in this list. It decrypts the AnyList
# passwords inside the household files, so shipping it alongside them — into
# the same tarball, off the same box, to the same bucket — would make the
# encryption ornamental. Back the key up separately, somewhere the archives
# are not.
tar -czf "$ARCHIVE" -C "$DATA_DIR" \
  households.json \
  $( [ -d "$DATA_DIR/households" ] && echo households ) \
  $( [ -d "$DATA_DIR/images" ] && echo images )

echo "Wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1), $HOUSEHOLDS household(s), $RECIPES recipes)"

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
