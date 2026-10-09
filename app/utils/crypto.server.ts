/**
 * Crypto primitives. Rules (spec §9):
 *  - customer auth tokens: sha256(pepper + raw), raw never stored
 *  - signatures compared with timing-safe equality only
 *  - PG credentials sealed with AES-256-GCM under CREDENTIALS_ENC_KEY
 */
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../config/env.server";
import { ConfigError, AppError } from "../services/errors.server";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacSha256Hex(
  secret: string,
  message: string | Buffer,
): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function hmacSha256Base64(
  secret: string,
  message: string | Buffer,
): string {
  return createHmac("sha256", secret).update(message).digest("base64");
}

/** Constant-time string comparison; safe on unequal lengths. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** URL-safe random token; default 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function encryptionKey(): Buffer {
  try {
    const key = Buffer.from(env.CREDENTIALS_ENC_KEY, "hex");
    if (key.length !== 32) {
      throw new Error(`expected 32 bytes, got ${key.length}`);
    }
    return key;
  } catch (error) {
    throw new ConfigError(
      "CREDENTIALS_ENC_KEY is not a valid 32-byte hex key.",
      undefined,
      error,
    );
  }
}

/** AES-256-GCM seal → "iv.tag.ciphertext" (base64 segments). */
export function sealSecret(plaintext: string): string {
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const enc = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return [
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      enc.toString("base64"),
    ].join(".");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("CRYPTO_ERROR", "Failed to encrypt credentials.", 500, {
      cause: error,
    });
  }
}

export function openSecret(sealed: string): string {
  try {
    const [ivB64, tagB64, dataB64] = sealed.split(".");
    if (!ivB64 || !tagB64 || !dataB64)
      throw new Error("malformed sealed payload");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Auth-tag failure means tampering OR a rotated key — both are operational emergencies.
    throw new AppError(
      "CRYPTO_ERROR",
      "Failed to decrypt stored credentials.",
      500,
      { cause: error },
    );
  }
}
