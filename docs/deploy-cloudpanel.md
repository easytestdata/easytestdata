# Deploy EasyTestData Cloud on CloudPanel

EasyTestData Cloud is one Node.js process and one Postgres database. This guide runs it on a
[CloudPanel](https://www.cloudpanel.io) VM behind CloudPanel's nginx, with Cloudflare in front.
No Docker is needed. The marketing site is hosted separately on Cloudflare Pages
([cloudflare-pages.md](cloudflare-pages.md)).

To run EasyTestData just for yourself, you don't need any of this: see
[run-locally.md](run-locally.md).

## 1. Prerequisites

- A VM with CloudPanel installed, and a domain for the app (for example `app.easytestdata.com`)
  proxied through Cloudflare.
- Node.js 24, the version the project builds and tests on (chosen when you create the Node.js site
  below; 22.13 or later also works).
- pnpm 9: `corepack enable && corepack prepare pnpm@9.15.4 --activate` as the site user.

## 2. Install Postgres

```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres createuser --pwprompt eztd      # choose a strong password
sudo -u postgres createdb --owner eztd eztd
```

The database is `eztd`, owned by the role `eztd`. Postgres listens on localhost only by default;
keep it that way. The schema is created by the app on first start.

## 3. Create the Node.js site

In CloudPanel: **Add Site > Create a Node.js Site**. Enter the app domain, pick Node.js 24, and
set the **App Port** to a free port in 28000-28999, for example `28000`. CloudPanel creates a
site user and an nginx vhost that proxies the domain to `127.0.0.1:<App Port>`.

As the site user, clone the repository into the site's root:

```bash
cd ~/htdocs/app.easytestdata.com
git clone https://github.com/easytestdata/easytestdata.git .
```

## 4. Environment

Create `.env` in the repository root (readable by the site user only: `chmod 600 .env`):

```bash
DEPLOYMENT=cloud
NODE_ENV=production
PORT=28000                         # the site's App Port
DATABASE_URL=postgresql://eztd:<password>@127.0.0.1:5432/eztd
APP_URL=https://app.easytestdata.com
MARKETING_URL=https://easytestdata.com
JWT_SECRET=<at least 32 characters: openssl rand -hex 32>
TOKEN_ENCRYPTION_KEY=<64 hex characters: openssl rand -hex 32>

# The Intuit developer app used to connect sandboxes (its Development keys)
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=

# Sign-in providers
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
INTUIT_SSO_CLIENT_ID=
INTUIT_SSO_CLIENT_SECRET=

# Comma-separated emails that become admins when they sign in
ADMIN_EMAILS=you@example.com

# One proxy (CloudPanel's nginx) sits in front of the app
TRUST_PROXY=1

# Optional: error tracking
SENTRY_DSN=
```

If the database password contains special characters (`@`, `:`, `/`, `#`, `%` and the like),
URL-encode them in `DATABASE_URL` (for example `@` becomes `%40`).

Set `DEPLOYMENT=cloud` explicitly, so the server can never be taken for the no-login local mode:
with it, a missing `DATABASE_URL` or secret stops startup with an error. Keep a copy of `TOKEN_ENCRYPTION_KEY` somewhere safe: the stored QuickBooks tokens cannot
be read without it. The server refuses to start with a default or short `JWT_SECRET` or a
`TOKEN_ENCRYPTION_KEY` that is not 64 hex characters.

Optional: `HOST=127.0.0.1` (listen only for nginx; the default `0.0.0.0` relies on the VM's
firewall to keep the app port closed), `QBO_WORKER_CONCURRENCY` (QuickBooks jobs that run at
once, default 6), `JOB_ARTIFACTS_DIR` (download files, default `data/exports` in the
repository) and `JOB_ARTIFACT_TTL_DAYS` (default 7).

## 5. Build

```bash
pnpm install --frozen-lockfile && pnpm run build
```

## 6. Start command

The server is started from the repository root with:

```bash
node --env-file=.env packages/server/src/start.js
```

It runs the database migrations, then starts the job runner and the web server. Let PM2 keep it
running: install it as the site user (`npm install -g pm2`) and put an `ecosystem.config.cjs`
next to `.env`:

```js
module.exports = {
  apps: [
    {
      name: "easytestdata",
      script: "packages/server/src/start.js",
      node_args: "--env-file=.env",
      // Stopping waits for running jobs to wind down; give it 30 s before a hard kill.
      kill_timeout: 30000
    }
  ]
};
```

```bash
pm2 start ecosystem.config.cjs && pm2 save
pm2 startup      # prints a command that starts PM2 at boot
```

`pm2 startup` does not change anything itself: it prints a `sudo env PATH=... pm2 startup ...`
command. Run that printed command as root (or with sudo) once.

On stop or restart the server needs time to shut down cleanly: it stops taking requests, lets
running jobs finish for up to 15 seconds, then stops them at their next batch and records what
they created. Whatever manages the process must send a stop signal (SIGTERM or SIGINT; both
start this drain) and wait about 30 seconds before SIGKILL. The `kill_timeout` above does that
for PM2.

One server runs per database. A start that fails with "Another EasyTestData server is already
running against this database." found another server process still holding it (a second PM2 app
or a manual start): it exits without migrating or touching jobs. Stop the other process first. A
running server that loses its connection holding that lock (e.g. Postgres restarted) shuts down
with exit code 1 so PM2 restarts it.

