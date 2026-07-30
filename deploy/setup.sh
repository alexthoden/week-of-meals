#!/usr/bin/env bash
#
# Provision a fresh Debian or Ubuntu VM to run Week of Meals.
#
#   sudo bash deploy/setup.sh
#
# Safe to run again: it updates the code and units, and leaves your data,
# your photos and /etc/weekofmeals/env alone.
#
set -euo pipefail

APP_USER=weekofmeals
APP_DIR=/opt/weekofmeals
DATA_DIR=/var/lib/weekofmeals
ENV_DIR=/etc/weekofmeals
NODE_MAJOR=22

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
command -v apt-get >/dev/null || die "This script expects Debian or Ubuntu."

SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/package.json" ] || die "Run this from inside the project directory."

FIRST_RUN=no
[ -d "$APP_DIR" ] || FIRST_RUN=yes

# --------------------------------------------------------------- packages --

say "1/9  Swap"
# An e2-micro has 1 GB of RAM and no swap by default. `npm ci` peaks well above
# that and gets shot by the OOM killer, which looks like a mysterious hang.
# 2 GB of swap on the boot disk costs nothing and makes the box behave.
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer RAM, but use swap rather than dying.
  sysctl -q vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  info "2 GB swap enabled"
else
  info "swap already present ($(free -h | awk '/Swap/{print $2}'))"
fi

say "2/9  System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync unattended-upgrades >/dev/null
info "base packages ready"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  info "installing Node ${NODE_MAJOR}"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
info "node $(node --version)"

# ------------------------------------------------------- user and folders --

say "3/9  Service account"
if ! id "$APP_USER" >/dev/null 2>&1; then
  # No login shell and no home worth speaking of: this account exists to own
  # one directory and run one process.
  useradd --system --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$APP_USER"
  info "created $APP_USER"
else
  info "$APP_USER already exists"
fi

install -d -m 0755 -o root -g root "$APP_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR/images"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR/backups"
install -d -m 0750 -o root -g "$APP_USER" "$ENV_DIR"

# ------------------------------------------------------------------- code --

say "4/9  Application code"
# --delete keeps the deployed tree honest, but never touches data or secrets,
# which live outside APP_DIR precisely so that this is safe.
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'data' --exclude '.env' \
  "$SRC"/ "$APP_DIR"/
chown -R root:root "$APP_DIR"
info "synced to $APP_DIR"

cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --silent
else
  npm install --omit=dev --silent
fi
info "dependencies installed"

# ---------------------------------------------------------------- secrets --

say "5/9  Configuration"
if [ ! -f "$ENV_DIR/env" ]; then
  cp "$APP_DIR/deploy/env.example" "$ENV_DIR/env"
  chown root:"$APP_USER" "$ENV_DIR/env"
  chmod 0640 "$ENV_DIR/env"
  warn "created $ENV_DIR/env from the template — you must edit it"
  NEEDS_CONFIG=yes
else
  chown root:"$APP_USER" "$ENV_DIR/env"
  chmod 0640 "$ENV_DIR/env"
  info "$ENV_DIR/env already present, left alone"
  NEEDS_CONFIG=no
fi

# ------------------------------------------------------------------ units --

say "6/9  systemd"
install -m 0644 "$APP_DIR/deploy/weekofmeals.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/weekofmeals-backup.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/weekofmeals-backup.timer" /etc/systemd/system/
chmod +x "$APP_DIR/deploy/backup.sh" "$APP_DIR/deploy/update.sh" 2>/dev/null || true
systemctl daemon-reload
systemctl enable weekofmeals.service >/dev/null 2>&1
systemctl enable weekofmeals-backup.timer >/dev/null 2>&1
info "units installed and enabled"

# ------------------------------------------------------------- first data --

say "7/9  Starter data"
if [ ! -f "$DATA_DIR/db.json" ]; then
  sudo -u "$APP_USER" DATA_FILE="$DATA_DIR/db.json" node "$APP_DIR/server/seed.js" >/dev/null
  info "seeded ten starter recipes"
else
  info "database already exists — not touched"
fi

# ------------------------------------------------------------ unattended --

say "8/9  Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTO'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTO
# Reboot at 4am if a kernel update needs it, which is after the 03:20 backup.
sed -i 's|^//Unattended-Upgrade::Automatic-Reboot ".*";|Unattended-Upgrade::Automatic-Reboot "true";|' \
  /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null || true
sed -i 's|^//Unattended-Upgrade::Automatic-Reboot-Time ".*";|Unattended-Upgrade::Automatic-Reboot-Time "04:00";|' \
  /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null || true
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
info "enabled"

# ---------------------------------------------------------------- restart --

say "9/9  Starting the service"
if [ "$NEEDS_CONFIG" = "yes" ]; then
  warn "not starting yet — $ENV_DIR/env still has placeholder values"
else
  systemctl restart weekofmeals.service
  sleep 2
  if systemctl is-active --quiet weekofmeals.service; then
    PORT_IN_USE=$(grep -oP '^PORT=\K.*' "$ENV_DIR/env" 2>/dev/null || echo 4321)
    if curl -fsS --max-time 5 "http://127.0.0.1:${PORT_IN_USE}/api/healthz" >/dev/null 2>&1; then
      info "running and answering on port ${PORT_IN_USE}"
    else
      warn "started but not answering yet — check: journalctl -u weekofmeals -n 40"
    fi
  else
    die "failed to start. Run: journalctl -u weekofmeals -n 40"
  fi
fi

# ------------------------------------------------------------------- next --

cat <<NEXT

  ------------------------------------------------------------------
  Installed.

    code    $APP_DIR
    data    $DATA_DIR        (db.json, images/, backups/)
    config  $ENV_DIR/env
    logs    journalctl -u weekofmeals -f

NEXT

if [ "$NEEDS_CONFIG" = "yes" ]; then
cat <<TODO
  Next, in order:

    1. sudo nano $ENV_DIR/env        # AnyList details, then Access details
    2. sudo systemctl restart weekofmeals
    3. Follow "Step 4" in VM-SETUP.md to install the Cloudflare tunnel.

TODO
fi

if [ "$FIRST_RUN" = "yes" ]; then
cat <<PORTS
  This service listens on localhost only once the tunnel is in place.
  Do not open a firewall port for it — cloudflared connects outbound, so
  there is nothing to expose. See VM-SETUP.md, "Why there are no open ports".

PORTS
fi
