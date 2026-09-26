import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_FILE = "secret.key";

function readKey(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Writes a new key atomically: the full key goes to a private temp file, which is then hard-linked
 * into place. link() fails if the key file exists, so a second starter never overwrites a key and
 * never reads a half-written one.
 */
function writeNewKey(file) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temp, file);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    unlinkSync(temp);
  }
}

/**
 * Creates dataDir (0700) and secret files (0600) on first run; returns { jwtSecret, encryptionKey }.
 *
 * `secret.key` holds the token-encryption key (64 hex chars). The JWT secret, which only signs
 * short-lived OAuth state in local mode, is derived from it, so there is one file to keep. A
 * damaged key file is refused, never replaced: the stored QBO tokens are encrypted with it.
 */
export function ensureLocalSecrets(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700); // also when it already existed or the umask removed bits
  const file = join(dataDir, KEY_FILE);

  let key = readKey(file);
  if (key === null) {
    writeNewKey(file);
    key = readKey(file);
  }
  if (!/^[0-9a-f]{64}$/.test(key ?? "")) {
    throw new Error(
      `${file} is not a 64-character hex key. Restore it, or delete ${dataDir} to start over ` +
        "(this removes the local database and its QuickBooks connections)."
    );
  }

  chmodSync(file, 0o600); // a hand-copied key file may be readable by others

  const jwtSecret = createHmac("sha256", Buffer.from(key, "hex"))
    .update("easytestdata-local-jwt")
    .digest("hex");
  return { jwtSecret, encryptionKey: key };
}
