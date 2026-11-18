import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_SECRET_STORE, SecretError, keychainAddLine, requireSecretStore, secretStore, securityQuote } from "../src/secrets.js";
import { fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** A value with every character the `security -i` quoting has to handle. */
const VALUE = `v4l"ue\\ with spaces 'and' $HOME`;

describe("secret store, against the fake security and secret-tool", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`stores, reads, checks and deletes on ${platform}, value never in argv`, async () => {
      const fake = fakeSecretStore(sb);
      const store = secretStore(sb.env, platform)!;
      expect(store.kind).toBe(platform === "darwin" ? "keychain" : "libsecret");
      expect(await store.get("turno-test/a")).toBeUndefined();
      expect(await store.has("turno-test/a")).toBe(false);
      await store.set("turno-test/a", VALUE);
      expect(fake.read("turno-test/a") === VALUE).toBe(true);
      expect((await store.get("turno-test/a")) === VALUE).toBe(true);
      expect(await store.has("turno-test/a")).toBe(true);
      expect(await store.remove("turno-test/a")).toBe(true);
      expect(await store.remove("turno-test/a")).toBe(false);
      expect(fake.services()).toEqual([]);
    });
  }

  it("reports a failed write without the value", async () => {
    const fake = fakeSecretStore(sb);
    fake.failWrites(true);
    const err = await secretStore(sb.env, "darwin")!
      .set("turno-test/b", VALUE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect(String(err)).not.toContain("v4l");
  });

  it("quotes security -i words", () => {
    expect(securityQuote('a b"c\\d')).toBe('"a b\\"c\\\\d"');
    expect(keychainAddLine("svc", "x")).toBe('add-generic-password -U -a "turno" -s "svc" -w "x" -T /usr/bin/security\n');
    expect(() => keychainAddLine("svc", "two\nlines")).toThrow(/line break/);
  });

  it("refuses a service name with a line break", async () => {
    fakeSecretStore(sb);
    await expect(secretStore(sb.env, "darwin")!.get("a\nb")).rejects.toThrow(/invalid secret name/);
  });

  it("says what to install when there is no store", () => {
    const env = { ...sb.env, PATH: join(sb.home, "empty") };
    expect(secretStore(env, "darwin")).toBeUndefined();
    expect(() => requireSecretStore(env, "linux")).toThrow(NO_SECRET_STORE);
  });
});
