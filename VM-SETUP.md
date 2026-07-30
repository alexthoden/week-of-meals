# Putting Week of Meals on a free VM

Everything here is one-time setup. Budget about an hour, most of it waiting on
DNS and Google's consent screen.

**The app itself is unchanged.** Not a port, not a rewrite — the same Express
server, the same JSON file on disk, the same AnyList library. That is the whole
reason for choosing this route: nothing that worked at home can break in
translation. What follows is only about the machine it runs on and how your
family reaches it.

---

## What you are building

```
   phone / laptop
        │  https://meals.yourdomain.com
        ▼
  ┌──────────────────────────────────┐
  │  Cloudflare                      │
  │   • terminates TLS               │
  │   • Access checks your Google    │  ← nobody else gets past here
  │     sign-in against a policy     │
  │   • caches images at the edge    │
  └───────────────┬──────────────────┘
                  │  outbound-only tunnel, no open ports
                  ▼
  ┌──────────────────────────────────┐
  │  Google Cloud e2-micro (free)    │
  │                                  │
  │  cloudflared ──► 127.0.0.1:4321  │
  │                    │             │
  │                Node / Express    │
  │                    │             │
  │            /var/lib/weekofmeals  │
  │              db.json, images/    │
  └──────────────────────────────────┘
```

### Why there are no open ports

`cloudflared` dials *out* to Cloudflare and holds the connection open. Traffic
comes back down that connection. The VM needs no inbound firewall rule, no
public IP, and no certificate — there is nothing listening on the internet to
find, port-scan, or brute-force. The app binds to `127.0.0.1` and is reachable
only from inside the machine.

This is the single biggest security difference from the usual "rent a VPS and
open 443" approach, and it is free.

### What it costs

| Item | Cost |
| --- | --- |
| e2-micro VM, 30 GB standard disk | £0 — Always Free, no expiry |
| Cloudflare Tunnel | £0 |
| Cloudflare Access, up to 50 users | £0 |
| Domain name | **~$10/year** — the only bill |

⚠️ **The one way this stops being free:** Google's Always Free tier includes
about **1 GB/month of egress**. Recipe photos would eat into that. Cloudflare
caches images at the edge, so after the first view they are served without
touching your VM — which is what keeps you under the limit. Don't disable
caching.

⚠️ **Two traps worth naming.** Pick a **Standard persistent disk**, not balanced
or SSD — only standard is in the free tier. And if you were considering AWS EC2
instead, its free tier is **12 months**, not permanent.

---

## Step 1 — Create the VM

