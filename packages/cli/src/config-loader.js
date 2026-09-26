import fs from "fs";
import path from "path";

export const CONFIG_FILE = ".easytestdata.json";

function loadEnvFile() {
  try {
    const contents = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional
  }
}

export function loadConfig() {
  loadEnvFile();

  const configPath = path.resolve(process.cwd(), CONFIG_FILE);
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${parseErr.message}`, { cause: parseErr });
  }
}

export function saveConfig(config) {
  const configPath = path.resolve(process.cwd(), CONFIG_FILE);
  // `mode` applies only when the file is created: make an existing file owner-only before the
  // QBO tokens are written into it.
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
}

function connectionName(config, name) {
  return name || config.defaultConnection || "default";
}

/**
 * Resolve QboClient options for a named connection. Falls back to QBO_* environment
 * variables (QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN, QBO_REALM_ID) when
 * the config file has no such connection. Returns null when nothing is configured.
 * There is deliberately no base URL setting: EasyTestData only talks to QBO sandboxes.
 */
export function getConnection(config, name) {
  const conn = (config.connections || {})[connectionName(config, name)];
  const env = process.env;
  if (!conn && !(env.QBO_REFRESH_TOKEN && env.QBO_REALM_ID)) return null;
  const c = conn || {};
  return {
    qboClientId: c.clientId || env.QBO_CLIENT_ID,
    qboClientSecret: c.clientSecret || env.QBO_CLIENT_SECRET,
    qboRefreshToken: c.refreshToken || env.QBO_REFRESH_TOKEN,
    qboAccessToken: c.accessToken || env.QBO_ACCESS_TOKEN || "",
    qboRealmId: c.realmId || env.QBO_REALM_ID,
    qboMinorVersion: c.minorVersion || env.QBO_MINOR_VERSION || "65"
  };
}

/** Like getConnection, but throws an actionable error when nothing is configured. */
export function requireConnection(config, name) {
  const conn = getConnection(config, name);
  if (conn) return conn;
  const available = Object.keys(config.connections || {});
  const which = name ? `Connection "${name}" is not configured` : "No QBO connection configured";
  const hint = available.length > 0 ? ` Available connections: ${available.join(", ")}.` : "";
  throw new Error(`${which}.${hint} Run \`easytestdata auth\` to connect a QBO sandbox company.`);
}

export function saveConnection(config, name, connection) {
  if (!config.connections) config.connections = {};
  config.connections[name] = connection;
  config.defaultConnection = config.defaultConnection || name;
  saveConfig(config);
}

export function persistRefreshToken(config, name, tokens) {
  const key = connectionName(config, name);
  if (!config.connections) config.connections = {};
  if (!config.connections[key]) config.connections[key] = {};
  config.connections[key].refreshToken = tokens.refreshToken;
  if (tokens.accessToken) {
    config.connections[key].accessToken = tokens.accessToken;
  }
  saveConfig(config);
}
