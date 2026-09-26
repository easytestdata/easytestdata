# Run EasyTestData locally

`npx easytestdata ui` runs the full EasyTestData web app on your own computer: the same app
as EasyTestData Cloud, with no account, no sign-in and no limits. Nothing else to install: no
Docker and no database server (the database is built in).

Local mode is for **one person on one machine**. It has no login, so it listens on your own
computer only. Never put it behind a reverse proxy, a tunnel or port forwarding, and never
expose it to a network: anyone who could reach it could use your QuickBooks sandbox connections.
To share the app with a team, use [EasyTestData Cloud](https://app.easytestdata.com) or deploy the
Cloud mode yourself ([deploy-cloudpanel.md](deploy-cloudpanel.md)).

## Start it

Requires Node.js 22.13 or later.

```bash
npx easytestdata ui
```

The app opens in your browser at `http://localhost:28080`. Press Ctrl+C to stop it.

| Option              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `--port <n>`        | Listen on another port (default `28080`).                       |
| `--data-dir <path>` | Keep the data somewhere else (default `~/.easytestdata`).       |
| `--no-open`         | Don't open the browser; the address is printed in the terminal. |

`EASYTESTDATA_DATA_DIR` sets the data directory too. To update, run
`npx easytestdata@latest ui`; your data stays where it is.

## Generate and download (no keys needed)

Pick an industry template and a scenario, then **Generate** to download the books as JSON and
CSV files. This needs no Intuit account.

## Connect a QuickBooks Online sandbox

Loading into a sandbox needs your own free Intuit developer app, because local mode has no
shared app:

1. Sign up at [developer.intuit.com](https://developer.intuit.com). A sandbox company is
   created for you. Create an app with the **Accounting** scope and open its **Development**
   keys.
2. The first time you connect a sandbox, the app shows a setup screen with the redirect URI to
   register. With the default port it is:

   ```text
   http://localhost:28080/api/v1/connections/callback
   ```

   With `--port`, the port in the URI changes to match; register the URI the setup screen shows.

3. Paste the Client ID and Client Secret into the setup screen. They are stored encrypted in the
   local database. `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` in the environment take precedence
   over saved keys.
4. Connect, load a scenario, and use **Remove test data** to remove what EasyTestData added. Only
   sandbox companies can be connected.

## Where your data lives

Everything is in the data directory (`~/.easytestdata` unless you chose another one), created
readable by you only:

| Path         | What it holds                                                                       |
| ------------ | ----------------------------------------------------------------------------------- |
| `db/`        | The embedded Postgres database (PGlite): connections, jobs, saved Intuit keys.      |
| `secret.key` | The key that encrypts your QuickBooks tokens and Intuit keys. Created on first run. |
| `exports/`   | Generated download files, deleted after 7 days while the app runs.                  |

Keep `secret.key` with the database: without it the stored connections cannot be read. To start
over, stop the app and delete the directory (this removes your connections and job history,
not anything in your QuickBooks sandbox).

## What is different from Cloud

- No sign-in: one built-in user and team. Teams, invites and the admin area are hidden.
- No limits on connections, jobs or records.
- You bring your own Intuit developer app (Cloud provides one).
- The app listens on `127.0.0.1` only. It answers only to `localhost:<port>` and
  `127.0.0.1:<port>`, refuses requests relayed by a proxy, and refuses any change requested by
  another website open in the same browser.

## Stopping and restarting

Ctrl+C stops accepting requests and gives running jobs up to 15 seconds to finish. After that
they stop at their next batch and end as "Interrupted by a server shutdown"; a load stopped this
way keeps its list of created records, so its **Rollback** still works. A second Ctrl+C exits at
once: a job cut off like that shows "Interrupted by a server restart" (or "Cancelled while the
server restarted" if you had cancelled it) the next time you start the app, any records it
created stay in the sandbox, and **Remove test data** removes them. Queued
jobs run after the restart.

Only one copy of the app can use a data folder at a time. "EasyTestData is already running with
this data folder (pid N)" means another `easytestdata ui` (on any port) still has it open: stop
that one first, or start this one with `--data-dir` for a separate copy. A copy that crashed
leaves its lock behind; the next start takes it over. In one rare case (a copy killed during that
takeover itself) the message says "An earlier start was interrupted and left …/server.lock.takeover"
(possibly after "Another copy of EasyTestData may be starting", when the pid it left has since been
reused): if no EasyTestData is running, delete that file and start again.
