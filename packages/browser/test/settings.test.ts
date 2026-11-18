import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIdentity, identityDir, removeIdentity } from "../src/identities.js";
import {
  IDENTITY_FORMAT_VERSION,
  acceptLanguages,
  checkIdentitySettings,
  identitySettingsPath,
  launchSettings,
  readIdentitySettings,
  writeIdentitySettings,
} from "../src/settings.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * identity.json: the settings that stay fixed for one browser identity (timezone, languages,
 * region, a session health check), stored next to the Chrome profile, never inside it.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const T0 = new Date("2026-11-17T16:00:00.000Z");
const T1 = new Date("2026-11-18T09:30:00.000Z");

describe("identity.json location", () => {
  it("lives next to the profile directory, not inside it", () => {
    const file = identitySettingsPath("school", sb.env);
    expect(file).toBe(join(sb.home, ".local", "share", "turno", "browser", "identities", "school.json"));
    expect(file.startsWith(`${identityDir("school", sb.env)}/`)).toBe(false);
  });

  it("is optional: no file means no settings and Chrome's own defaults", () => {
    // An identity made before identity.json existed: only the profile dir.
    mkdirSync(identityDir("plain", sb.env), { recursive: true });
    expect(readIdentitySettings("plain", sb.env)).toBeUndefined();
    expect(checkIdentitySettings("plain", sb.env)).toEqual({ path: identitySettingsPath("plain", sb.env), problems: [] });
    expect(launchSettings(undefined, [], "America/Monterrey")).toEqual({ args: [] });
  });
});

describe("writeIdentitySettings", () => {
  it("creates the file with the schema version and timestamps, mode 600", () => {
    const s = writeIdentitySettings("school", { timezone: "America/Monterrey", languages: ["es-MX", "es", "en"], region: "mx" }, sb.env, T0);
    expect(s).toEqual({
      version: IDENTITY_FORMAT_VERSION,
      timezone: "America/Monterrey",
      languages: ["es-MX", "es", "en"],
      region: "MX",
      created: T0.toISOString(),
      updated: T0.toISOString(),
    });
    const file = identitySettingsPath("school", sb.env);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(s);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readIdentitySettings("school", sb.env)).toEqual(s);
  });

  it("merges a patch, keeps created, bumps updated and removes keys set to null", () => {
    writeIdentitySettings("school", { timezone: "America/Monterrey", locale: "es-MX" }, sb.env, T0);
    const s = writeIdentitySettings("school", { locale: null, health: { url: "https://mail.example.com/", text: "Inbox" } }, sb.env, T1);
    expect(s).toEqual({
      version: 1,
      timezone: "America/Monterrey",
      health: { url: "https://mail.example.com/", text: "Inbox" },
      created: T0.toISOString(),
      updated: T1.toISOString(),
    });
  });

  it("canonicalizes locales and refuses bad values without writing", () => {
    expect(writeIdentitySettings("school", { locale: "es-mx" }, sb.env, T0).locale).toBe("es-MX");
    const before = readFileSync(identitySettingsPath("school", sb.env), "utf8");
    expect(() => writeIdentitySettings("school", { timezone: "Mars/Olympus" }, sb.env, T1)).toThrow(/timezone "Mars\/Olympus" is not an IANA time zone/);
    expect(() => writeIdentitySettings("school", { locale: "not a locale!" }, sb.env, T1)).toThrow(/locale "not a locale!"/);
    expect(() => writeIdentitySettings("school", { languages: [] }, sb.env, T1)).toThrow(/languages needs at least one/);
    expect(() => writeIdentitySettings("school", { region: "Mexico" }, sb.env, T1)).toThrow(/region "Mexico" must be a two-letter country code/);
    expect(() => writeIdentitySettings("school", { health: { url: "file:///etc/passwd", text: "x" } }, sb.env, T1)).toThrow(/health.url must start with http/);
    expect(() => writeIdentitySettings("school", { health: { url: "https://example.com/" } }, sb.env, T1)).toThrow(/health needs text or selector/);
    expect(readFileSync(identitySettingsPath("school", sb.env), "utf8")).toBe(before);
  });

  it("rejects an invalid identity id before touching the disk", () => {
    expect(() => writeIdentitySettings("../x", { timezone: "UTC" }, sb.env, T0)).toThrow(/invalid identity/);
  });
});

