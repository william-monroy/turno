import { describe, expect, it } from "vitest";
import { SEALED_FORMAT, SealError, seal, unseal } from "../src/sealed.js";

const PASS = "correct horse battery staple";
const PAYLOAD = { kind: "test", cookies: [{ name: "sid", value: "session-value-1234" }] };

describe("the sealed session envelope (scrypt + AES-256-GCM)", () => {
  it("round-trips, with nothing of the payload in the file", async () => {
    const text = await seal(PAYLOAD, PASS);
    expect(text).not.toContain("session-value-1234");
    expect(text).not.toContain("sid");
    const env = JSON.parse(text);
    expect(env).toMatchObject({
      format: SEALED_FORMAT,
      version: 1,
      cipher: "aes-256-gcm",
      kdf: { name: "scrypt", N: 131072, r: 8, p: 1 },
    });
    expect(await unseal(text, PASS)).toEqual(PAYLOAD);
  }, 30_000);

  it("uses a fresh salt and IV each time", async () => {
    const [a, b] = [JSON.parse(await seal(PAYLOAD, PASS)), JSON.parse(await seal(PAYLOAD, PASS))];
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  }, 30_000);

  it("refuses a wrong passphrase, a changed ciphertext and a changed header alike", async () => {
    const text = await seal(PAYLOAD, PASS);
    await expect(unseal(text, "wrong passphrase!!")).rejects.toThrow("wrong passphrase, or the file was changed");
    const env = JSON.parse(text);
    const flipped = Buffer.from(env.data, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    await expect(unseal(JSON.stringify({ ...env, data: flipped.toString("base64") }), PASS)).rejects.toThrow(SealError);
    // A header the attacker lowers (cheaper KDF) is authenticated data: it fails too.
    await expect(unseal(JSON.stringify({ ...env, kdf: { ...env.kdf, N: 1024 } }), PASS)).rejects.toThrow(
      /wrong passphrase, or the file was changed/,
    );
  }, 60_000);

  it("refuses short passphrases, other files and costs past its ceiling, before any work", async () => {
    await expect(seal(PAYLOAD, "short")).rejects.toThrow(/at least 12 characters/);
    await expect(unseal("not json", PASS)).rejects.toThrow(/not a turno-browser session export/);
    await expect(unseal(JSON.stringify({ format: "other" }), PASS)).rejects.toThrow(
      /not a turno-browser session export/,
    );
    const env = JSON.parse(await seal(PAYLOAD, PASS));
    await expect(unseal(JSON.stringify({ ...env, version: 2 }), PASS)).rejects.toThrow(/newer turno-browser/);
    await expect(unseal(JSON.stringify({ ...env, kdf: { ...env.kdf, N: 2 ** 24 } }), PASS)).rejects.toThrow(/damaged/);
    await expect(unseal(JSON.stringify({ ...env, kdf: { ...env.kdf, N: 1000 } }), PASS)).rejects.toThrow(/damaged/);
  }, 30_000);
});
