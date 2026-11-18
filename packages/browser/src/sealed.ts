import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

/**
 * The encrypted envelope of a session export: a passphrase stretched with scrypt
 * (random salt) into an AES-256-GCM key. The header (format, KDF parameters, cipher, IV) is the
 * GCM additional data, so a changed header fails to decrypt like a changed ciphertext. The
 * expiry lives inside the encrypted payload, where it cannot be edited without the passphrase.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SEALED_FORMAT = "turno-browser-session";
const VERSION = 1;
/** scrypt cost: 2^17 (about 128 MiB and a few hundred ms), the OWASP floor for scrypt. */
const KDF = { N: 2 ** 17, r: 8, p: 1 } as const;
/** Ceiling on what a file may ask for, so a crafted header cannot make import allocate gigabytes. */
const MAX_N = 2 ** 20;
const MIN_PASSPHRASE = 12;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

interface Header {
  format: typeof SEALED_FORMAT;
  version: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  iv: string;
}

interface Envelope extends Header {
  data: string;
  tag: string;
}

function aad(h: Header): Buffer {
  return Buffer.from(JSON.stringify({ format: h.format, version: h.version, kdf: h.kdf, cipher: h.cipher, iv: h.iv }));
}

async function key(passphrase: string, kdf: Header["kdf"]): Promise<Buffer> {
  return await scrypt(passphrase.normalize("NFC"), Buffer.from(kdf.salt, "base64"), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r + 1024 * 1024,
  });
}

/** Encrypt `payload` (any JSON) under `passphrase`; the result is one JSON document. */
export async function seal(payload: unknown, passphrase: string): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new SealError(`the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  const header: Header = {
    format: SEALED_FORMAT,
    version: VERSION,
    kdf: { name: "scrypt", ...KDF, salt: randomBytes(16).toString("base64") },
    cipher: "aes-256-gcm",
    iv: randomBytes(12).toString("base64"),
  };
  const cipher = createCipheriv("aes-256-gcm", await key(passphrase, header.kdf), Buffer.from(header.iv, "base64"));
  cipher.setAAD(aad(header));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const envelope: Envelope = { ...header, data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  return `${JSON.stringify(envelope)}\n`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseEnvelope(text: string): Envelope {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new SealError("this is not a turno-browser session export");
  }
  if (!isObject(v) || v.format !== SEALED_FORMAT) throw new SealError("this is not a turno-browser session export");
  if (typeof v.version !== "number" || v.version > VERSION)
    throw new SealError("this export is from a newer turno-browser; update turno-browser");
  const kdf = v.kdf;
  if (
    !isObject(kdf) ||
    kdf.name !== "scrypt" ||
    ![kdf.N, kdf.r, kdf.p].every((n) => Number.isInteger(n) && (n as number) > 0) ||
    (kdf.N as number) > MAX_N ||
    ((kdf.N as number) & ((kdf.N as number) - 1)) !== 0 ||
    (kdf.r as number) > 32 ||
    (kdf.p as number) > 16 ||
    typeof kdf.salt !== "string" ||
    v.cipher !== "aes-256-gcm" ||
    typeof v.iv !== "string" ||
    typeof v.data !== "string" ||
    typeof v.tag !== "string"
  ) {
    throw new SealError("this session export is damaged (its header is not valid)");
  }
  return v as unknown as Envelope;
}

/** Decrypt an export; a wrong passphrase and a changed file give the same error. */
export async function unseal(text: string, passphrase: string): Promise<unknown> {
  const env = parseEnvelope(text);
  const decipher = createDecipheriv("aes-256-gcm", await key(passphrase, env.kdf), Buffer.from(env.iv, "base64"));
  decipher.setAAD(aad(env));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
  } catch {
    throw new SealError("wrong passphrase, or the file was changed");
  }
  return JSON.parse(plain.toString("utf8")) as unknown;
}
