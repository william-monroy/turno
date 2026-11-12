import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/core/manifest.js";
import { guessScope, importServers, parseNpx } from "../src/mcpd/importer.js";
import { gatewayEntry, profileServers, syncConfigFile } from "../src/mcpd/sync.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const MANIFEST = `
[server.calc]
command = "calc-mcp"
[server.dev]
command = "dev-mcp"
scope = "session"
profiles = ["work"]
[server.docs]
url = "https://docs.example.com/mcp"
[server.vault]
url = "https://vault.example.com/mcp"
headers = { Authorization = "keychain:vault-token" }
`;

describe("profileServers", () => {
  it("routes stdio and secret-bearing remotes through mcpd and writes plain remotes directly", () => {
    const m = parseManifest(MANIFEST);
    const personal = profileServers(m, "personal", 47821, "tok");
    expect(Object.keys(personal).sort()).toEqual(["calc", "docs", "vault"]);
    expect(personal.calc).toEqual(gatewayEntry("calc", 47821, "tok", "personal"));
    expect(personal.docs).toEqual({ type: "http", url: "https://docs.example.com/mcp" });
    expect((personal.vault as { url: string }).url).toBe("http://127.0.0.1:47821/mcp/vault");
    const headers = (personal.calc as { headers: Record<string, string> }).headers;
    expect(headers["X-Turno-Pid"]).toBe("${TURNO_SESSION_PID:-0}");
    expect(headers["X-Turno-Profile"]).toBe("personal");
    expect(Object.keys(profileServers(m, "work", 1, "t"))).toContain("dev");
  });
});

describe("syncConfigFile", () => {
  it("adds, updates and removes only what turno manages", () => {
    const file = sb.write(".claude-work/.claude.json", JSON.stringify({ oauthAccount: { x: 1 }, mcpServers: { mine: { type: "http", url: "u" }, old: { command: "x" } } }));
    const first = syncConfigFile(file, { calc: { type: "http", url: "a" } }, []);
    expect(first.added).toEqual(["calc"]);
    expect(first.foreign.sort()).toEqual(["mine", "old"]);
    const second = syncConfigFile(file, { calc: { type: "http", url: "b" } }, ["calc", "old"]);
    expect(second.updated).toEqual(["calc"]);
    expect(second.removed).toEqual(["old"]);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.oauthAccount).toEqual({ x: 1 });
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["calc", "mine"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(syncConfigFile(file, { calc: { type: "http", url: "b" } }, ["calc"]).changed).toBe(false);
  });

  it("backs up a foreign entry it replaces and supports dry runs", () => {
    const file = sb.write("cfg.json", JSON.stringify({ mcpServers: { calc: { command: "npx" } } }));
    const backups: string[] = [];
    const dry = syncConfigFile(file, { calc: { type: "http", url: "a" } }, [], { dryRun: true, backup: (n) => backups.push(n) });
    expect(dry.replaced).toEqual(["calc"]);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.calc).toEqual({ command: "npx" });
  });
});

describe("importer", () => {
  it("parses npx invocations and guesses scopes", () => {
    expect(parseNpx(["-y", "chrome-devtools-mcp@latest", "--headless"])).toEqual({ pkg: "chrome-devtools-mcp@latest", rest: ["--headless"] });
    expect(guessScope("npx -y chrome-devtools-mcp@latest").scope).toBe("session");
    expect(guessScope("npx trigger.dev@latest mcp").scope).toBe("project");
    expect(guessScope("something-else").scope).toBe("project");
  });

  it("drafts a manifest, moving secrets when asked", async () => {
    const stored: Record<string, string> = {};
    const report = await importServers(
      {
        calcom: { type: "stdio", command: "npx", args: ["-y", "@calcom/cal-mcp@latest"], env: { CAL_API_KEY: "cal_live_x", REGION: "eu" } },
        neon: { type: "http", url: "https://mcp.neon.example/mcp", headers: { Authorization: "Bearer secret" } },
        granola: { type: "http", url: "https://mcp.granola.example/mcp" },
        local: { command: "/usr/local/bin/thing", args: [] },
      },
      { moveSecrets: true, binOf: async (p) => (p === "@calcom/cal-mcp" ? "cal-mcp" : undefined), store: async (s, v) => void (stored[s] = v) },
    );
    const m = parseManifest(report.toml);
    const calcom = m.servers.calcom!;
    expect(calcom.kind).toBe("stdio");
    if (calcom.kind === "stdio") {
      expect(calcom.command).toBe("cal-mcp");
      expect(calcom.package).toBe("@calcom/cal-mcp@latest");
      expect(calcom.env).toEqual({ CAL_API_KEY: "keychain:turno/calcom/cal-api-key", REGION: "eu" });
      expect(calcom.scope).toBe("shared");
    }
    const neon = m.servers.neon!;
    expect(neon.kind === "remote" && neon.proxy).toBe(true);
    const granola = m.servers.granola!;
    expect(granola.kind === "remote" && granola.proxy).toBe(false);
    expect(stored).toEqual({ "turno/calcom/cal-api-key": "cal_live_x", "turno/neon/authorization": "Bearer secret" });
    expect(report.toml).not.toContain("cal_live_x");
  });

  it("keeps literal secrets and reports them without --move-secrets", async () => {
    const report = await importServers({ s: { command: "x", env: { API_TOKEN: "abc" } } });
    expect(report.literalSecrets).toEqual(["s.API_TOKEN"]);
  });
});

describe("pickBin", () => {
  it("follows the npx rule", async () => {
    const { pickBin } = await import("../src/cli/commands/mcp.js");
    expect(pickBin("chrome-devtools-mcp", { "chrome-devtools": "a", "chrome-devtools-mcp": "b" })).toBe("chrome-devtools-mcp");
    expect(pickBin("@calcom/cal-mcp", { "cal-mcp-demo": "a" })).toBe("cal-mcp-demo");
    expect(pickBin("@scope/thing", "bin.js")).toBe("thing");
  });
});
