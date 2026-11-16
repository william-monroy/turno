import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/core/manifest.js";
import { keychainResolver } from "../src/core/secrets.js";
import { argSecrets, collectSources, foundSummary, importServers, maskSecret, mergeSources, urlSecrets } from "../src/mcpd/importer.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let savedPath: string | undefined;
let savedCwd: string;
let securityLog: string;

beforeEach(() => {
  sb = sandbox();
  savedCwd = process.cwd();
  savedPath = process.env.PATH;
  // Any Keychain call (storeKeychainSecret runs `security` from process.env.PATH) hits a fake
  // that only records its arguments, so a test can never touch the real Keychain.
  const bin = join(sb.home, "fakebin");
  mkdirSync(bin, { recursive: true });
  securityLog = join(sb.home, "security.log");
  // Both secret stores log one record per call: argv, then whatever arrived on stdin
  // (`security -i` reads its command there; `secret-tool` reads the value there).
  const logStore = `#!/bin/sh\nprintf 'argv: %s\\n' "$*" >> "${securityLog}"\n[ -t 0 ] || /bin/cat >> "${securityLog}"\n`;
  writeFileSync(join(bin, "security"), logStore);
  writeFileSync(join(bin, "secret-tool"), logStore);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho null\n`);
  chmodSync(join(bin, "security"), 0o755);
  chmodSync(join(bin, "secret-tool"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  sb.env.PATH = process.env.PATH;
  sb.write("work/.keep", "");
  process.chdir(join(sb.home, "work"));
});

afterEach(() => {
  process.chdir(savedCwd);
  process.env.PATH = savedPath;
  sb.cleanup();
});

const GHP = "ghp_abcdefghijklmnop1234";
const SK = "sk-live-0123456789abcdefWXYZ";

describe("secret detection and masking", () => {
  it("masks secrets keeping only their kind and last characters", () => {
    expect(maskSecret(GHP)).toBe("ghp_****1234");
    expect(maskSecret(`Bearer ${SK}`)).toBe("Bearer sk-****WXYZ");
    expect(maskSecret("short")).toBe("****");
  });

  it("finds secrets in args and URL query strings", () => {
    expect(argSecrets(["--api-key=k3y-value-123", "--token", "tok-value-456", "--verbose", "--port", "8080", GHP])).toEqual(["k3y-value-123", "tok-value-456", GHP]);
    expect(argSecrets(["--config", "/etc/x.json", "--key-file", "~/k.pem"])).toEqual([]);
    expect(urlSecrets("https://api.example.com/mcp?api_key=abc123def&region=eu")).toEqual(["abc123def"]);
    expect(urlSecrets("https://api.example.com/mcp")).toEqual([]);
  });

  it("never prints a secret in the preview and marks each hidden one", async () => {
    const report = await importServers({
      gh: { command: "gh-mcp", env: { GITHUB_PERSONAL_ACCESS_TOKEN: GHP } },
      api: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: `Bearer ${SK}` } },
      cli: { command: "tool-mcp", args: ["--api-key=argsecret-0001", "--token", "argsecret-0002"] },
      q: { type: "http", url: "https://q.example.com/mcp?token=querysecret-0003" },
    });
    for (const secret of [GHP, SK, "argsecret-0001", "argsecret-0002", "querysecret-0003"]) {
      expect(report.preview).not.toContain(secret);
      expect(report.toml).toContain(secret);
    }
    expect(report.preview).toContain('GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_****1234"  # secret, hidden');
    expect(report.preview).toContain("Bearer sk-****WXYZ");
    expect(report.literalSecrets.sort()).toEqual(["api.Authorization", "gh.GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(report.fixedSecrets.sort()).toEqual(["cli.args", "q.url"]);
    expect(report.secrets).toEqual([]);
  });
});

describe("${VAR} references", () => {
  it("translates whole variables to env: references and never plans to store a placeholder", async () => {
    const report = await importServers(
      {
        gh: { command: "gh-mcp", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", REGION: "${REGION:-eu}", CUR: "${env:CUR_KEY}", MIXED_TOKEN: "pre-${X}" } },
        rem: { type: "http", url: "https://rem.example.com/mcp", headers: { Authorization: "Bearer ${REM_TOKEN}" } },
      },
      { moveSecrets: true },
    );
    const m = parseManifest(report.toml);
    const gh = m.servers.gh!;
    expect(gh.kind === "stdio" && gh.env).toEqual({ GITHUB_TOKEN: "env:GITHUB_TOKEN", REGION: "env:REGION:-eu", CUR: "env:CUR_KEY", MIXED_TOKEN: "pre-${X}" });
    const rem = m.servers.rem!;
    // Kept as written and direct, so Claude Code expands it as it did before the import.
    expect(rem.kind === "remote" && rem.proxy).toBe(false);
    expect(rem.kind === "remote" && rem.headers.Authorization).toBe("Bearer ${REM_TOKEN}");
    expect(report.secrets).toEqual([]);
    const notes = report.notes.join("\n");
    expect(notes).toContain("MIXED_TOKEN mixes text and a variable");
    expect(notes).toContain("Claude Code expands it");
    expect(notes).toContain("launchctl setenv");
  });

  it("resolves env:NAME:-default at spawn time", async () => {
    const resolve = keychainResolver({ SET: "yes", EMPTY: "" });
    expect(await resolve("env:SET:-no")).toBe("yes");
    expect(await resolve("env:UNSET:-fallback")).toBe("fallback");
    expect(await resolve("env:EMPTY:-fallback")).toBe("fallback");
    expect(await resolve("env:EMPTY")).toBe("");
    await expect(resolve("env:UNSET")).rejects.toThrow(/not set/);
  });
});

describe("sources", () => {
  it("reads Claude Code user and project servers, .mcp.json, Codex, Cursor and Copilot, skipping gateway entries", () => {
    sb.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: { user1: { command: "u-mcp" }, gw: { type: "http", url: "http://127.0.0.1:47821/mcp/gw", headers: { "X-Turno-Profile": "work" } } },
        projects: { [join(sb.home, "code/app")]: { mcpServers: { filesystem: { command: "fs-mcp", args: ["."] } } } },
      }),
    );
    sb.write("work/.mcp.json", JSON.stringify({ mcpServers: { folder1: { command: "f-mcp" } } }));
    sb.write(".codex/config.toml", '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\nenv_vars = ["CTX_KEY"]\n\n[mcp_servers.gwc]\nurl = "http://127.0.0.1:47821/mcp/gwc"\nbearer_token_env_var = "TURNO_MCPD_TOKEN"\n');
    sb.write(".cursor/mcp.json", JSON.stringify({ mcpServers: { cur1: { url: "https://cur.example.com/mcp" } } }));
    sb.write(".copilot/mcp-config.json", JSON.stringify({ mcpServers: { cop1: { type: "local", command: "c-mcp", tools: ["*"] }, user1: { command: "other" } } }));
    const { sources, problems } = collectSources(sb.env, join(sb.home, "work"));
    expect(problems).toEqual([]);
    const merged = mergeSources(sources);
    expect(Object.keys(merged.servers).sort()).toEqual(["context7", "cop1", "cur1", "filesystem", "folder1", "user1"]);
    expect(merged.servers.context7!.env).toEqual({ CTX_KEY: "${CTX_KEY}" });
    expect(merged.notes.join("\n")).toContain("user1: also in ~/.copilot/mcp-config.json with other settings; kept the one from ~/.claude.json");
    const summary = foundSummary(Object.keys(merged.servers), merged.from);
    expect(summary).toMatch(/^found 6 servers: /);
    expect(summary).toContain("1 in ~/.codex/config.toml (context7)");
    expect(summary).toContain("1 in ~/.claude.json project ~/code/app (filesystem)");
  });
});

describe("turno mcp import", () => {
  async function main(args: string[]) {
    const { main } = await import("../src/cli/main.js");
    const io = fakeIo(sb.env);
    const code = await main(["mcp", "import", ...args], io);
    return { code, io, all: [...io.lines, ...io.errors].join("\n") };
  }

  it("previews without writing or storing anything, with secrets masked", async () => {
    sb.write(".claude.json", JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_PERSONAL_ACCESS_TOKEN: GHP } } } }));
    for (const flags of [[], ["--move-secrets"], ["--dry-run", "--move-secrets"]]) {
      const { code, io, all } = await main(flags);
      expect(code).toBe(0);
      expect(all).not.toContain(GHP);
      expect(io.errors.at(-1)).toBe("Nothing written. Write it with: turno mcp import --write --move-secrets");
    }
    expect(existsSync(join(sb.home, ".config/turno/mcp.toml"))).toBe(false);
    expect(existsSync(securityLog)).toBe(false);
  });

  it("stores secrets only with --write --move-secrets", async () => {
    sb.write(".claude.json", JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_PERSONAL_ACCESS_TOKEN: GHP, OTHER_TOKEN: "${OTHER}" } } } }));
    const { code, all } = await main(["--write", "--move-secrets"]);
    expect(code).toBe(0);
    expect(all).not.toContain(GHP);
    const log = readFileSync(securityLog, "utf8");
    expect(log.match(/^argv: /gm)).toHaveLength(1);
    expect(log).toContain("turno/gh/github-personal-access-token");
    expect(log).not.toContain("${");
    // The value never reaches argv on either store.
    expect(log.split("\n").filter((l) => l.startsWith("argv: ")).join("\n")).not.toContain(GHP);
    const text = readFileSync(join(sb.home, ".config/turno/mcp.toml"), "utf8");
    expect(text).toContain('"keychain:turno/gh/github-personal-access-token"');
    expect(text).toContain('"env:OTHER"');
  });

  it("works for a Codex-only user and says so clearly when nothing is found", async () => {
    const none = await main(["--write"]);
    expect(none.code).toBe(1);
    expect(none.all).toContain("No MCP servers found");
    expect(none.all).not.toContain("cannot read");
    expect(existsSync(join(sb.home, ".config/turno/mcp.toml"))).toBe(false);

    sb.write(".codex/config.toml", '[mcp_servers.context7]\ncommand = "ctx-mcp"\n');
    const codex = await main([]);
    expect(codex.code).toBe(0);
    expect(codex.all).toContain("found 1 server: 1 in ~/.codex/config.toml (context7)");
    expect(codex.all).not.toContain("cannot read");
    expect(codex.all).toContain("context7: scope project: unknown server, one process per project folder");
  });
});
