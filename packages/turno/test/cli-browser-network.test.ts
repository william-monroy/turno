import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserApi, BrowserDeps } from "../src/cli/commands/browser.js";
import { command as identity, setBrowserDeps } from "../src/cli/commands/identity.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The network flags of `turno identity set` (`--user-agent`, `--proxy-*`, `--no-proxy`) and
 * `--engine camoufox`, written to identity.json by the real package from the workspace: the
 * file never holds a literal password, `show` never prints a secret, and each opt-in setting
 * prints what it costs.
 */

let sb: Sandbox;
let prev: BrowserDeps | undefined;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  if (prev) setBrowserDeps(prev);
  prev = undefined;
  sb.cleanup();
});

const real = async (): Promise<BrowserApi> => (await import("turno-browser")).api;
const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);
const saved = (id: string) => JSON.parse(readFileSync(settingsFile(id), "utf8"));

async function setup(): Promise<void> {
  prev = setBrowserDeps({ load: real, interactive: () => false, confirm: async () => false });
  expect(await identity.run(["add", "browser:net"], fakeIo(sb.env))).toBe(0);
}

describe("turno identity set: network and user agent", () => {
  it("sets a proxy whose password stays in the secret store, merges later flags, and removes it", async () => {
    await setup();
    const io = fakeIo(sb.env);
    const args = ["--proxy-server", "http://proxy.example.com:8080", "--proxy-username", "alice"];
    expect(await identity.run(["set", "browser:net", ...args, "--proxy-password", "keychain:net-proxy"], io)).toBe(0);
    expect(saved("net")).toMatchObject({
      version: 11,
      proxy: { server: "http://proxy.example.com:8080", username: "alice", password: "keychain:net-proxy" },
    });
    const out = io.lines.join("\n");
    expect(out).toMatch(/proxy\s+http:\/\/proxy\.example\.com:8080, signs in as alice with keychain:net-proxy/);
    expect(out).toMatch(/its operator sees where this identity goes/);
    expect(out).toMatch(/Meant for your own accounts and sites you may automate/);
    // Merged with the saved user name and password, a SOCKS server is refused.
    await expect(
      identity.run(["set", "browser:net", "--proxy-server", "socks5://127.0.0.1:1080"], fakeIo(sb.env)),
    ).rejects.toThrow(/Chrome cannot sign in to a SOCKS proxy/);
    expect(await identity.run(["set", "browser:net", "--no-proxy"], fakeIo(sb.env))).toBe(0);
    expect(saved("net").proxy).toBeUndefined();
  });

  it("refuses a literal password and mixed flags, told as the flag", async () => {
    await setup();
    await expect(
      identity.run(
        [
          "set",
          "browser:net",
          "--proxy-server",
          "http://p.example.com",
          "--proxy-username",
          "a",
          "--proxy-password",
          "hunter22",
        ],
        fakeIo(sb.env),
      ),
    ).rejects.toThrow(/--proxy-password must be a keychain:<item> reference/);
    await expect(
      identity.run(["set", "browser:net", "--no-proxy", "--proxy-server", "http://p.example.com"], fakeIo(sb.env)),
    ).rejects.toThrow(/--no-proxy does not go with the other --proxy flags/);
    await expect(identity.run(["set", "browser:net", "--user-agent", "Mozilla/5.0"], fakeIo(sb.env))).rejects.toThrow(
      /^--user-agent must be "coherent"/,
    );
    expect(readFileSync(settingsFile("net"), "utf8")).not.toContain("hunter22");
  });

  it("turns userAgent coherent and the camoufox engine on with their notes", async () => {
    await setup();
    const io = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:net", "--user-agent", "coherent"], io)).toBe(0);
    expect(saved("net")).toMatchObject({ version: 11, userAgent: "coherent" });
    expect(io.lines.join("\n")).toMatch(/user agent\s+the installed Chrome's own/);
    await expect(identity.run(["set", "browser:net", "--engine", "camoufox"], fakeIo(sb.env))).rejects.toThrow(
      /^--user-agent does not go with engine "camoufox"/,
    );
    expect(await identity.run(["set", "browser:net", "--user-agent", ""], fakeIo(sb.env))).toBe(0);
    const fox = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:net", "--engine", "camoufox"], fox)).toBe(0);
    expect(saved("net")).toMatchObject({ version: 11, engine: "camoufox" });
    expect(fox.lines.join("\n")).toMatch(/engine\s+Camoufox \(its own Firefox profile\)/);
    expect(fox.lines.join("\n")).toMatch(
      /engine camoufox: a Firefox build that reports values other than the computer's own/,
    );
  });

  it("refuses Camoufox with captcha solving, and keeps act and the live view", async () => {
    await setup();
    expect(
      await identity.run(
        [
          "set",
          "browser:net",
          "--captcha-provider",
          "task-api",
          "--captcha-endpoint",
          "https://solver.example.com",
          "--captcha-key",
          "keychain:solver",
        ],
        fakeIo(sb.env),
      ),
    ).toBe(0);
    await expect(identity.run(["set", "browser:net", "--engine", "camoufox"], fakeIo(sb.env))).rejects.toThrow(
      /captcha does not go with engine "camoufox"/,
    );
    expect(await identity.run(["set", "browser:net", "--no-captcha"], fakeIo(sb.env))).toBe(0);
    expect(
      await identity.run(["set", "browser:net", "--engine", "camoufox", "--act", "--live", "true"], fakeIo(sb.env)),
    ).toBe(0);
    expect(saved("net")).toMatchObject({ version: 11, engine: "camoufox", act: {}, live: { enabled: true } });
  });
});
