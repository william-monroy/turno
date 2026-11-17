import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRegistry } from "../src/accounts/registry.js";
import { command as identity, setBrowserDeps } from "../src/cli/commands/identity.js";
import { formatCall, renderTop, type TopSnapshot } from "../src/cli/commands/mcp-observe.js";
import { pillColor } from "../src/cli/commands/statusline.js";
import { renderUsage } from "../src/cli/commands/usage.js";
import { colors } from "../src/cli/io.js";
import { writeLauncher } from "../src/cli/launchers.js";
import { main, takeColor } from "../src/cli/main.js";
import { profileColor, stripAnsi } from "../src/cli/style.js";
import { parseConfig } from "../src/core/config.js";
import type { CallRecord } from "../src/mcpd/calllog.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const ESC = "\x1b[";
const tty = () => ({ ...fakeIo({ ...sb.env, COLUMNS: "100" }), isTty: true });

describe("--color and TURNO_COLOR (ADR 0037)", () => {
  const on = (env: NodeJS.ProcessEnv, isTty: boolean, color?: "auto" | "always" | "never") => colors({ env, isTty, ...(color ? { color } : {}) });

  it("follows one order: --color, TURNO_COLOR, NO_COLOR, FORCE_COLOR, then the terminal", () => {
    // 5. auto: a terminal gets colors, a pipe does not.
    expect(on({}, true)).toBe(true);
    expect(on({}, false)).toBe(false);
    // 4. FORCE_COLOR colors a pipe, and 0 turns a terminal off.
    expect(on({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(on({ FORCE_COLOR: "0" }, true)).toBe(false);
    // 3. NO_COLOR beats FORCE_COLOR.
    expect(on({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
    expect(on({ NO_COLOR: "" }, true)).toBe(true);
    // 2. TURNO_COLOR beats NO_COLOR and FORCE_COLOR; other values are auto.
    expect(on({ TURNO_COLOR: "always", NO_COLOR: "1" }, false)).toBe(true);
    expect(on({ TURNO_COLOR: "never", FORCE_COLOR: "1" }, true)).toBe(false);
    expect(on({ TURNO_COLOR: "sometimes" }, true)).toBe(true);
    expect(on({ TURNO_COLOR: "auto", NO_COLOR: "1" }, true)).toBe(false);
    // 1. --color beats everything, and --color auto sets TURNO_COLOR aside.
    expect(on({ TURNO_COLOR: "never", NO_COLOR: "1" }, false, "always")).toBe(true);
    expect(on({ TURNO_COLOR: "always", FORCE_COLOR: "1" }, true, "never")).toBe(false);
    expect(on({ TURNO_COLOR: "always" }, false, "auto")).toBe(false);
    expect(on({ TURNO_COLOR: "never" }, true, "auto")).toBe(true);
    expect(on({ NO_COLOR: "1" }, true, "auto")).toBe(false);
  });

  it("is taken before the command or among its flags, never after -- or from an agent's arguments", () => {
    expect(takeColor(["--color", "always", "status"])).toEqual({ argv: ["status"], color: "always" });
    expect(takeColor(["--color=never", "status"])).toEqual({ argv: ["status"], color: "never" });
    expect(takeColor(["status", "--color", "never", "--json"])).toEqual({ argv: ["status", "--json"], color: "never" });
    expect(takeColor(["--no-input", "--color", "always", "init", "--yes"])).toEqual({ argv: ["--no-input", "init", "--yes"], color: "always" });
    expect(takeColor(["status"])).toEqual({ argv: ["status"] });
    expect(takeColor(["--color", "always"])).toEqual({ argv: [], color: "always" });
    // The last one wins.
    expect(takeColor(["--color", "always", "status", "--color=never"]).color).toBe("never");
    // A profile's own --color keeps its value.
    expect(takeColor(["profile", "add", "work", "--color", "green"])).toEqual({ argv: ["profile", "add", "work", "--color", "green"] });
    expect(takeColor(["demo", "--", "turno", "status", "--color", "never"])).toEqual({ argv: ["demo", "--", "turno", "status", "--color", "never"] });
    expect(takeColor(["run", "work", "--color", "never"])).toEqual({ argv: ["run", "work", "--color", "never"] });
    expect(takeColor(["work", "--color", "never"])).toEqual({ argv: ["work", "--color", "never"] });
    expect(() => takeColor(["--color", "blue", "status"])).toThrow("--color blue: use auto, always or never");
    expect(() => takeColor(["--color"])).toThrow("--color needs a value");
  });

  it("colors a pipe with --color always, but never --json outside a terminal", async () => {
    sb.write(".config/turno/mcp.toml", '[server.docs]\nurl = "https://docs.example.com/mcp"\n');
    const plain = fakeIo(sb.env);
    expect(await main(["mcp", "list"], plain)).toBe(0);
    expect(plain.lines.join("\n")).not.toContain(ESC);
    const forced = fakeIo(sb.env);
    expect(await main(["--color", "always", "mcp", "list"], forced)).toBe(0);
    expect(forced.lines.join("\n")).toContain(ESC);
    const json = fakeIo(sb.env);
    expect(await main(["mcp", "list", "--json", "--color", "always"], json)).toBe(0);
    expect(json.lines.join("\n")).not.toContain(ESC);
    expect(JSON.parse(json.lines.join("\n"))[0].name).toBe("docs");
    const never = tty();
    expect(await main(["mcp", "list", "--color=never"], never)).toBe(0);
    expect(never.lines.join("\n")).not.toContain(ESC);
  });

  it("refuses a bad value with exit 2", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["--color", "loud", "status"], io)).toBe(2);
    expect(io.errors).toEqual(["turno: --color loud: use auto, always or never"]);
  });
});

describe("one color rule for profile pills", () => {
  it("draws the status line pill with the same color as every other pill", () => {
    const config = parseConfig('[profiles.work]\ncolor = "violet"\n[profiles.home]\ncolor = 33\n[profiles.lab]\n[profiles.x]\ncolor = "nope"\n');
    for (const name of ["work", "home", "lab", "x", "unknown"]) expect(pillColor(config, name)).toBe(profileColor(config.profiles, name));
  });
});

describe("turno limit show", () => {
  const accounts = { work: { email: "alice@example.com", plan: "max" }, personal: { email: "not logged in", plan: "" } };
  const now = 1_800_000_000;
  beforeEach(() => {
    sb.write(".local/state/turno/usage/work.json", JSON.stringify({ updated_at: now - 60, rate_limits: { five_hour: { used_percentage: 100, resets_at: now + 600 }, seven_day: { used_percentage: 70, resets_at: now + 86400 } } }));
    sb.write(".local/state/turno/exhausted/work", `${now + 600}\n`);
  });

  it("plain: the account, a bar per window, the exhausted mark, no ANSI", () => {
    const text = renderUsage(["work", "personal"], accounts, fakeIo(sb.env), { now });
    expect(text).not.toContain(ESC);
    expect(text).toContain("work  alice@example.com · max");
    expect(text).toMatch(/^ {2}5 hours {2}█{20} 100% {2}used up, resets in 10m/m);
    expect(text).toMatch(/^ {2}week {5}█{14}░{6} {2}70% {2}resets in 1d 0h/m);
    expect(text).toMatch(/^ {2}x {2}exhausted until .*: its projects open with the fallback, if one is set$/m);
    expect(text).toContain("personal  not logged in");
  });

  it("on a terminal: pills in the profile's color, colored bars and a red exhausted mark", () => {
    const text = renderUsage(["work", "personal"], accounts, tty(), { now, colors: { work: { color: "violet" }, personal: {} } });
    expect(text).toContain(`${ESC}48;5;91;1;38;5;255m work ${ESC}0m`);
    expect(text).toContain(`${ESC}31m${"━".repeat(20)}`);
    expect(text).toContain(`${ESC}33m${"━".repeat(14)}`);
    expect(text).toContain(`${ESC}31mexhausted until`);
    expect(stripAnsi(text)).toMatch(/✗ exhausted until/);
  });
});

describe("turno mcp list, top and log", () => {
  beforeEach(() => {
    sb.write(".config/turno/config.toml", '[profiles.work]\ncolor = "violet"\n');
    sb.write(
      ".config/turno/mcp.toml",
      [
        '[server.calc]\ncommand = "calc-mcp"\nprofiles = ["work"]\ntools = { deny = ["*_delete"] }',
        '[server.keys]\ncommand = "keys-mcp"\nenv = { TOKEN = "keychain:keys-token" }',
        '[server.docs]\nurl = "https://docs.example.com/mcp"',
      ].join("\n"),
    );
  });

  it("plain: a table with server, kind, scope, profiles, state, auth and details", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["mcp", "list"], io)).toBe(0);
    const [title, head, ...rows] = io.lines;
    expect(title).toBe("MCP servers");
    expect(head).toMatch(/^ {2}SERVER +KIND +SCOPE +IDLE +PROFILES +STATE +AUTH +DETAILS$/);
    expect(rows.find((l) => l.startsWith("  calc "))).toMatch(/calc +stdio +shared +30m +work +- +- +calc-mcp; tools: deny \*_delete$/);
    expect(rows.find((l) => l.startsWith("  keys "))).toMatch(/keys +stdio +shared +30m +all +- +secret +keys-mcp$/);
    expect(rows.find((l) => l.startsWith("  docs "))).toMatch(/docs +remote +direct +- +all +direct +- +https:\/\/docs\.example\.com\/mcp$/);
    expect(io.lines.join("\n")).not.toContain(ESC);
  });

  it("on a terminal: a header rule, the profile pill and the state icon", async () => {
    const io = tty();
    expect(await main(["mcp", "list"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain(`${ESC}1mMCP servers${ESC}0m ${ESC}90m─`);
    expect(text).toContain(`${ESC}48;5;91;1;38;5;255m work ${ESC}0m`);
    expect(stripAnsi(text)).toContain("mcpd is not running");
  });

  it("on a narrow terminal the details go under each row", async () => {
    const io = { ...fakeIo({ ...sb.env, COLUMNS: "60" }), isTty: true };
    expect(await main(["mcp", "list"], io)).toBe(0);
    const lines = io.lines.map(stripAnsi);
    const calc = lines.findIndex((l) => l.startsWith("  calc "));
    expect(lines[calc]).not.toContain("calc-mcp");
    expect(lines[calc + 1]).toBe("      calc-mcp; tools: deny *_delete");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
  });

  const snap: TopSnapshot = {
    running: true,
    mcpd: { pid: 100, version: "1.2.3", uptimeSeconds: 3700, sessions: 2, agents: 1, rssBytes: 50 * 1024 * 1024, totalRssBytes: 150 * 1024 * 1024 },
    instances: [
      { server: "calc", variant: "default", scope: "shared", pid: 200, rssBytes: 100 * 1024 * 1024, sessions: 2, inflight: 1, idleSeconds: 5, restarts: 2, uptimeSeconds: 600, heldBy: null },
      { server: "docs", variant: "work", scope: "shared", pid: null, rssBytes: null, sessions: 1, inflight: 0, idleSeconds: 50, restarts: 0, uptimeSeconds: 60, heldBy: { profile: "work", pid: 300 } },
    ],
    memoryKnown: true,
  };

  it("top: plain columns line up, numbers to the right", () => {
    const lines = renderTop(fakeIo(sb.env), snap);
    expect(lines[0]).toBe("mcpd pid 100 · v1.2.3 · up 1h 1m · 50 MB own, 150 MB with servers · 2 sessions from 1 agent");
    expect(lines[1]).toMatch(/^SERVER +VARIANT +SCOPE +PID +RSS +SESSIONS +IN FLIGHT +IDLE +RESTARTS +UP +HELD BY$/);
    expect(lines[2]).toMatch(/^calc +default +shared +200 +100 MB +2 +1 +5s +2 +10m 0s$/);
    expect(lines[3]).toMatch(/^docs +work +shared +- +in mcpd +1 +0 +50s +0 +1m 0s +work\/300$/);
    // Right-aligned: each RSS cell ends where the header does.
    const end = lines[1]!.indexOf("RSS") + 3;
    expect(lines[2]!.slice(0, end).endsWith("100 MB")).toBe(true);
    expect(lines.join("\n")).not.toContain(ESC);
  });

  it("top on a terminal: running icons, calls in flight and restarts stand out", () => {
    const text = renderTop(tty(), snap).join("\n");
    expect(text).toContain(`${ESC}32m●${ESC}0m`);
    expect(text).toContain(`${ESC}36m1${ESC}0m`);
    expect(text).toContain(`${ESC}33m2${ESC}0m`);
  });

  const call = (over: Partial<CallRecord>): CallRecord =>
    ({ time: "2026-11-16T10:00:00.000Z", outcome: "ok", durationMs: 12, server: "calc", variant: "default", tool: "add", profile: "work", agent: "claude-code", requestBytes: 100, responseBytes: 2048, ...over }) as CallRecord;
  const at = () => "10:00:00";

  it("log: aligned plain lines, the outcome in its own column", () => {
    const a = formatCall(fakeIo(sb.env), call({}), at);
    const b = formatCall(fakeIo(sb.env), call({ outcome: "timeout", durationMs: 30_000, server: "docs", variant: "work", tool: "search", error: "timed out after 30s" }), at);
    expect(a).toBe(`10:00:00 ${"ok".padEnd(9)} ${"12 ms".padStart(9)} ${"calc".padEnd(18)} ${"add".padEnd(22)} ${"work".padEnd(10)} ${"claude-code".padEnd(16)} 100 B in, 2.0 KB out`);
    expect(b.indexOf("docs@work")).toBe(a.indexOf("calc"));
    expect(b.indexOf("search")).toBe(a.indexOf("add"));
    expect(b).toMatch(/timed out after 30s$/);
  });

  it("log on a terminal: the outcome gets an icon and its color, errors are red", () => {
    const ok = formatCall(tty(), call({}), at);
    const bad = formatCall(tty(), call({ outcome: "error", error: "boom" }), at);
    expect(ok).toContain(`${ESC}32m✓${ESC}0m ${ESC}32mok${ESC}0m`);
    expect(bad).toContain(`${ESC}31m✗${ESC}0m ${ESC}31merror${ESC}0m`);
    expect(bad).toContain(`${ESC}31mboom${ESC}0m`);
    expect(stripAnsi(ok).indexOf("calc")).toBe(stripAnsi(bad).indexOf("calc"));
  });
});

describe("turno identity list", () => {
  let prev: ReturnType<typeof setBrowserDeps>;
  beforeEach(() => {
    mkdirSync(join(sb.home, ".claude-work"), { recursive: true });
    writeLauncher("work", sb.env);
    sb.write(".config/turno/config.toml", '[profiles.work]\ncolor = "green"\n');
    saveRegistry(
      {
        accounts: {
          "linear:work": { id: "linear:work", service: "linear", profile: "work", tools: ["mcp__linear__*"], confirm: "writes", readTools: ["mcp__linear__get_*"], description: "team tracker" },
          "gmail:home": { id: "gmail:home", service: "gmail", profile: "home", tools: ["mcp__gmail__*"] },
        },
        prefer: [{ path: join(sb.home, "code"), accounts: { linear: "linear:work" } }],
      } as never,
      sb.env,
    );
    prev = setBrowserDeps({
      load: async () => ({ listIdentities: () => [{ id: "school", inUse: false, dir: join(sb.home, "chrome/school") }] }) as never,
    } as never);
  });
  afterEach(() => {
    setBrowserDeps(prev);
  });

  it("plain: sections, aligned accounts with their policy, preferences and browser identities", async () => {
    const io = fakeIo(sb.env);
    expect(await identity.run(["list"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).not.toContain(ESC);
    expect(io.lines[0]).toBe("Service accounts");
    expect(text).toMatch(/^ {2}gmail:home {3}home {2}mcp__gmail__\* {2}\(no launcher\)\n {15}confirm always \(default\)/m);
    expect(text).toMatch(/^ {2}linear:work {2}work {2}mcp__linear__\*\n {15}confirm writes; reads: mcp__linear__get_\*\n {15}team tracker$/m);
    expect(text).toMatch(/^Folder preferences\n {2}~\/code {2}linear=linear:work$/m);
    expect(text).toMatch(/^Browser identities\n {2}browser:school {2}free {2}~\/chrome\/school$/m);
  });

  it("on a terminal: headers, the profile pill and the free icon", async () => {
    const io = tty();
    expect(await identity.run(["list"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain(`${ESC}1mService accounts${ESC}0m ${ESC}90m─`);
    expect(text).toContain(`${ESC}48;5;28;1;38;5;255m work ${ESC}0m`);
    expect(text).toContain(`${ESC}33m(no launcher)${ESC}0m`);
    expect(stripAnsi(text)).toContain("○ free");
  });
});
