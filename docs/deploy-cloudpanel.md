# Deploy EasyTestData Cloud on CloudPanel

EasyTestData Cloud is one Node.js process and one Postgres database. This guide runs it on a
[CloudPanel](https://www.cloudpanel.io) VM behind CloudPanel's nginx, with Cloudflare in front.
No Docker is needed. The marketing site is hosted separately on Cloudflare Pages
([cloudflare-pages.md](cloudflare-pages.md)).

To run EasyTestData just for yourself, you don't need any of this: see
[run-locally.md](run-locally.md).

The commands below use `app.easytestdata.com` for the app domain; use yours.

## 1. Prerequisites

- A VM with CloudPanel installed, and a domain for the app proxied through Cloudflare (a DNS
  record pointing at the VM, orange cloud on).
- Node.js 24, the version the project builds and tests on (chosen when you create the Node.js site
  below; 22.13 or later also works).
- A root (or sudo) login for step 2. CloudPanel's site users cannot use `sudo`.

## 2. Install Postgres

As root:

```bash
apt update && apt install -y postgresql
openssl rand -hex 24                             # the database password; keep it
sudo -u postgres createuser --pwprompt eztd      # paste that password twice
sudo -u postgres createdb --owner eztd eztd
```

The database is `eztd`, owned by the role `eztd`. A hex password can go into `DATABASE_URL`
as it is; a password with `@`, `:`, `/`, `#`, `%` and the like must be URL-encoded there (`@`
becomes `%40`). If Postgres is already installed for another site, skip `apt` and check first
that nothing named `eztd` exists: `sudo -u postgres psql -P pager=off -c "\du eztd" -c "\l eztd"`.

Postgres listens on localhost only by default; keep it that way. `ss -ltn | grep 5432` should show
only `127.0.0.1` (and `[::1]`). The schema is created by the app on first start.

## 3. Create the Node.js site

In CloudPanel: **Add Site > Create a Node.js Site**. Enter the app domain, pick Node.js 24, and
set the **App Port** to a free port in 28000-28999. CloudPanel creates a site user and an nginx
vhost that proxies the domain to `127.0.0.1:<App Port>`.

As the site user, set up pnpm (the version `package.json` pins) and PM2, then clone the
repository into the site's root:

```bash
corepack enable && corepack prepare pnpm@9.15.4 --activate
npm install -g pm2
cd ~/htdocs/app.easytestdata.com
git clone https://github.com/easytestdata/easytestdata.git .
```

The site user can check the database from here:
`psql -P pager=off "postgresql://eztd:<password>@127.0.0.1:5432/eztd" -c "select 1"`.

## 4. Environment

Create `.env` in the repository root. This writes it readable by the site user only, with the two
secrets generated into the file (they never appear on screen), and refuses to overwrite an
existing one:

```bash
[ -e .env ] && echo ".env already exists" || ( umask 077; cat > .env <<EOF
DEPLOYMENT=cloud
NODE_ENV=production
HOST=127.0.0.1
PORT=<App Port>
DATABASE_URL=postgresql://eztd:<password>@127.0.0.1:5432/eztd
APP_URL=https://app.easytestdata.com
MARKETING_URL=https://easytestdata.com
ALLOWED_ORIGINS=https://app.easytestdata.com
JWT_SECRET=$(openssl rand -hex 32)
TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)

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
ADMIN_EMAILS=

# One proxy (CloudPanel's nginx) sits in front of the app
TRUST_PROXY=1

# Optional error tracking (blank = off): the server's errors, and the web app's in the browser
SENTRY_DSN=
SENTRY_DSN_FRONTEND=
EOF
); ls -l .env
```

Then fill in the placeholders and keys (`nano .env`).

- `DEPLOYMENT=cloud` is set explicitly so the server can never be taken for the no-login local
  mode: with it, a missing `DATABASE_URL` or secret stops startup with an error. The server also
  refuses a default or short `JWT_SECRET` or a `TOKEN_ENCRYPTION_KEY` that is not 64 hex
  characters.
- `HOST=127.0.0.1` makes the app listen only for nginx on the same machine (the default
  `0.0.0.0` relies on the VM's firewall to keep the app port closed).
- `ALLOWED_ORIGINS` is the CORS allow-list. The web app is served from the same origin as the
  API, so it only needs the app URL; unset, it defaults to development `localhost` origins.
- `SENTRY_DSN_FRONTEND` is handed to the web app at runtime (and allowed by the CSP), so it takes
  effect on a restart, without a rebuild.
- The server starts with sign-in keys missing (it logs a warning), but you need at least one
  provider to sign in and the QBO keys to connect a sandbox.
- **Keep a copy of `TOKEN_ENCRYPTION_KEY` somewhere safe** (a password manager): the stored
  QuickBooks tokens cannot be read without it.

Optional: `QBO_WORKER_CONCURRENCY` (QuickBooks jobs that run at once, default 6),
`JOB_ARTIFACTS_DIR` (download files, default `data/exports` in the repository),
`JOB_ARTIFACT_TTL_DAYS` (default 7) and `LOG_LEVEL`.

## 5. Build

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@easytestdata/web...
```

Only the web app has a build step (the server serves `packages/web/dist`); the other packages
run from source.

## 6. Start with PM2

The server is started from the repository root with
`node --env-file=.env packages/server/src/start.js`: it runs the database migrations, then starts
the job runner and the web server. Let PM2 keep it running. Put an `ecosystem.config.cjs` next to
`.env` (git ignores this file, so a server's own settings never block a `git pull`):

```js
module.exports = {
  apps: [
    {
      name: "easytestdata",
      cwd: __dirname,
      // Run node itself: start.js only starts the server when it is node's main script, which
      // it is not under PM2's own loader.
      script: process.execPath,
      args: ["--env-file=.env", "packages/server/src/start.js"],
      interpreter: "none",
      // One process: the server holds a database lock, so a second instance would not start.
      instances: 1,
      exec_mode: "fork",
      // Stopping lets running jobs wind down; give it 30 s before a hard kill.
      kill_timeout: 30000,
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z"
    }
  ]
};
```

```bash
mkdir -p logs
pm2 install pm2-logrotate          # keeps the logs small
pm2 start ecosystem.config.cjs && pm2 save
pm2 startup                        # prints a command that starts PM2 at boot
```

`pm2 startup` does not change anything itself: it prints a `sudo env PATH=... pm2 startup ...`
command. Run that printed command once as root (or with `sudo` from an admin login). Then check that the app is up:
`curl -s http://127.0.0.1:<App Port>/health` answers `{"status":"ok"}`.

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

## 7. TLS between Cloudflare and the VM

Use Cloudflare's **Full (strict)** SSL mode (**SSL/TLS > Overview**). The origin needs a
certificate Cloudflare trusts; either works:

- **A Cloudflare Origin Certificate** (valid up to 15 years, no renewals): **SSL/TLS > Origin
  Server > Create Certificate**, key type RSA, hostname the app domain only, PEM. Cloudflare shows
  the private key once. In CloudPanel: **Sites > the site > SSL/TLS > Actions > Import
  Certificate**, paste the private key and the certificate, leave the chain empty.
- **CloudPanel's Let's Encrypt certificate** (renewed automatically).

Then `curl -s https://app.easytestdata.com/health` answers `{"status":"ok"}` through Cloudflare
(a `502` means nginx has no app behind it yet). A `526` means Cloudflare rejected the origin's
certificate, a `525` that the TLS handshake with the origin failed.

## 8. Cloudflare in front: the vhost

With Cloudflare proxying the domain, every request reaches nginx from a Cloudflare address. So
that rate limits and logs see the real visitor, restore the client IP in the site's vhost
(CloudPanel: **Sites > the site > Vhost**), inside the `server` block (for example after the
log lines):

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

In the `location /` that proxies to the app, pass the restored address on and drop any
client-supplied chain: CloudPanel's Node.js vhost has
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, which forwards whatever the
visitor sent. Replace that line (don't add a second one) with:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

`TRUST_PROXY=1` then makes the app trust exactly that one hop. Leave the rest of CloudPanel's
vhost (its `{{...}}` placeholders, the HTTPS redirect, the other `proxy_set_header` lines) as it
is.

## 9. Sign-in providers and redirect URIs

Replace `APP_URL` with your app URL (for example `https://app.easytestdata.com`). Each must match
exactly (no trailing slash; the paths include `/v1`):

| Where                                                                  | Redirect URI                          |
| ---------------------------------------------------------------------- | ------------------------------------- |
| Intuit developer app for sandboxes (`QBO_CLIENT_ID`), Development keys | `APP_URL/api/v1/connections/callback` |
| Google OAuth client                                                    | `APP_URL/api/v1/auth/google/callback` |
| GitHub OAuth app                                                       | `APP_URL/api/v1/auth/github/callback` |
| Intuit app for sign-in (`INTUIT_SSO_CLIENT_ID`)                        | `APP_URL/api/v1/auth/intuit/callback` |

- **Intuit:** if one Intuit app provides both the sandbox and the sign-in keys, it lists both
  URIs, under its Development settings.
- **Google** (Google Auth Platform): a **Web application** client with the redirect URI (no
  JavaScript origins needed). Then **Audience > Publish app**: while the app is in "Testing", only
  listed test users can sign in. Publishing needs the **Branding** page complete (home page,
  privacy policy and terms links, authorized domain). The app asks only for `profile` and
  `email`, which need no Google review; an uploaded logo does need brand verification, so leave
  it out until you want to go through that.
- **GitHub:** an OAuth app (under the organization, so the consent screen names it) with the
  callback URL. Device flow and token expiration don't matter: the server uses GitHub's token
  once at sign-in and does not store it.

## 10. Backups

The database holds accounts, teams, connected sandboxes (encrypted tokens) and job history,
including the ledgers that let a failed load be rolled back. The generated accounting data itself
lives in the QuickBooks sandboxes. Losing the database means users sign in again and reconnect
their sandboxes; "Remove test data" still works, since it finds data by its tag in QuickBooks.

A file-level backup of `/var/lib/postgresql` taken while Postgres runs may not restore. Dump the
database instead and let your file backup (or anything that copies files off the VM) pick up the
dumps. As root:

```bash
install -d -o postgres -m 700 /backups
( sudo -u postgres crontab -l 2>/dev/null; echo '15 3 * * * pg_dump -Fc eztd > /backups/eztd-$(date +\%F).dump && find /backups -name "eztd-*.dump" -mtime +3 -delete' ) | sudo -u postgres crontab -
sudo -u postgres crontab -l
```

That keeps 3 days on the VM (raise `-mtime +3` if nothing copies them off); schedule the off-VM
copy after 03:15, and include `.env` in it. To restore into an empty `eztd` database:
`sudo -u postgres pg_restore --no-owner --role=eztd -d eztd /backups/eztd-<date>.dump`.

## 11. Upgrade

```bash
cd ~/htdocs/app.easytestdata.com
git pull
pnpm install --frozen-lockfile && pnpm exec turbo run build --filter=@easytestdata/web...
pm2 restart easytestdata
```

Migrations run when the server starts. `GET /health` answers `{"status":"ok"}` once it is up.
Take a `pg_dump` first when the release adds a migration: an older release refuses a database
migrated past it, so going back means restoring the dump.
