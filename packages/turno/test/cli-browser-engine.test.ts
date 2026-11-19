import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserApi, BrowserDeps } from "../src/cli/commands/browser.js";
import { command as identity, setBrowserDeps } from "../src/cli/commands/identity.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The engine flags of `turno identity set` (and `turno browser set`, which shares them):
 * `--engine` for read mode and `--attach` for the user's own Chrome, written to identity.json by
 * the real package from the workspace, with the package's errors told as the flag.
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

async function setup(): Promise<void> {
  prev = setBrowserDeps({ load: real, interactive: () => false, confirm: async () => false });
  expect(await identity.run(["add", "browser:school"], fakeIo(sb.env))).toBe(0);
}

describe("turno identity set --engine and --attach", () => {
  it("turns read mode on and off", async () => {
    await setup();
    const io = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--engine", "lightpanda"], io)).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8"))).toMatchObject({
      version: 6,
      engine: "lightpanda",
    });
    expect(io.lines.join("\n")).toMatch(/engine\s+Lightpanda \(read mode\)/);
    expect(await identity.run(["set", "browser:school", "--engine", ""], fakeIo(sb.env))).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).engine).toBeUndefined();
  });

  it("sets attach with a note on what it grants and how to allow it", async () => {
    await setup();
    const io = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--attach", "auto"], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toMatch(/attach to your Chrome \(auto\)/);
    expect(out).toMatch(/sees every window.*chrome:\/\/inspect\/#remote-debugging/s);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8"))).toMatchObject({ attach: "auto" });
  });

  it("tells a bad value as the flag", async () => {
    await setup();
    await expect(
      identity.run(["set", "browser:school", "--attach", "http://10.0.0.9:9222"], fakeIo(sb.env)),
    ).rejects.toThrow(/^--attach "http:\/\/10\.0\.0\.9:9222" must be on this computer/);
    await expect(identity.run(["set", "browser:school", "--engine", "firefox"], fakeIo(sb.env))).rejects.toThrow(
      /^--engine must be "chrome"/,
    );
    await expect(
      identity.run(["set", "browser:school", "--engine", "lightpanda", "--attach", "auto"], fakeIo(sb.env)),
    ).rejects.toThrow(/pick one/);
  });
});
