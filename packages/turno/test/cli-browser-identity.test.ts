import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BrowserDeps, type BrowserModule, browserCommand } from "../src/cli/commands/browser.js";
import { command as identity, setBrowserDeps } from "../src/cli/commands/identity.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The identity module of turno-browser 0.3 through the CLI (ADR 0044): identity.json with
 * `identity add/show/set`, `browser doctor` and `browser reputation`. The real package from the
 * workspace runs against the sandbox HOME; doctor's Chrome checks come from a fake module.
 */

let sb: Sandbox;
let prev: BrowserDeps;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  if (prev) setBrowserDeps(prev);
  sb.cleanup();
});

const real = async () => (await import("turno-browser")) as unknown as BrowserModule;

function deps(load: () => Promise<BrowserModule | undefined>): BrowserDeps {
  return { load, interactive: () => false, confirm: async () => false };
}

const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);

describe("turno identity add/show/set for browser identities", () => {
  it("writes identity.json on add, shows it, and changes it with set", async () => {
    prev = setBrowserDeps(deps(real));
    const add = fakeIo(sb.env);
    expect(await identity.run(["add", "browser:school", "--timezone", "America/Monterrey", "--languages", "es-MX, es", "--region", "mx"], add)).toBe(0);
    expect(add.lines.join("\n")).toMatch(/settings \(time zone, languages, health check\) in ~\/\.local\/share\/turno\/browser\/identities\/school\.json/);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8"))).toMatchObject({ version: 1, timezone: "America/Monterrey", languages: ["es-MX", "es"], region: "MX" });

    const set = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--health-url", "https://mail.example.com/", "--health-text", "Inbox", "--region", ""], set)).toBe(0);
    expect(set.lines.join("\n")).toMatch(/health check +https:\/\/mail\.example\.com\/ shows "Inbox"/);

    const show = fakeIo(sb.env);
    expect(await identity.run(["show", "browser:school", "--json"], show)).toBe(0);
    const json = JSON.parse(show.lines.join("\n"));
    expect(json).toMatchObject({
      schemaVersion: 1,
      id: "browser:school",
      settingsFile: "~/.local/share/turno/browser/identities/school.json",
      settings: { timezone: "America/Monterrey", languages: ["es-MX", "es"], health: { url: "https://mail.example.com/", text: "Inbox" } },
      problems: [],
      inUse: false,
      holder: null,
      health: null,
    });
    expect(json.settings.region).toBeUndefined();

    // Only the text changes; the URL stays.
    expect(await identity.run(["set", "browser:school", "--health-text", "Mailbox"], fakeIo(sb.env))).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).health).toEqual({ url: "https://mail.example.com/", text: "Mailbox" });
    expect(await identity.run(["set", "browser:school", "--no-health"], fakeIo(sb.env))).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).health).toBeUndefined();
  });

  it("refuses bad values, unknown identities, empty sets and service accounts", async () => {
    prev = setBrowserDeps(deps(real));
    await identity.run(["add", "browser:school"], fakeIo(sb.env));
    const before = readFileSync(settingsFile("school"), "utf8");
    await expect(identity.run(["set", "browser:school", "--timezone", "Mars/Base"], fakeIo(sb.env))).rejects.toThrow(/not an IANA time zone/);
    await expect(identity.run(["set", "browser:school"], fakeIo(sb.env))).rejects.toThrow(/nothing to set/);
    await expect(identity.run(["set", "browser:school", "--health-text", "Inbox"], fakeIo(sb.env))).rejects.toThrow(/needs --health-url/);
    await expect(identity.run(["set", "browser:nope", "--region", "MX"], fakeIo(sb.env))).rejects.toThrow(/identity "nope" does not exist/);
    await expect(identity.run(["show", "linear:work"], fakeIo(sb.env))).rejects.toThrow(/works on browser identities/);
    expect(readFileSync(settingsFile("school"), "utf8")).toBe(before);
    const dry = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--region", "MX", "--dry-run"], dry)).toBe(0);
    expect(dry.lines.join("\n")).toMatch(/\(dry run\) would update identity\.json of "school"/);
    expect(readFileSync(settingsFile("school"), "utf8")).toBe(before);
  });

  it("asks for a newer turno-browser when the installed one has no identity settings", async () => {
    const old = { ...(await real()) } as Partial<BrowserModule>;
    delete old.checkIdentitySettings;
    delete old.writeIdentitySettings;
    delete old.identitySettingsPath;
    prev = setBrowserDeps(deps(async () => old as BrowserModule));
    await identity.run(["add", "browser:school"], fakeIo(sb.env));
    await expect(identity.run(["show", "browser:school"], fakeIo(sb.env))).rejects.toThrow("this needs turno-browser 0.3 or later: npm install --global turno-browser");
    await expect(identity.run(["add", "browser:bank", "--timezone", "UTC"], fakeIo(sb.env))).rejects.toThrow(/turno-browser 0\.3 or later/);
  });
});

