import { describe, expect, it } from "vitest";
import { TotpError, base32Decode, hotp, parseTotpSecret, totp, totpSecondsLeft } from "../src/totp.js";

/** RFC 4648 base32 of a byte string, to build test secrets. */
function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const SEEDS = {
  SHA1: Buffer.from("12345678901234567890"),
  SHA256: Buffer.from("12345678901234567890123456789012"),
  SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
} as const;

/** RFC 6238, Appendix B: time, then the 8-digit code for SHA1, SHA256 and SHA512. */
const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("TOTP (RFC 6238)", () => {
  it("matches every test vector of RFC 6238 for SHA1, SHA256 and SHA512", () => {
    for (const [time, sha1, sha256, sha512] of VECTORS) {
      const want = { SHA1: sha1, SHA256: sha256, SHA512: sha512 };
      for (const algorithm of ["SHA1", "SHA256", "SHA512"] as const) {
        const params = { secret: base32(SEEDS[algorithm]), algorithm, digits: 8, period: 30 };
        expect(totp(params, time * 1000), `${algorithm} at ${time}`).toBe(want[algorithm]);
      }
    }
  });

  it("matches the HOTP test values of RFC 4226", () => {
    const codes = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    codes.forEach((code, counter) => expect(hotp(SEEDS.SHA1, counter)).toBe(code));
  });

  it("reads a base32 secret the way sites show it", () => {
    const secret = base32(SEEDS.SHA1);
    const spaced = secret
      .toLowerCase()
      .replace(/(.{4})/g, "$1 ")
      .trim();
    expect(parseTotpSecret(spaced)).toEqual({ secret, algorithm: "SHA1", digits: 6, period: 30 });
    expect(base32Decode(`${secret}====`).equals(SEEDS.SHA1)).toBe(true);
  });

  it("reads an otpauth://totp URI with its own algorithm, digits and period", () => {
    const secret = base32(SEEDS.SHA256);
    const p = parseTotpSecret(
      `otpauth://totp/Example:alice@example.com?secret=${secret}&issuer=Example&algorithm=SHA256&digits=8&period=60`,
    );
    expect(p).toEqual({ secret, algorithm: "SHA256", digits: 8, period: 60 });
    expect(totp(p, 59_000)).toBe(totp({ ...p, period: 60 }, 0));
    expect(totpSecondsLeft(p, 59_000)).toBe(1);
  });

  it("refuses what is not a usable secret, without quoting it", () => {
    for (const bad of [
      "not base32!",
      "ABC",
      "otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ",
      "otpauth://totp/x",
      "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZA&digits=9",
    ]) {
      let err: unknown;
      try {
        parseTotpSecret(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(TotpError);
      expect(String(err)).not.toContain("GEZDGNBVGY3TQOJQ");
    }
  });
});
