import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSON_MCP_SERVERS, TOML_MCP_SERVERS } from "../src/agents/adapter.js";
import { AGENT_IDS, DEFAULT_AGENT, SCAN_ORDER, adapter, mcpFileFor } from "../src/agents/index.js";
import { launcherText } from "../src/cli/launchers.js";
import { collectSources, mergeSources } from "../src/mcpd/importer.js";
import { syncServers } from "../src/mcpd/sync.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const SRC = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? sources(f) : f.endsWith(".ts") ? [f] : [];
  });
}

describe("agent registry (ADR 0032)", () => {
  it("has one adapter per agent id, and every agent in the scan order once", () => {
    for (const id of AGENT_IDS) expect(adapter(id).id).toBe(id);
    expect([...SCAN_ORDER].sort()).toEqual([...AGENT_IDS].sort());
    expect(AGENT_IDS).toContain(DEFAULT_AGENT);
  });

  it("keeps per-agent branches inside src/agents", () => {
    const ids = AGENT_IDS.join("|");
    const branch = new RegExp(`(?:[!=]==\\s*"(?:${ids})"|"(?:${ids})"\\s*[!=]==|case\\s+"(?:${ids})"\\s*:)`);
    const offenders = sources(SRC)
      .filter((f) => !relative(SRC, f).startsWith("agents/"))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .flatMap((line, i) => (branch.test(line) ? [`${relative(SRC, f)}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(offenders).toEqual([]);
  });

  it("writes each launcher from the adapter's data", () => {
    for (const id of AGENT_IDS) {
      const a = adapter(id);
      const text = launcherText("p1", sb.env, id, "darwin");
      expect(text).toContain(`export ${a.homeEnv}="$HOME/${a.dirPrefix}p1"`);
      expect(text).toContain(`exec ${a.command} "$@"`);
      expect(text.includes("TURNO_MCPD_TOKEN=")).toBe(a.tokenFromEnv);
      expect(text.includes(`export TURNO_AGENT="${id}"`)).toBe(!a.classicLauncher);
      for (const [k, v] of Object.entries(a.launcherEnv)) expect(text).toContain(`export ${k}=${v}`);
    }
  });

  it("puts a shared MCP file in the hub and a per-profile one in the profile", () => {
    for (const id of AGENT_IDS) {
      const a = adapter(id);
      const file = mcpFileFor("p1", id, sb.env);
      if (a.mcp.shared) expect(file).toBe(mcpFileFor("p2", id, sb.env));
      else expect(file.startsWith(join(sb.home, `${a.dirPrefix}p1`))).toBe(true);
    }
  });
});

describe("MCP stores", () => {
  it("syncs a TOML store and a JSON store through one entry point", () => {
    const toml = sb.write(".x/config.toml", 'model = "m"\n');
    expect(syncServers(toml, TOML_MCP_SERVERS, { a: { url: "http://127.0.0.1:1/mcp/a" } }, []).added).toEqual(["a"]);
    expect((parse(readFileSync(toml, "utf8")) as { mcp_servers: Record<string, unknown> }).mcp_servers.a).toEqual({
      url: "http://127.0.0.1:1/mcp/a",
    });
    expect(syncServers(toml, TOML_MCP_SERVERS, {}, ["a"]).removed).toEqual(["a"]);
    expect(parse(readFileSync(toml, "utf8"))).toEqual({ model: "m" });

    const json = sb.write(".x/mcp.json", JSON.stringify({ keep: 1 }));
    syncServers(json, JSON_MCP_SERVERS, { a: { url: "u" } }, []);
    expect(JSON.parse(readFileSync(json, "utf8"))).toEqual({ keep: 1, mcpServers: { a: { url: "u" } } });
  });

  it("imports from every agent's hub file in the scan order, first source winning a name", () => {
    sb.write(".claude.json", JSON.stringify({ mcpServers: { a: { command: "claude-a" } } }));
    sb.write(".codex/config.toml", '[mcp_servers.b]\ncommand = "codex-b"\nargs = []\n');
    sb.write(".cursor/mcp.json", JSON.stringify({ mcpServers: { c: { command: "cursor-c" } } }));
    sb.write(
      ".copilot/mcp-config.json",
      JSON.stringify({ mcpServers: { c: { command: "copilot-c" }, d: { command: "copilot-d" } } }),
    );
    const { sources: found, problems } = collectSources(sb.env, sb.home);
    expect(problems).toEqual([]);
    expect(found.map((s) => s.label)).toEqual([
      "~/.claude.json",
      "~/.codex/config.toml",
      "~/.cursor/mcp.json",
      "~/.copilot/mcp-config.json",
    ]);
    const merged = mergeSources(found);
    expect(merged.servers.b).toEqual({ type: "stdio", command: "codex-b", args: [] });
    expect(merged.servers.c).toEqual({ command: "cursor-c" });
    expect(Object.keys(merged.servers).sort()).toEqual(["a", "b", "c", "d"]);
  });
});