describe("reading and checking", () => {
  it("reports a file that is not JSON or breaks the schema, with the path", () => {
    addIdentity("bad", sb.env);
    const file = identitySettingsPath("bad", sb.env);
    writeFileSync(file, "{ nope");
    expect(() => readIdentitySettings("bad", sb.env)).toThrow(/identity\.json of "bad" .* is not valid JSON/);
    expect(checkIdentitySettings("bad", sb.env).problems).toEqual([expect.stringMatching(/not valid JSON/)]);

    writeFileSync(file, JSON.stringify({ version: 1, timezone: 5, languages: "es", created: "x", updated: T0.toISOString(), extra: true }));
    const { problems } = checkIdentitySettings("bad", sb.env);
    expect(problems).toEqual([
      "timezone must be a string",
      "languages must be a list of language tags",
      "created must be an ISO date",
      'unknown key "extra"',
    ]);
    expect(() => readIdentitySettings("bad", sb.env)).toThrow(/timezone must be a string/);
  });

  it("refuses a newer schema version instead of guessing", () => {
    addIdentity("newer", sb.env);
    writeFileSync(identitySettingsPath("newer", sb.env), JSON.stringify({ version: 99, created: T0.toISOString(), updated: T0.toISOString() }));
    expect(checkIdentitySettings("newer", sb.env).problems).toEqual(["is format 99, from a newer turno-browser (this one reads up to 1); update turno-browser"]);
  });
});

describe("addIdentity and removeIdentity", () => {
  it("pins a new identity to the system time zone and the settings given", () => {
    addIdentity("fresh", sb.env, { languages: ["en-GB", "en"] });
    const s = readIdentitySettings("fresh", sb.env)!;
    expect(s.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(s.languages).toEqual(["en-GB", "en"]);
  });

  it("leaves an existing identity as it is unless settings are given", () => {
    // An identity made before identity.json existed: only the profile dir.
    mkdirSync(identityDir("old", sb.env), { recursive: true });
    addIdentity("old", sb.env);
    expect(existsSync(identitySettingsPath("old", sb.env))).toBe(false);

    addIdentity("pinned", sb.env, { timezone: "UTC" }, T0);
    const file = identitySettingsPath("pinned", sb.env);
    const before = readFileSync(file, "utf8");
    addIdentity("pinned", sb.env);
    expect(readFileSync(file, "utf8")).toBe(before);
    addIdentity("pinned", sb.env, { region: "MX" }, T1);
    expect(readIdentitySettings("pinned", sb.env)).toMatchObject({ timezone: "UTC", region: "MX", created: T0.toISOString(), updated: T1.toISOString() });
  });

  it("deletes identity.json and the identity's state with the profile", () => {
    addIdentity("gone", sb.env, { timezone: "UTC" });
    const state = join(sb.home, ".local", "state", "turno", "browser", "identities", "gone");
    sb.write(".local/state/turno/browser/identities/gone/reputation.jsonl", "{}\n");
    removeIdentity("gone", sb.env);
    expect(existsSync(identitySettingsPath("gone", sb.env))).toBe(false);
    expect(existsSync(state)).toBe(false);
  });
});

describe("launch settings", () => {
  const base = { version: 1, created: T0.toISOString(), updated: T0.toISOString() };

  it("passes languages as Chrome's own --accept-lang, so the header keeps its q-values", () => {
    expect(launchSettings({ ...base, languages: ["es-MX", "es", "en"] }, [], "UTC")).toEqual({ args: ["--accept-lang=es-MX,es,en"] });
  });

  it("derives the languages from the locale, and adds --lang for Chrome's UI and Intl", () => {
    expect(acceptLanguages({ ...base, locale: "es-MX" })).toEqual(["es-MX", "es"]);
    expect(acceptLanguages({ ...base, locale: "en" })).toEqual(["en"]);
    expect(launchSettings({ ...base, locale: "es-MX" }, [], "UTC")).toEqual({ args: ["--lang=es-MX", "--accept-lang=es-MX,es"] });
  });

  it("emulates the time zone only when it differs from the system's", () => {
    expect(launchSettings({ ...base, timezone: "Asia/Tokyo" }, [], "America/Monterrey")).toEqual({ args: [], timezoneId: "Asia/Tokyo" });
    expect(launchSettings({ ...base, timezone: "America/Monterrey" }, [], "America/Monterrey")).toEqual({ args: [] });
  });

  it("never overrides flags or context options the user set", () => {
    const user = ["--lang=fr", "--accept-lang=fr-FR"];
    expect(launchSettings({ ...base, locale: "es-MX", timezone: "Asia/Tokyo" }, user, "UTC", { timezoneId: "Europe/Paris" })).toEqual({ args: [] });
  });
});