In the [Google Cloud console](https://console.cloud.google.com/), **Compute
Engine → VM instances → Create instance**. The free tier is specific about
these, so match them exactly:

| Setting | Value |
| --- | --- |
| Region | `us-west1`, `us-central1` or `us-east1` — **only these are free** |
| Machine type | `e2-micro` (series E2, shared-core) |
| Boot disk image | Debian 12 or Ubuntu 24.04 LTS |
| Boot disk type | **Standard persistent disk** |
| Boot disk size | 30 GB (the free maximum) |
| Firewall | Leave **both** HTTP and HTTPS **unticked** |

Leave the firewall boxes unticked deliberately. You do not need them, and every
port you don't open is a thing you don't have to defend.

SSH in from the console's **SSH** button, or `gcloud compute ssh <name>`.

---

## Step 2 — Get the code onto the VM

From your own machine, in the project directory:

```bash
gcloud compute scp --recurse . <vm-name>:~/week-of-meals \
  --zone us-central1-a
```

Or on the VM, if you keep the project in Git:

```bash
sudo apt update && sudo apt install -y git
git clone <your-repo-url> ~/week-of-meals
```

Or plainest of all — upload the zip through the browser SSH window's **Upload
file** button, then `unzip week-of-meals.zip`.

---

## Step 3 — Run the setup script

```bash
cd ~/week-of-meals
sudo bash deploy/setup.sh
```

It is idempotent — safe to re-run — and it will:

1. Add 2 GB of swap. **This matters:** an e2-micro has 1 GB of RAM and no swap,
   and `npm ci` peaks above that. Without swap the OOM killer stops the install
   and it looks like an unexplained hang.
2. Install Node 22 from NodeSource.
3. Create a `weekofmeals` system user with no login shell.
4. Copy the code to `/opt/weekofmeals` and install production dependencies.
5. Create `/etc/weekofmeals/env` from the template, root-owned, mode 0640.
6. Install and enable the systemd service and the nightly backup timer.
7. Seed ten starter recipes — **only if no database exists**.
8. Turn on unattended security updates, rebooting at 04:00 when a kernel needs it.
9. Start the service, unless the config still has placeholders.

It will stop before starting and tell you to edit the config. That's Step 4.

---

## Step 4 — Fill in AnyList

```bash
sudo nano /etc/weekofmeals/env
```

Set these two, leave the Cloudflare ones blank for now:

```ini
ANYLIST_EMAIL=you@example.com
ANYLIST_PASSWORD=your-anylist-password
```

Then:

```bash
sudo systemctl restart weekofmeals
curl localhost:4321/api/healthz
```

You should get `{"ok":true,"recipes":10,...}`. The app is now running, reachable
from nowhere but this machine. That's correct — the tunnel comes next.

---

## Step 5 — A domain on Cloudflare

Cloudflare Tunnel needs a hostname in a zone on your Cloudflare account.

* **Buying one:** Cloudflare Registrar sells at cost — around $10/year for a
  `.com`, and it lands in your account already configured.
* **Domain you already own:** add it to Cloudflare (free plan) and point your
  registrar's nameservers at the two Cloudflare gives you. Propagation is
  usually under an hour.

You'll use a subdomain such as `meals.yourdomain.com`. You do **not** need to
create the DNS record by hand — `cloudflared` does that in Step 6.

---

## Step 6 — Install the tunnel

On the VM:

```bash
# Cloudflare's apt repository
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

Authenticate. This prints a URL — open it on any machine, sign in, and pick your
domain:

```bash
cloudflared tunnel login
```

Create the tunnel and point a hostname at it:

```bash
cloudflared tunnel create week-of-meals
cloudflared tunnel route dns week-of-meals meals.yourdomain.com
```

`tunnel create` prints a **tunnel ID** and writes a credentials JSON file. Now
write the config, substituting your own ID and hostname —
`deploy/cloudflared-config.yml` in this project is a commented reference copy:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/
sudo nano /etc/cloudflared/config.yml
```

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /etc/cloudflared/<TUNNEL-ID>.json
ha-connections: 2

ingress:
  - hostname: meals.yourdomain.com
    service: http://127.0.0.1:4321
  - service: http_status:404
```

Install it as a service and start it:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared --no-pager
```

Visit `https://meals.yourdomain.com`. **The app should load — with no sign-in
yet.** It is briefly open to anyone who knows the URL, so go straight to Step 7.

---

## Step 7 — Put Cloudflare Access in front of it

Open the [Zero Trust dashboard](https://one.dash.cloudflare.com/). On first use
it asks you to choose a **team name** — this becomes
`https://<team>.cloudflareaccess.com`, and you'll need it in Step 8. Choose the
**Free** plan (up to 50 users).

### 7a — Add Google as a login method

**Settings → Authentication → Login methods → Add new → Google.**

Cloudflare asks for a Google OAuth client ID and secret, so there is a little
Google Cloud Console work — this is the one piece that isn't click-through:

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs &
   Services → OAuth consent screen**. External. Fill in the app name and your
   email. You can leave it in **Testing**; no verification is needed for a
   handful of household accounts.
2. **Credentials → Create Credentials → OAuth client ID → Web application.**
3. Set **Authorised redirect URI** to exactly:
   `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback`
4. Copy the client ID and secret into Cloudflare, then **Test** the connection.

> **Want to skip all of that?** Cloudflare's **One-time PIN** login method needs
> no configuration at all — it emails a six-digit code to any address on your
> policy. Less slick than a Google button, but zero setup, and it works with
> Gmail addresses just the same. If the Google client feels like a lot of
> ceremony for four people, use this instead.

### 7b — Create the application

**Access → Applications → Add an application → Self-hosted.**

| Field | Value |
| --- | --- |
| Application name | `Week of Meals` |
| Session duration | 1 month (fewer sign-ins on phones) |
| Subdomain / domain | `meals` / `yourdomain.com` |

### 7c — Create the policy

Add a policy on that application:

| Field | Value |
| --- | --- |
| Name | `Household` |
| Action | **Allow** |
| Include → selector | **Emails** |
| Value | your Gmail addresses, one per line |

Save. Now reload `https://meals.yourdomain.com` in a private window — you should
be sent to a Cloudflare sign-in page, and only your listed addresses get
through.

---

## Step 8 — Tell the app to verify Access too

Access already turns strangers away at the edge. Verifying the assertion at the
origin as well means that anything reaching port 4321 by another route — a
future misconfiguration, another VM on the same network, a forgotten SSH tunnel
— is still refused. It costs one signature check per request.

Get the **Application Audience (AUD) Tag** from your Access application's
**Overview** tab. It's a long hex string.

```bash
sudo nano /etc/weekofmeals/env
```

```ini
CF_ACCESS_TEAM=ourhouse
CF_ACCESS_AUD=9f1c4e2b7a8d...
```

`CF_ACCESS_TEAM` is just the team name — if your login page is
`https://ourhouse.cloudflareaccess.com`, it's `ourhouse`.

```bash
sudo systemctl restart weekofmeals
sudo systemctl status weekofmeals --no-pager | head -3
```

The startup log should now read
`Sign-in: Cloudflare Access (ourhouse)`.

---

## Step 9 — Check it properly

Walk these in order. Each exercises a different piece, and the third is the one
people skip and regret.

1. **Load the app in a private window.** You get Cloudflare's sign-in, then the
   week view.
2. **Sign in with a Google account that is *not* on the policy.** You should be
   refused by Cloudflare. If you get in, fix the policy before going further.
3. **Confirm the origin refuses unsigned requests.** On the VM:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' localhost:4321/api/bootstrap
   ```
   Expect **401**. A `200` means `CF_ACCESS_TEAM` or `CF_ACCESS_AUD` isn't set,
   and your origin is trusting the edge blindly.
4. **Settings** should show *Signed in as you@gmail.com via Cloudflare Access*.
5. **Add a recipe with a photo**, then reload. Check the file landed:
   `ls /var/lib/weekofmeals/images/`
6. **Open cooking mode on a phone.** The badge should read **"Screen stays on"**.
   You're on HTTPS now, so the real Wake Lock API works rather than the video
   fallback.
7. **Export to AnyList — point it at a scratch list the first time.**
8. **Force a backup** and confirm it works:
   ```bash
   sudo systemctl start weekofmeals-backup
   ls -la /var/lib/weekofmeals/backups/
   ```

---

## Living with it

### Where things are

| | |
| --- | --- |
| Code | `/opt/weekofmeals` |
| Data | `/var/lib/weekofmeals/` — `db.json`, `images/`, `backups/` |
| Config and secrets | `/etc/weekofmeals/env` (root:weekofmeals, 0640) |
| Logs | `journalctl -u weekofmeals -f` |
| Tunnel logs | `journalctl -u cloudflared -f` |

### Everyday commands

```bash
sudo systemctl restart weekofmeals      # restart
journalctl -u weekofmeals -n 50         # recent logs
journalctl -u weekofmeals -p err        # errors only
curl localhost:4321/api/healthz         # is it alive
systemctl list-timers weekofmeals\*     # when is the next backup
```

### Deploying a change

Get the new code onto the VM, then:

```bash
cd ~/week-of-meals && sudo bash deploy/update.sh
```

It snapshots your data first, keeps the old release, and **rolls back
automatically** if the new version doesn't answer its health check within
fifteen seconds. Your recipes are never touched.

**One thing worth setting up once:** your tunnel's hostname is proxied through
Cloudflare's edge, which caches `.js`/`.css`/images by file extension no matter
what this server sends. Push a fix to `app.js` and someone can still see the
old copy until that cache clears — which looks exactly like the deploy failed
silently. Set `CF_ZONE_ID` and a cache-purge-scoped `CF_API_TOKEN` in
`/etc/weekofmeals/env` (see `deploy/env.example` for exactly where to find
them) and `update.sh` purges the cache automatically as its last step. Without
them, purge by hand after a frontend change:
**dashboard → Caching → Configuration → Purge Everything.**

### Backups

Four layers, which is not excessive for the only copy of your family's recipes:

1. **In-app** — Settings → *Download a backup* gives you a JSON file.
2. **On start** — the app snapshots `db.json` into `backups/` every restart.
3. **Nightly** — the systemd timer archives `db.json` *and* `images/` at 03:20,
   keeping 30 days. It refuses to archive a `db.json` that doesn't parse, so a
   corrupt file can't quietly rotate away your good copies.
4. **Off the box** — set `BACKUP_REMOTE` and the nightly archive is copied out
   with `rclone`. **Layers 1–3 all die with the VM. Only this one survives it.**

Cloudflare R2 gives 10 GB free and is a natural target:

```bash
sudo apt install -y rclone
rclone config          # new remote, type "s3", provider "Cloudflare R2"
```

Then in `/etc/weekofmeals/env`:

```ini
BACKUP_REMOTE=r2:week-of-meals-backups
```

### Restoring

```bash
sudo systemctl stop weekofmeals
cd /var/lib/weekofmeals
sudo tar -xzf backups/week-of-meals-<stamp>.tar.gz
sudo chown -R weekofmeals:weekofmeals db.json images
sudo systemctl start weekofmeals
```

Or use Settings → *Restore* in the app with a downloaded JSON file, which
snapshots the current state before overwriting.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm ci` hangs or is killed during setup | Out of memory. Swap wasn't enabled — re-run `sudo bash deploy/setup.sh`, which sets it up in step 1. |
| Service won't start | `journalctl -u weekofmeals -n 50`. Usually a typo in `/etc/weekofmeals/env`. Note that systemd does **not** do shell quoting — don't wrap values in quotes. |
| Tunnel up, site returns 502 | The app isn't listening. `curl localhost:4321/api/healthz` on the VM. |
| Site returns 404 through the tunnel | Hostname in `/etc/cloudflared/config.yml` doesn't match the DNS record. `cloudflared tunnel route dns` again. |
| Everything 401s in the browser | `CF_ACCESS_AUD` is from a different application, or `CF_ACCESS_TEAM` has the full domain instead of the team name. |
| Sign-in loops forever | The Google redirect URI must be exactly `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. |
| Cooking mode says "Screen may sleep" | You're on `http://` or an IP rather than the HTTPS hostname. |
| Photos load slowly, egress climbing | Cloudflare caching is off or bypassed. Check for a Page Rule or cache-bypass setting on the hostname. |
| AnyList export fails after months of working | The library is reverse-engineered and AnyList shipped an update. `journalctl -u weekofmeals -p err`. The Copy button on the list still works meanwhile. |

### If the VM is reclaimed or lost

You are rebuilding from `deploy/setup.sh` plus one archive. Create a new
e2-micro, copy the code and your latest backup across, run the setup script,
restore, then re-point the tunnel:

```bash
cloudflared tunnel route dns week-of-meals meals.yourdomain.com
```

The tunnel credentials JSON can be reused, so the hostname and your Access
policy carry over untouched. This is worth actually rehearsing once while you
still remember how it all fits together.
