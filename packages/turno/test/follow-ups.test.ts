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
