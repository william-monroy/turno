import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allPaths } from "../src/cli/diagnostics.js";
import { main } from "../src/cli/main.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

async function run(args: string[], env = sb.env) {
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

const SECRET = "sk-live-0123456789abcdefSECRET";

describe("turno config path --all", () => {
  it("lists every path turno uses, profiles included, with ~ for the home folder", async () => {
    sb.write(".config/turno/config.toml", '[profiles.work]\n[profiles.cx]\nagent = "codex"\n');
    const r = await run(["config", "path", "--all"]);
    expect(r.code).toBe(0);
    for (const name of [
      "config",
      "mcp",
      "mcpd token",
      "call log",
      "launchers",
      "claude hub",
      "codex hub",
      "profile work",
      "launcher cx",
    ]) {
      expect(r.out).toMatch(new RegExp(`^${name}\\s`, "m"));
    }
    expect(r.out).toMatch(/~\/\.codex-cx/);
    expect(r.out).not.toContain(sb.home);
  });

  it("adds the list as `all` under --json, and keeps the short form without --all", async () => {
    const j = JSON.parse((await run(["config", "path", "--all", "--json"])).out);
    expect(j.schemaVersion).toBe(1);
    expect(j.config.path).toBe("~/.config/turno/config.toml");
    const names = j.all.map((e: { name: string }) => e.name);
    expect(names).toEqual(expect.arrayContaining(["state dir", "profile tokens", "compile cache"]));
    for (const e of j.all) expect(Object.keys(e)).toEqual(["name", "path", "exists", "about"]);
    const short = JSON.parse((await run(["config", "path", "--json"])).out);
    expect(short.all).toBeUndefined();
  });

  it("names the service file of the platform", () => {
    expect(allPaths(sb.env, "darwin").find((e) => e.name === "service")?.path).toMatch(
      /LaunchAgents\/dev\.turno\.mcpd\.plist$/,
    );
    expect(allPaths(sb.env, "linux").find((e) => e.name === "service")?.path).toMatch(
      /systemd\/user\/turno-mcpd\.service$/,
    );
  });
});

describe("turno doctor --report", () => {
  it("prints a Markdown block with versions, agents, mcpd, findings and paths, and no secrets", async () => {
    sb.write(".config/turno/config.toml", "[profiles.work]\n");
    sb.write(".config/turno/mcp.toml", `[server.gh]\ncommand = "gh-mcp"\nenv = { GITHUB_TOKEN = "${SECRET}" }\n`);
    sb.write(".local/state/turno/mcpd.token", "master-token-value-123456");
    // Only the fake agent: the real ones on this machine stay out of the test.
    sb.env.PATH = "/usr/bin:/bin";
    fakeCommand(sb, "claude", 'echo "2.1.0 (Claude Code)"');
    const r = await run(["doctor", "--report"]);
    expect([0, 1]).toContain(r.code);
    expect(r.out).toMatch(/^### turno doctor --report$/m);
    expect(r.out).toMatch(/^\| turno \| \d+\.\d+\.\d+/m);
    expect(r.out).toMatch(/^\| node \| /m);
    expect(r.out).toMatch(/^\| Claude Code \| ~\/fakebin\/claude \| 2\.1\.0 \(Claude Code\) \| 1 \|$/m);
    expect(r.out).toMatch(/^\| Codex CLI \| codex \(not found\) \| - \| 0 \|$/m);
    expect(r.out).toMatch(/\*\*mcpd\*\*/);
    expect(r.out).toMatch(/\*\*Doctor\*\*\n\n- \d+ ok, \d+ warnings, \d+ failures, \d+ skipped/);
    expect(r.out).toMatch(/<details><summary>Paths<\/summary>/);
    expect(r.out).toMatch(/^\| profile work \| ~\/\.claude-work \| (yes|no) \|$/m);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain("master-token-value");
    expect(r.out).not.toContain(sb.home);
  });

  it("does not go with --json, --summary or --fix", async () => {
    expect((await run(["doctor", "--report", "--json"])).code).toBe(2);
    expect((await run(["doctor", "--report", "--summary"])).code).toBe(2);
    expect((await run(["doctor", "--report", "--fix"])).code).toBe(2);
  });
});
