#!/usr/bin/env bash
#
# Deploy a new version of the code onto a running box.
#
#   sudo bash deploy/update.sh
#
# Run it from a fresh copy of the project. It syncs the code, reinstalls
# dependencies, restarts, and rolls back if the new version will not answer.
#
set -euo pipefail

APP_DIR=/opt/weekofmeals
DATA_DIR=/var/lib/weekofmeals
PORT=$(grep -oP '^PORT=\K.*' /etc/weekofmeals/env 2>/dev/null || echo 4321)

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/package.json" ] || { echo "Run from inside the project." >&2; exit 1; }

echo "==> Snapshotting data before anything else"
STAMP=$(date +%Y%m%d-%H%M%S)
install -d -m 0750 -o weekofmeals -g weekofmeals "$DATA_DIR/backups"
cp "$DATA_DIR/db.json" "$DATA_DIR/backups/db-preupdate-$STAMP.json" 2>/dev/null || true

echo "==> Keeping the current release for rollback"
ROLLBACK=$(mktemp -d)
cp -a "$APP_DIR"/. "$ROLLBACK"/

echo "==> Syncing new code"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'data' --exclude '.env' \
  "$SRC"/ "$APP_DIR"/
chown -R root:root "$APP_DIR"

cd "$APP_DIR"
if [ -f package-lock.json ]; then npm ci --omit=dev --silent; else npm install --omit=dev --silent; fi

install -m 0644 deploy/weekofmeals.service /etc/systemd/system/
install -m 0644 deploy/weekofmeals-backup.service /etc/systemd/system/
install -m 0644 deploy/weekofmeals-backup.timer /etc/systemd/system/
chmod +x deploy/backup.sh deploy/update.sh
systemctl daemon-reload

echo "==> Restarting"
systemctl restart weekofmeals

for i in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/healthz" >/dev/null 2>&1; then
    echo "==> Healthy."
    rm -rf "$ROLLBACK"

    # Every hostname on a Cloudflare Tunnel is proxied through Cloudflare's
    # edge, and Cloudflare caches .js/.css by file extension regardless of
    # what this server says — so without this, a deployed fix can sit behind
    # a stale cached copy and look like the deploy silently failed.
    CF_ZONE_ID=$(grep -oP '^CF_ZONE_ID=\K.*' /etc/weekofmeals/env 2>/dev/null || true)
    CF_API_TOKEN=$(grep -oP '^CF_API_TOKEN=\K.*' /etc/weekofmeals/env 2>/dev/null || true)
    if [ -n "$CF_ZONE_ID" ] && [ -n "$CF_API_TOKEN" ]; then
      echo "==> Purging Cloudflare cache"
      resp=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" \
        --data '{"purge_everything":true}')
      if echo "$resp" | grep -q '"success":true'; then
        echo "    done"
      else
        echo "    purge failed — purge manually in the dashboard: Caching -> Configuration -> Purge Everything" >&2
      fi
    else
      echo "==> No CF_ZONE_ID/CF_API_TOKEN set — purge the Cloudflare cache by hand if you changed app.js or style.css:"
      echo "    dashboard -> Caching -> Configuration -> Purge Everything"
    fi

    exit 0
  fi
  sleep 1
done

echo "!!! New version did not come up. Rolling back." >&2
rsync -a --delete "$ROLLBACK"/ "$APP_DIR"/
systemctl restart weekofmeals
rm -rf "$ROLLBACK"
echo "!!! Rolled back to the previous release. Check: journalctl -u weekofmeals -n 50" >&2
exit 1
