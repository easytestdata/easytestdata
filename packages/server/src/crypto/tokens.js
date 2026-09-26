import crypto from "crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getKey() {
  const keyHex = config.tokenEncryption.key;
  if (!keyHex || keyHex.length < 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32"
    );
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptTokenPair(accessToken, refreshToken) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getKey();

  const accessCipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let accessEnc = accessCipher.update(accessToken, "utf8", "hex");
  accessEnc += accessCipher.final("hex");
  const accessTag = accessCipher.getAuthTag().toString("hex");

  const refreshIv = crypto.randomBytes(IV_LENGTH);
  const refreshCipher = crypto.createCipheriv(ALGORITHM, key, refreshIv);
  let refreshEnc = refreshCipher.update(refreshToken, "utf8", "hex");
  refreshEnc += refreshCipher.final("hex");
  const refreshTag = refreshCipher.getAuthTag().toString("hex");

  return {
    access_token_enc: `${accessEnc}:${accessTag}`,
    refresh_token_enc: `${refreshEnc}:${refreshTag}`,
    token_iv: `${iv.toString("hex")}:${refreshIv.toString("hex")}`
  };
}

export function decryptTokenPair(accessTokenEnc, refreshTokenEnc, tokenIv) {
  const key = getKey();

  const [accessEnc, accessTag] = accessTokenEnc.split(":");
  const [refreshEnc, refreshTag] = refreshTokenEnc.split(":");
  const [accessIv, refreshIvHex] = tokenIv.split(":");

  const accessDecipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(accessIv, "hex"));
  accessDecipher.setAuthTag(Buffer.from(accessTag, "hex"));
  let accessToken = accessDecipher.update(accessEnc, "hex", "utf8");
  accessToken += accessDecipher.final("utf8");

  const refreshDecipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(refreshIvHex, "hex"));
  refreshDecipher.setAuthTag(Buffer.from(refreshTag, "hex"));
  let refreshToken = refreshDecipher.update(refreshEnc, "hex", "utf8");
  refreshToken += refreshDecipher.final("utf8");

  return { accessToken, refreshToken };
}

/** Encrypts one secret value (e.g. a stored app setting); returns `{ value_enc, iv }`. */
export function encryptValue(value) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let enc = cipher.update(value, "utf8", "hex");
  enc += cipher.final("hex");
  return { value_enc: `${enc}:${cipher.getAuthTag().toString("hex")}`, iv: iv.toString("hex") };
}

export function decryptValue(valueEnc, ivHex) {
  const [enc, tag] = valueEnc.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  let value = decipher.update(enc, "hex", "utf8");
  value += decipher.final("utf8");
  return value;
}
