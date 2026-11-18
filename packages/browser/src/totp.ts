import { createHmac } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238, on HOTP of RFC 4226), with node:crypto only, for the
 * credential vault. A secret comes as the base32 text a site shows next to its QR
 * code, or as the `otpauth://totp/...` URI the QR code holds.
 */

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParams {
  /** The shared key, base32 without padding, upper case. */
  secret: string;
  algorithm: TotpAlgorithm;
  /** Code length, 6 to 8. */
  digits: number;
  /** Seconds per code. */
  period: number;
}

export class TotpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpError";
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode RFC 4648 base32; spaces, dashes, lower case and padding are accepted. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean))
    throw new TotpError("the one-time code secret is not base32 (letters A to Z and digits 2 to 7)");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function normalizeSecret(text: string): string {
  const key = base32Decode(text);
  if (key.length < 10) throw new TotpError("the one-time code secret is too short (at least 16 base32 characters)");
  return text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

/**
 * Parse what a person pastes for a site's authenticator: a base32 secret (SHA1, 6 digits,
 * 30 seconds, what nearly every site uses) or an `otpauth://totp/` URI with its own algorithm,
 * digits and period. Errors never quote the input.
 */
export function parseTotpSecret(input: string): TotpParams {
  const text = input.trim();
  if (!text.toLowerCase().startsWith("otpauth:"))
    return { secret: normalizeSecret(text), algorithm: "SHA1", digits: 6, period: 30 };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TotpError("the otpauth:// URI cannot be parsed");
  }
  if (url.host.toLowerCase() !== "totp")
    throw new TotpError(`only otpauth://totp/ is supported (this is ${url.host || "an unknown type"})`);
  const secret = url.searchParams.get("secret");
  if (!secret) throw new TotpError("the otpauth:// URI has no secret");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512")
    throw new TotpError(`unsupported algorithm ${algorithm} (SHA1, SHA256 or SHA512)`);
  const digits = Number(url.searchParams.get("digits") ?? 6);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new TotpError("digits must be 6, 7 or 8");
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!Number.isInteger(period) || period < 1 || period > 300)
    throw new TotpError("period must be a whole number of seconds from 1 to 300");
  return { secret: normalizeSecret(secret), algorithm, digits, period };
}

/** HOTP (RFC 4226): the code for one counter value. */
export function hotp(key: Buffer, counter: number, algorithm: TotpAlgorithm = "SHA1", digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The code at `now` (milliseconds since the epoch). */
export function totp(params: TotpParams, now: number = Date.now()): string {
  return hotp(base32Decode(params.secret), Math.floor(now / 1000 / params.period), params.algorithm, params.digits);
}

/** Seconds left before the code at `now` changes. */
export function totpSecondsLeft(params: TotpParams, now: number = Date.now()): number {
  return params.period - (Math.floor(now / 1000) % params.period);
}
