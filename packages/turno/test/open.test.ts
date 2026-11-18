import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as open, isClaudeUrl, isOpenableUrl, openArgs, openInvocation } from "../src/cli/commands/open.js";
import { resetPrivateDirCache } from "../src/core/paths.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let chrome: string;
const URL = "https://claude.ai/artifact/1";

beforeEach(() => {
  sb = sandbox();
  resetPrivateDirCache();
  mkdirSync(join(sb.home, "Chrome.app"));
  sb.env.TURNO_CHROME_APP = join(sb.home, "Chrome.app");
  sb.write(".config/turno/config.toml", 'system = "personal"\n[profiles.personal]\nbrowser = "default"\n');
  chrome = join(sb.home, ".local/share/turno/chrome");
});
afterEach(() => sb.cleanup());

/** Env whose PATH holds only the sandbox fakes (CI runners ship a real Chrome). */
function onlyFakes(...names: string[]): NodeJS.ProcessEnv {
  for (const n of names) fakeCommand(sb, n, "exit 0");
  const dir = join(sb.home, "fakebin");
  mkdirSync(dir, { recursive: true });
  return { ...sb.env, PATH: dir };
}

describe("open: which links", () => {
  it("matches only claude.ai and claude.com links", () => {
    expect(isClaudeUrl("https://claude.ai/artifact/x")).toBe(true);
    expect(isClaudeUrl("https://www.claude.com/x")).toBe(true);
    expect(isClaudeUrl("https://example.com/claude.ai/")).toBe(false);
    expect(isClaudeUrl("http://claude.ai/x")).toBe(false);
  });

  it("accepts http(s) and mailto only, never an option or a local target", () => {
    expect(isOpenableUrl("https://example.com/a?b=c")).toBe(true);
    expect(isOpenableUrl("HTTP://example.com")).toBe(true);
    expect(isOpenableUrl("mailto:alice@example.com")).toBe(true);
    for (const bad of [
      "-a",
      "--help",
      "file:///etc/passwd",
      "/Applications/Calculator.app",
      "x.command",
      "javascript:alert(1)",
      "vscode://x",
      "https://a b",
      "",
    ]) {
      expect(isOpenableUrl(bad), bad).toBe(false);
      expect(() => openInvocation(undefined, bad, sb.env, "darwin"), bad).toThrow(/only http\(s\) and mailto/);
    }
  });
});

describe("open: macOS", () => {
  it("picks the Chrome profile from the argument or CLAUDE_CONFIG_DIR", () => {
    expect(openArgs("work", URL, sb.env)).toEqual([
      "-na",
      "Google Chrome",
      "--args",
      `--user-data-dir=${chrome}`,
      "--profile-directory=work",
      URL,
    ]);
    expect(
      openInvocation(undefined, URL, { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") }, "darwin").args,
    ).toContain("--profile-directory=work");
    expect(openInvocation(undefined, URL, sb.env, "darwin")).toEqual({ command: "open", args: [URL] }); // system profile: default browser
    expect(openInvocation("work", "https://example.com", sb.env, "darwin")).toEqual({
      command: "open",
      args: ["https://example.com"],
    });
    expect(() => openArgs("setup", URL, sb.env)).toThrow(/reserved/);
    expect(statSync(chrome).mode & 0o777).toBe(0o700);
  });

  it("uses the default browser when Chrome is not installed", () => {
    sb.env.TURNO_CHROME_APP = join(sb.home, "missing.app");
    expect(openInvocation("work", URL, sb.env, "darwin")).toEqual({ command: "open", args: [URL] });
  });
});

describe("open: Linux", () => {
  it("starts Chrome from PATH with the profile, detached", () => {
    const env = onlyFakes("google-chrome-stable", "xdg-open");
    const inv = openInvocation("work", URL, env, "linux");
    expect(inv).toEqual({
      command: join(sb.home, "fakebin", "google-chrome-stable"),
      args: [`--user-data-dir=${chrome}`, "--profile-directory=work", URL],
      detach: true,
    });
  });

  it("prefers google-chrome, then chromium", () => {
    expect(openInvocation("work", URL, onlyFakes("chromium", "google-chrome"), "linux").command).toMatch(
      /\/google-chrome$/,
    );
  });

  it("falls back to xdg-open without Chrome, for other links and for default-browser profiles", () => {
    const env = onlyFakes("xdg-open");
    expect(openInvocation("work", URL, env, "linux")).toEqual({ command: "xdg-open", args: [URL] });
    expect(openInvocation("work", "https://example.com", onlyFakes("chromium"), "linux")).toEqual({
      command: "xdg-open",
      args: ["https://example.com"],
    });
    expect(openInvocation(undefined, URL, env, "linux")).toEqual({ command: "xdg-open", args: [URL] });
  });

  it("says what to install when there is no opener", () => {
    const empty = join(sb.home, "empty");
    mkdirSync(empty);
    expect(() => openInvocation(undefined, "https://example.com", { ...sb.env, PATH: empty }, "linux")).toThrow(
      /xdg-open is not installed/,
    );
  });

  it("refuses other platforms", () => {
    expect(() => openInvocation(undefined, "https://example.com", sb.env, "win32")).toThrow(/macOS and Linux/);
  });
});

describe("turno open", () => {
  it("runs the platform opener with the link", async () => {
    const log = join(sb.home, "open.log");
    for (const name of ["open", "xdg-open"]) fakeCommand(sb, name, `printf '%s\\n' "$@" > "${log}"`);
    expect(await open.run(["https://example.com/x"], fakeIo(sb.env))).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("https://example.com/x\n");
  });

  it("treats --help as help, anywhere", async () => {
    const io = fakeIo(sb.env);
    expect(await open.run(["https://example.com", "--help"], io)).toBe(0);
    expect(io.lines[0]).toMatch(/^Usage: turno open/);
  });

  it("rejects options and extra arguments instead of passing them on", async () => {
    await expect(open.run(["-a", "Calculator"], fakeIo(sb.env))).rejects.toThrow(/only http\(s\) and mailto/);
    await expect(open.run(["work", "https://example.com", "--args"], fakeIo(sb.env))).rejects.toThrow(/usage/);
  });
});
