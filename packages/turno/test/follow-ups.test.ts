import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/core/manifest.js";
import { definitionFingerprint } from "../src/mcpd/instances.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { waitFor } from "./helpers/wait.js";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

export async function run(args: string[], env = sb.env) {
  const { main } = await import("../src/cli/main.js");
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

describe("definition fingerprint", () => {
  it("ignores tool filters, which apply per session without a restart", () => {
    const base = '[server.fx]\ncommand = "node"\nargs = ["x.js"]\n';
    const variant = '[server.fx.variant.work]\nenv = { ACCOUNT = "work" }\n';
    const a = parseManifest(base + variant).servers.fx!;
    const b = parseManifest(`${base}tools = { deny = ["drop_*"] }\n${variant}tools = { allow = ["get_*"] }\n`).servers.fx!;
    expect(definitionFingerprint(b)).toBe(definitionFingerprint(a));
    const c = parseManifest(base.replace("x.js", "y.js")).servers.fx!;
    expect(definitionFingerprint(c)).not.toBe(definitionFingerprint(a));
  });
});

describe("turno mcp list", () => {
  it("shows tool filters, the server's and each variant's", async () => {
    sb.write(
      ".config/turno/mcp.toml",
      '[server.fx]\ncommand = "node"\ntools = { allow = ["get_*", "list_*"], deny = ["*_delete"] }\n[server.fx.variant.work]\ntools = { deny = ["*"] }\n[server.plain]\ncommand = "node"\n',
    );
    const r = await run(["mcp", "list"]);
    const fx = r.out.split("\n").find((l) => l.startsWith("fx "))!;
    expect(fx).toContain("tools: allow get_*, list_*, deny *_delete");
    expect(fx).toContain("work tools: deny *");
    expect(r.out.split("\n").find((l) => l.startsWith("plain "))).not.toContain("tools");
    const j = JSON.parse((await run(["mcp", "list", "--json"])).out) as { name: string; tools: unknown; variantTools?: unknown }[];
    expect(j.find((s) => s.name === "fx")).toMatchObject({ tools: { allow: ["get_*", "list_*"], deny: ["*_delete"] }, variantTools: { work: { deny: ["*"] } } });
    expect(j.find((s) => s.name === "plain")).toMatchObject({ tools: null, variantTools: {} });
  });
});

describe("turno mcp sync and profile token files", () => {
  const tokens = () => join(sb.home, ".local/state/turno/mcpd-tokens");

  it("removes the token files it wrote for profiles that are gone, and leaves the others", async () => {
    sb.write(".config/turno/config.toml", '[profiles.cx]\nagent = "codex"\n[profiles.cy]\nagent = "codex"\n');
    expect((await run(["mcp", "sync"])).code).toBe(0);
    expect(existsSync(join(tokens(), "cx.token"))).toBe(true);
    // A token file written for a hand-set agent (turno mcp config) is not sync's to remove.
    writeFileSync(join(tokens(), "manual.token"), "x\n", { mode: 0o600 });
    sb.write(".config/turno/config.toml", '[profiles.cy]\nagent = "codex"\n');
    const dry = await run(["mcp", "sync", "--dry-run"]);
    expect(dry.out).toContain("would remove the gateway token file of cx (no longer a profile)");
    expect(existsSync(join(tokens(), "cx.token"))).toBe(true);
    // A sync of some profiles only does not prune.
    await run(["mcp", "sync", "cy"]);
    expect(existsSync(join(tokens(), "cx.token"))).toBe(true);
    const r = await run(["mcp", "sync"]);
    expect(r.out).toContain("removed the gateway token file of cx (no longer a profile)");
    expect(existsSync(join(tokens(), "cx.token"))).toBe(false);
    expect(existsSync(join(tokens(), "cy.token"))).toBe(true);
    expect(existsSync(join(tokens(), "manual.token"))).toBe(true);
  });
});

describe("turno upgrade --finish and mcp sync", () => {
  async function staleSetup() {
    const { masterToken } = await import("../src/mcpd/daemon.js");
    masterToken(sb.env, "ensure");
    sb.write(".config/turno/config.toml", '[profiles.cx]\nagent = "codex"\n');
    sb.write(".local/state/turno/mcpd-tokens/cx.token", "tp1.cx.stale\n", 0o600);
    sb.write(".local/state/turno/mcp-managed.json", "{}\n", 0o600);
    const { profileTokenFile } = await import("../src/mcpd/tokens.js");
    return () => readFileSync(profileTokenFile("cx", sb.env), "utf8").trim();
  }

  it("only names the sync outside a terminal", async () => {
    const token = await staleSetup();
    const { finishUpgrade } = await import("../src/cli/commands/upgrade.js");
    const io = fakeIo(sb.env);
    expect(await finishUpgrade(io)).toBe(0);
    expect(io.lines.join("\n")).toContain("run: turno mcp sync");
    expect(token()).toBe("tp1.cx.stale");
  });

  it("asks in a terminal, and --yes runs it without asking", async () => {
    const token = await staleSetup();
    const { finishUpgrade } = await import("../src/cli/commands/upgrade.js");
    const asked: string[] = [];
    const no = { ...fakeIo(sb.env), ask: async (q: string) => (asked.push(q), "n") };
    await finishUpgrade(no);
    expect(asked).toEqual(["run turno mcp sync now? [y/N] "]);
    expect(token()).toBe("tp1.cx.stale");
    const yes = { ...fakeIo(sb.env), ask: async () => "y" };
    expect(await finishUpgrade(yes)).toBe(0);
    expect(token()).not.toBe("tp1.cx.stale");

    const again = await staleSetup();
    const io = fakeIo(sb.env);
    expect((await run(["upgrade", "--finish", "--yes"])).code).toBe(0);
    expect(again()).not.toBe("tp1.cx.stale");
    expect(io.lines).toEqual([]);
  });
});

describe("turno upgrade --finish and the journal", () => {
  it("records the launchers it rewrites, so turno undo puts the old ones back", async () => {
    sb.write(".local/state/turno/version", "0.0.1\n");
    const old = "#!/bin/sh\n# Generated by turno: old\nexec claude\n";
    const file = sb.write(".local/bin/claude-work", old, 0o755);
    mkdirSync(join(sb.home, ".claude-work"), { recursive: true });
    const r = await run(["upgrade", "--finish"]);
    expect(r.code).toBe(0);
    expect(readFileSync(file, "utf8")).not.toBe(old);
    expect(r.out).toMatch(/undo with: turno undo \d{8}-\d{6}/);
    const { listJournals } = await import("../src/core/journal.js");
    expect(listJournals(sb.env)[0]?.manifest?.command).toBe("upgrade --finish");
    expect((await run(["undo", "last"])).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(old);
  });
});

describe("turno doctor and accounts", () => {
  it("warns about accounts without read_tools, naming them", async () => {
    sb.write(
      ".config/turno/accounts.toml",
      '[account."linear:work"]\nprofile = "work"\ntools = ["mcp__linear__*"]\nread_tools = ["mcp__linear__get_*"]\n\n[account."gmail:home"]\nprofile = "home"\ntools = ["mcp__gmail__*"]\n',
    );
    const { collectChecks } = await import("../src/cli/commands/doctor.js");
    const checks = await collectChecks(sb.env);
    const w = checks.find((c) => c.text.includes("read_tools"));
    expect(w).toMatchObject({ area: "config", level: "warn" });
    expect(w!.text).toContain("gmail:home");
    expect(w!.text).not.toContain("linear:work");
  });
});

describe("turno mcp install and file modes", () => {
  it("creates the server folder private, and narrows one an older turno left open", async () => {
    sb.write(".config/turno/mcp.toml", '[server.calc]\ncommand = "calc-mcp"\npackage = "calc-pkg@1.2.3"\n');
    const npm = join(sb.home, "fakebin", "npm");
    sb.write(
      "fakebin/npm",
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "view") { console.log(JSON.stringify(["1.2.3"])); process.exit(0); }
const prefix = args[args.indexOf("--prefix") + 1];
fs.mkdirSync(path.join(prefix, "node_modules", ".bin"), { recursive: true });
fs.writeFileSync(path.join(prefix, "node_modules", ".bin", "calc-mcp"), "");
`,
      0o755,
    );
    sb.env.PATH = `${join(sb.home, "fakebin")}:${sb.env.PATH ?? ""}`;
    const servers = join(sb.home, ".local/share/turno/servers");
    mkdirSync(join(servers, "calc"), { recursive: true, mode: 0o755 });
    chmodSync(join(servers, "calc"), 0o755);
    expect((await run(["mcp", "install"])).code).toBe(0);
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(servers)).toBe(0o700);
    expect(mode(join(servers, "calc"))).toBe(0o700);
    expect(mode(join(servers, "calc", "package.json"))).toBe(0o600);
    expect(existsSync(npm)).toBe(true);
  });
});

describe("mcpd and call_log", () => {
  it("turns the call log on and off when config.toml changes, on SIGHUP", async () => {
    const { startDaemon } = await import("../src/mcpd/daemon.js");
    sb.write(".config/turno/config.toml", "[mcpd]\ncall_log = false\n");
    const d = await startDaemon({ env: sb.env, port: 0 });
    try {
      const token = readFileSync(join(sb.home, ".local/state/turno/mcpd.token"), "utf8").trim();
      const enabled = async () =>
        ((await (await fetch(`http://127.0.0.1:${d.port}/status`, { headers: { authorization: `Bearer ${token}` } })).json()) as { callLog: { enabled: boolean } }).callLog.enabled;
      expect(await enabled()).toBe(false);
      sb.write(".config/turno/config.toml", "[mcpd]\ncall_log = true\n");
      process.emit("SIGHUP", "SIGHUP");
      await waitFor(enabled, "the call log to turn on");
      sb.write(".config/turno/config.toml", "[mcpd]\ncall_log = false\n");
      process.emit("SIGHUP", "SIGHUP");
      await waitFor(async () => !(await enabled()), "the call log to turn off");
    } finally {
      await d.stop();
    }
  });
});

describe("turno undo and folder modes", () => {
  it("puts back the mode of a profile folder that profile add made private", async () => {
    fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
    sb.write(".config/turno/config.toml", "");
    const dir = join(sb.home, ".claude-old");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect((await run(["profile", "add", "old", "--yes"])).code).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const u = await run(["undo", "last"]);
    expect(u.code).toBe(0);
    expect(u.out).toContain("mode 755 again ~/.claude-old");
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it("leaves a mode alone that changed since", async () => {
    const { Journal, listJournals, undoJournal } = await import("../src/core/journal.js");
    const dir = join(sb.home, "d");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const j = new Journal(sb.env, "test chmod");
    j.chmod(dir, 0o700);
    j.chmod(dir, 0o700); // already 0700: nothing more to record
    expect(listJournals(sb.env)[0]!.manifest!.entries).toHaveLength(1);
    chmodSync(dir, 0o750);
    const { steps } = undoJournal(listJournals(sb.env).find((x) => x.stamp === j.stamp)!, sb.env);
    expect(steps).toEqual([{ path: dir, action: "skip", reason: "its mode changed since (now 750); left as it is" }]);
    expect(statSync(dir).mode & 0o777).toBe(0o750);
  });
});

describe("turno doctor --security and profile tokens", () => {
  it("names profile token files that predate the master token, next to its age", async () => {
    const { masterToken } = await import("../src/mcpd/daemon.js");
    const { profileToken } = await import("../src/mcpd/tokens.js");
    const { securityChecks } = await import("../src/cli/security.js");
    const master = masterToken(sb.env, "ensure")!;
    sb.write(".local/state/turno/mcpd-tokens/fresh.token", `${profileToken(master, "fresh")}\n`, 0o600);
    let checks = await securityChecks(sb.env);
    expect(checks.find((c) => c.text.startsWith("the mcpd token"))?.text).toBe("the mcpd token is 0 days old (1 profile token derived from it)");
    sb.write(".local/state/turno/mcpd-tokens/old.token", `${profileToken("x".repeat(64), "old")}\n`, 0o600);
    checks = await securityChecks(sb.env);
    const stale = checks.find((c) => c.text.includes("predate"));
    expect(stale).toMatchObject({ level: "warn" });
    expect(stale!.text).toBe("1 profile token file predates the mcpd token, so its agent cannot reach mcpd (~/.local/state/turno/mcpd-tokens/old.token); run turno mcp sync");
  });
});