describe("turno browser doctor", () => {
  const checks = [
    { area: "chrome", level: "ok", text: "Google Chrome 157.0.8103.79 at /Applications/Google Chrome.app" },
    { area: "chrome", level: "info", text: "smoke launch skipped (--no-launch)" },
    { area: "identity school", level: "ok", text: "free: no process holds it" },
    { area: "identity school", level: "warn", text: "stale runtime lock of pid 12 (that process is gone)", fix: "turno browser doctor --fix", auto: true },
    { area: "identity bank", level: "fail", text: "NEEDS_AUTH: not signed in at https://bank.example.com/", fix: "turno browser login bank" },
  ] as const;

  function doctorModule(seen: unknown[]): BrowserModule {
    return {
      runDoctor: async (o: unknown) => {
        seen.push(o);
        return { checks: checks.map((c) => ({ ...c })), fixed: [] };
      },
    } as unknown as BrowserModule;
  }

  it("prints sections, fix lines and counts, and exits 1 on a failure", async () => {
    const seen: unknown[] = [];
    const cmd = browserCommand(deps(async () => doctorModule(seen)));
    const io = fakeIo(sb.env);
    expect(await cmd.run(["doctor", "--no-launch"], io)).toBe(1);
    expect(seen).toEqual([{ env: sb.env, fix: false, launch: false }]);
    const text = io.lines.join("\n");
    expect(text).toMatch(/^Chrome\n/m);
    expect(text).toMatch(/^Identities\n {2}browser:school\n/m);
    expect(text).toMatch(/stale runtime lock of pid 12.*\n +fix: turno browser doctor --fix \(runs with --fix\)/);
    expect(text).toMatch(/NEEDS_AUTH.*\n +fix: turno browser login bank/);
    expect(io.lines.at(-1)).toBe("2 ok, 1 warning, 1 failure");
  });

  it("gives every check a status, fix, auto and manual with --json, and passes --fix", async () => {
    const seen: unknown[] = [];
    const cmd = browserCommand(deps(async () => doctorModule(seen)));
    const io = fakeIo(sb.env);
    expect(await cmd.run(["doctor", "--json", "--fix"], io)).toBe(1);
    expect(seen).toEqual([{ env: sb.env, fix: true, launch: true }]);
    const json = JSON.parse(io.lines.join("\n"));
    expect(json).toMatchObject({ schemaVersion: 1, ok: false, counts: { ok: 2, warn: 1, fail: 1, skip: 1 }, fixed: [] });
    expect(json.checks[1]).toEqual({ area: "chrome", status: "skip", text: "smoke launch skipped (--no-launch)", fix: null, auto: false, manual: null });
    expect(json.checks[3]).toMatchObject({ status: "warn", fix: "turno browser doctor --fix", auto: true });
  });
});

describe("turno browser reputation", () => {
  it("shows counts and the trend per site from the identity's log", async () => {
    const mod = await real();
    mod.addIdentity("school", sb.env);
    const now = Date.now();
    const line = (days: number, site: string, kind: string) => JSON.stringify({ ts: new Date(now - days * 86_400_000).toISOString(), site, kind, markers: [] });
    const log = [line(1, "a.example", "captcha"), line(2, "a.example", "verify"), line(9, "b.example", "block")].join("\n");
    sb.write(".local/state/turno/browser/identities/school/reputation.jsonl", `${log}\n`);
    const cmd = browserCommand(deps(real));

    const io = fakeIo(sb.env);
    expect(await cmd.run(["reputation", "school"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toMatch(/^browser:school$/m);
    expect(text).toMatch(/a\.example +2 +1 +1 +0 +2 +0 +up/);
    expect(text).toMatch(/b\.example +1 +0 +0 +1 +0 +1 +down/);

    const json = fakeIo(sb.env);
    expect(await cmd.run(["reputation", "browser:school", "--json"], json)).toBe(0);
    expect(JSON.parse(json.lines.join("\n"))[0]).toMatchObject({ schemaVersion: 1, id: "browser:school", total: 3, file: "~/.local/state/turno/browser/identities/school/reputation.jsonl" });
    const picked = fakeIo(sb.env);
    expect(await cmd.run(["reputation", "school", "--json=id,total"], picked)).toBe(0);
    expect(JSON.parse(picked.lines.join("\n"))).toEqual([{ schemaVersion: 1, id: "browser:school", total: 3 }]);
    await expect(cmd.run(["reputation", "nope"], fakeIo(sb.env))).rejects.toThrow(/identity "nope" does not exist/);
  });
});
