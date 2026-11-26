# Deploying TicketManager on a Proxmox VM

This runbook takes you from an empty Proxmox host to TicketManager running over HTTPS with
nightly backups. It takes about an hour the first time. Commands run on the VM unless the step
says otherwise.

Everything runs in Docker Compose on one VM:

| Service    | What it does                                                              |
| ---------- | ------------------------------------------------------------------------- |
| `web`      | nginx: serves the app, HTTPS, security headers, rate limits, proxies /api |
| `api`      | The API. Applies database migrations on start                             |
| `worker`   | Sends email from the outbox                                               |
| `postgres` | The database. Uploaded bills and generated ZIPs are stored here too       |
| `redis`    | Wakes the worker; holds nothing that needs a backup                       |
| `backup`   | Nightly `pg_dump` of the whole database into `backups/`                   |
| `mailpit`  | Catches email when no real mailbox is set; open only on the VM itself     |

## 1. Create the VM

In the Proxmox web UI, **Create VM**:

- ISO: **Ubuntu Server 24.04 LTS** (Debian 12 works the same way).
- CPU 2 cores, memory 4 GB, disk 40 GB (more if you expect many scanned bills: each GB of
  bills needs about the same again for each kept backup).
- Network: your LAN bridge (usually `vmbr0`).
- Options: turn on **QEMU Guest Agent**.

Install Ubuntu with the OpenSSH server. Give the VM a fixed address: a DHCP reservation on your
router, or a static IP during install. Then on the VM:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install qemu-guest-agent git openssl ufw
sudo timedatectl set-timezone Asia/Kolkata
```

## 2. Install Docker

Use Docker's own packages (the `docker.io` package in Ubuntu is too old):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Sign out and back in, then check: `docker compose version` (needs 2.20 or newer).

Firewall: only SSH and the web ports.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Docker publishes PostgreSQL, Redis and Mailpit on `127.0.0.1` only, so they are not reachable
from the network.

## 3. Pick a name and point it at the VM

Google sign-in and HTTPS need a host name, not a bare IP. Choose one such as
`expenses.yourcompany.com` and add a DNS **A record** pointing to the VM's IP. A private IP
(`192.168.x.x`) is fine if only your office uses the app; the DNS record can still be in your
public DNS, or in your router's or office DNS.

## 4. Get the code and set `.env`

```bash
sudo mkdir -p /opt/ticketmanager && sudo chown $USER /opt/ticketmanager
git clone https://github.com/bhusan-art/TicketManager.git /opt/ticketmanager
cd /opt/ticketmanager
cp .env.example .env
nano .env
```

Change these. The API refuses to start over HTTPS while the example secrets are still there.

| Setting                    | Value                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`               | `https://expenses.yourcompany.com`                                                                    |
| `WEB_PORT` / `HTTPS_PORT`  | `80` / `443`                                                                                          |
| `POSTGRES_PASSWORD`        | Output of `openssl rand -hex 24`. Set it **before the first start**: the database keeps the first one |
| `JWT_SECRET`               | Output of `openssl rand -base64 48`                                                                   |
| `BOOTSTRAP_ADMIN_EMAIL`    | Your email                                                                                            |
| `BOOTSTRAP_ADMIN_PASSWORD` | A strong temporary password; you change it after the first sign-in                                    |
| `SMTP_*`, `MAIL_FROM`      | Your mailbox, e.g. Gmail with an app password (see the comments in `.env`)                            |
| `GOOGLE_CLIENT_*`          | Optional; see the README section on Google sign-in                                                    |
| `TZ`, `BACKUP_*`           | When backups run and how long they are kept (defaults: 02:30 IST, 14 days)                            |

`chmod 600 .env` so only you can read it.

## 5. Get a certificate

nginx serves HTTPS as soon as `deploy/certs/fullchain.pem` and `deploy/certs/privkey.pem`
exist, and redirects plain HTTP to `PUBLIC_URL`. It reloads every 6 hours, so renewed
certificates are picked up without a restart. Pick one way:

**A. Let's Encrypt, server reachable from the internet on port 80.** Start the app over HTTP
first (step 6), then:

```bash
sudo apt -y install certbot
sudo certbot certonly --webroot -w /opt/ticketmanager/deploy/acme \
  -d expenses.yourcompany.com --deploy-hook /opt/ticketmanager/deploy/install-cert.sh
```

**B. Let's Encrypt, office-only server (DNS check).** Works when the VM is not reachable from
the internet. You need a DNS provider with a certbot plugin, for example Cloudflare:

```bash
sudo apt -y install certbot python3-certbot-dns-cloudflare
sudo install -m 600 /dev/null /root/cloudflare.ini
echo "dns_cloudflare_api_token = <token with Zone:DNS:Edit>" | sudo tee /root/cloudflare.ini
sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/cloudflare.ini \
  -d expenses.yourcompany.com --deploy-hook /opt/ticketmanager/deploy/install-cert.sh
```

Certbot renews both kinds by itself (a systemd timer) and runs the hook each time.

**C. A certificate you already have** (from your company or IT): copy it to
`deploy/certs/fullchain.pem` (certificate plus intermediates) and the key to
`deploy/certs/privkey.pem`.

**D. Just trying it out:** `./deploy/self-signed-cert.sh expenses.yourcompany.com`. Browsers
warn, and Google sign-in won't work with it.

## 6. Start

```bash
cd /opt/ticketmanager
docker compose up -d --build
docker compose ps
```

All services should say `healthy` after a minute or two (the first build takes several
minutes). Open `https://expenses.yourcompany.com`:

1. Sign in with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`.
2. Change your password under **Profile**, then delete `BOOTSTRAP_ADMIN_PASSWORD` from `.env`.
3. Check **Dashboard → System status**: services up, email worker up, last backup OK.
4. Add departments, categories and users. Each user gets an invitation email.

For Google sign-in, add `https://expenses.yourcompany.com` as an authorized JavaScript origin
and `https://expenses.yourcompany.com/api/v1/auth/google/callback` as a redirect URI in the
Google Cloud console.

## 7. Backups

- **What:** one file per night, `backups/ticketmanager-YYYY-MM-DD-HHMMSS.dump`, made with
  `pg_dump` and checked with `pg_restore --list` before it is kept. It contains everything:
  users, claims, payments, audit log, uploaded bills and export ZIPs. Redis needs no backup.
- **When:** every night at `BACKUP_TIME`, and also on start when the last good backup is more
  than a day old. Older than `BACKUP_KEEP_DAYS` are deleted.
- **Check:** the Admin dashboard shows the last backup and turns **Overdue** after 26 hours;
  `docker compose ps backup` is `unhealthy` then too. Logs: `docker compose logs backup`.
- **Now:** `docker compose exec backup sh /scripts/backup.sh once`.

A backup on the same disk doesn't survive the disk. Keep copies somewhere else, ideally both:

- **Proxmox backup of the whole VM:** Datacenter → Backup → Add, schedule nightly at 03:30
  (after the database dump), mode Snapshot, to a storage that is not the VM's own disk (a NAS or
  Proxmox Backup Server).
- **Copy the dumps to another machine**, e.g. a NAS share, with cron on the VM
  (`crontab -e`):

  ```
  15 3 * * * rsync -a --delete /opt/ticketmanager/backups/ nas:/volume1/backups/ticketmanager/
  ```

Keep a copy of `.env` in a safe place too (a password manager): the backups don't include it.

## 8. Restore

`deploy/restore.sh` replaces **all** data with a backup. It stops the app, recreates the
database, loads the file, and starts the app again, which then applies any newer migrations.

```bash
cd /opt/ticketmanager
docker compose exec backup sh /scripts/backup.sh once          # keep today's data, just in case
ls -lt backups/ | head                             # pick a file
./deploy/restore.sh backups/ticketmanager-2026-11-26-023000.dump
```

It asks you to type `RESTORE`. Afterwards it prints the number of users, vouchers and files.

**Restoring on a new VM** (the old one is gone): do steps 1 to 4, ideally with your saved
`.env` (new secrets also work; everyone just signs in again), copy the backup file into
`backups/`, then:

```bash
docker compose up -d --build
./deploy/restore.sh --yes backups/<file>.dump
```

Then step 5 for the certificate. Practise this once on a spare VM, so you know it works and how
long it takes. CI runs the same backup, wipe and restore on every pull request.

## 9. Updating

```bash
cd /opt/ticketmanager
docker compose exec backup sh /scripts/backup.sh once
git pull
docker compose up -d --build
docker compose ps
```

Database changes apply themselves when the API starts. If something goes wrong, go back:
`git checkout <previous commit>`, `docker compose up -d --build`, and restore the backup you
just took.

## 10. Health and logs

| Check                                          | How                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Everything at a glance                         | Admin dashboard → System status (services, email worker, unsent email, last backup)            |
| From outside, for a monitor (e.g. Uptime Kuma) | `https://<host>/api/v1/health`: 200 when the database, Redis and the worker are up, 503 if not |
| Containers                                     | `docker compose ps` (each service has a health check)                                          |
| Logs                                           | `docker compose logs -f --tail=100 api` (or `web`, `worker`, `backup`)                         |

The API and worker log one JSON line per event, nginx one JSON line per request with the same
`request_id` the API logs, so you can follow one request through both. Docker keeps 5 files of
10 MB per service and deletes older ones.

## Security in place

- HTTPS only (HSTS), TLS 1.2 and 1.3; sign-in cookies are `Secure`, `HttpOnly`, `SameSite=Strict`.
- Content Security Policy and the usual headers (no framing, no sniffing, strict referrer).
- Rate limits per address: sign-in, password reset and shared download links get about 10 a
  minute at nginx and a few dozen per 15 minutes in the API; the rest of the API 20 a second.
  Accounts also lock for 15 minutes after 5 wrong passwords.
- Only ports 80 and 443 are open. The database, Redis and Mailpit listen on the VM only.
- The API refuses to start over HTTPS with the example secrets from `.env.example`.

## Troubleshooting

| Problem                                                             | Fix                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `api` keeps restarting                                              | `docker compose logs api`. "Invalid environment configuration" names the setting to fix                       |
| `password authentication failed` after changing `POSTGRES_PASSWORD` | The database keeps its first password. Put the old one back, or change it inside PostgreSQL first             |
| Browser warns about the certificate                                 | Self-signed or wrong name: check `deploy/certs` and that `PUBLIC_URL` matches the name                        |
| HTTP doesn't redirect to HTTPS                                      | `docker compose logs web` should say "HTTPS on". Both certificate files must exist                            |
| "Too many requests"                                                 | Wait a minute. Many people behind one address (VPN)? Raise the `rate=` values in `apps/web/nginx/common.conf` |
| Emails stay "Waiting to send"                                       | Admin → Email log shows the error; check `SMTP_*` in `.env`, then `docker compose up -d worker`               |
| Backup overdue                                                      | `docker compose logs backup`; usually a full disk (`df -h`)                                                   |
