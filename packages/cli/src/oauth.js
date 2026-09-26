import http from "http";
import crypto from "crypto";
import chalk from "chalk";

export const DEFAULT_OAUTH_PORT = 8085;
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export function redirectUriFor(port = DEFAULT_OAUTH_PORT) {
  return `http://localhost:${port}/callback`;
}

/** Print the redirect URI the user must register, plus the sandbox-only hint. */
export function printRedirectUriHint(port = DEFAULT_OAUTH_PORT, log = console.log) {
  log(chalk.bold("Before you continue, add this redirect URI to your Intuit app"));
  log(
    chalk.dim(
      "(developer.intuit.com > your app > Keys & credentials > Development > Redirect URIs):"
    )
  );
  log(`  ${chalk.cyan(redirectUriFor(port))}`);
  log(
    chalk.dim(
      "Use the app's Development keys: EasyTestData only works with QBO sandbox companies.\n"
    )
  );
}

/**
 * Run the browser OAuth flow against a local callback server and exchange the code.
 * Resolves { accessToken, refreshToken, realmId }.
 */
export async function runOAuthFlow({ clientId, clientSecret, port = DEFAULT_OAUTH_PORT }) {
  const redirectUri = redirectUriFor(port);
  const state = crypto.randomUUID();
  const authUrl =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code` +
    `&scope=${encodeURIComponent(SCOPE)}&state=${state}`;

  printRedirectUriHint(port);
  console.log(chalk.bold("Open this URL in your browser, sign in and pick your sandbox company:"));
  console.log(`  ${chalk.cyan(authUrl)}\n`);
  console.log(chalk.dim(`Waiting for the callback on ${redirectUri} ...`));

  const { code, realmId } = await waitForCallback(port, state);
  console.log(chalk.green(`Authorization received for company ${realmId}.`));

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri
    }).toString()
  });
  if (!response.ok) {
    throw new Error(
      `Token exchange failed (${response.status}): ${await response.text()}. ` +
        "Check the client ID/secret and that they are the app's Development keys."
    );
  }
  const tokens = await response.json();
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, realmId };
}

// Loopback only: the callback must not be reachable from other machines on the network. Both
// families, since the browser may resolve "localhost" to either.
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];

export function waitForCallback(port, expectedState, { timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    let done = false;
    const servers = [];
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const server of servers) server.close();
      fn(value);
    };
    const reply = (res, status, title, body) => {
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(`<h1>${title}</h1><p>${body}</p>`);
    };

    const handler = (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      if (params.get("state") !== expectedState) {
        // Not this flow's redirect (a stale tab, a stray request): refuse it and keep waiting.
        reply(res, 400, "Invalid state", "OAuth state mismatch. Use the most recent sign-in link.");
        return;
      }
      if (params.get("error")) {
        reply(res, 400, "Authorization failed", "You can close this window.");
        finish(reject, new Error(`Intuit returned an OAuth error: ${params.get("error")}`));
        return;
      }
      if (!params.get("code") || !params.get("realmId")) {
        reply(res, 400, "Missing parameters", "Expected code and realmId.");
        return;
      }
      reply(res, 200, "EasyTestData is connected", "You can close this window.");
      finish(resolve, { code: params.get("code"), realmId: params.get("realmId") });
    };

    for (const host of LOOPBACK_HOSTS) {
      const server = http.createServer(handler);
      servers.push(server);
      server.on("error", (err) => {
        // A machine without IPv6 loopback still has 127.0.0.1.
        if (host === "::1" && ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(err.code)) return;
        finish(
          reject,
          err.code === "EADDRINUSE"
            ? new Error(`Port ${port} is in use. Pass --port <n> (and register that redirect URI).`)
            : err
        );
      });
      server.listen(port, host);
    }
    timer = setTimeout(
      () => finish(reject, new Error("Timed out after 5 minutes waiting for the OAuth callback.")),
      timeoutMs
    );
  });
}