## 7. Cloudflare in front

With Cloudflare proxying the domain, every request reaches nginx from a Cloudflare address. So
that rate limits and logs see the real visitor, restore the client IP in the site's vhost
(CloudPanel: **Sites > the site > Vhost**), inside the `server` block:

```nginx
# Cloudflare ranges: keep in sync with https://www.cloudflare.com/ips/
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;
real_ip_header CF-Connecting-IP;
```

In the `location` that proxies to the app, pass the restored address on and drop any
client-supplied chain: replace the existing `proxy_set_header X-Forwarded-For` line (CloudPanel's
Node.js vhost already has one) with this one, rather than adding a second:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

`TRUST_PROXY=1` then makes the app trust exactly that one hop. Use Cloudflare's **Full
(strict)** SSL mode with CloudPanel's certificate.

## 8. Redirect URIs to register

Replace `APP_URL` with your app URL (for example `https://app.easytestdata.com`):

| Where                                                                  | Redirect URI                          |
| ---------------------------------------------------------------------- | ------------------------------------- |
| Intuit developer app for sandboxes (`QBO_CLIENT_ID`), Development keys | `APP_URL/api/v1/connections/callback` |
| Google OAuth client                                                    | `APP_URL/api/v1/auth/google/callback` |
| GitHub OAuth app                                                       | `APP_URL/api/v1/auth/github/callback` |
| Intuit app for sign-in (`INTUIT_SSO_CLIENT_ID`)                        | `APP_URL/api/v1/auth/intuit/callback` |

## 9. Backups

A nightly `pg_dump` with 14 days of retention, in the `postgres` user's crontab
(`sudo -u postgres crontab -e`; `%` must be escaped in crontab):

```cron
15 3 * * * pg_dump -Fc eztd > /backups/eztd-$(date +\%F).dump && find /backups -name 'eztd-*.dump' -mtime +14 -delete
```

Create `/backups` first (`sudo install -d -o postgres -m 700 /backups`) and copy the dumps off
the VM regularly. The command it runs each night is
`pg_dump -Fc eztd > /backups/eztd-$(date +%F).dump`. To restore into an empty `eztd` database:
`sudo -u postgres pg_restore --no-owner --role=eztd -d eztd /backups/eztd-<date>.dump`.

## 10. Upgrade

```bash
cd ~/htdocs/app.easytestdata.com
git pull
pnpm install --frozen-lockfile && pnpm run build
pm2 restart easytestdata
```

Migrations run when the server starts. `GET /health` answers `{"status":"ok"}` once it is up.
