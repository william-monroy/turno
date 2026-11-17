import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentHub, agentProfileDir, mcpFileFor } from "../src/agents/index.js";
import { gatewaySnippet, SNIPPET_AGENTS } from "../src/agents/snippets.js";
import { setupProfiles } from "../src/cli/commands/setup.js";
import { launcherPath } from "../src/cli/launch.js";
import { launcherText } from "../src/cli/launchers.js";
import { ConfigError, loadConfig, parseConfig } from "../src/core/config.js";
import { agentOf, listProfiles } from "../src/core/profiles.js";
import { resolveProfile } from "../src/core/resolve.js";
import { gatewayEntryFor, syncCodexToml, syncJsonServers } from "../src/mcpd/sync.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  mkdirSync(join(sb.home, ".claude"));
});
afterEach(() => sb.cleanup());

const CONFIG = `
default = "work"

[profiles.work]
[profiles.cx]
agent = "codex"
[profiles.cx2]
agent = "codex"
[profiles.gh]
agent = "copilot"
[profiles.cur]
agent = "cursor"

[agents.codex]
default = "cx"
fallback = "cx2"

[[projects]]
path = "~/code/acme"
profile = "work"

[[projects]]
path = "~/code/acme"
profile = "cx2"
`;

describe("agent config", () => {
  it("reads the agent of each profile and the per-agent default and fallback", () => {
    const c = parseConfig(CONFIG, "config.toml", sb.env);
    expect(c.profiles.work!.agent).toBe("claude");
    expect(c.profiles.cx!.agent).toBe("codex");
    expect(c.agents.codex).toEqual({ default: "cx", fallback: "cx2" });
    expect(agentOf("cur", c)).toBe("cursor");
    expect(agentOf("unknown", c)).toBe("claude");
  });

  it("rejects an unknown agent", () => {
    expect(() => parseConfig('[profiles.x]\nagent = "amp"\n', "config.toml", sb.env)).toThrow(ConfigError);
    expect(() => parseConfig('[agents.amp]\ndefault = "x"\n', "config.toml", sb.env)).toThrow(ConfigError);
  });

  it("lists profiles of every agent, or of one", () => {
    const c = parseConfig(CONFIG, "config.toml", sb.env);
    expect(listProfiles(c, sb.env)).toEqual(["cur", "cx", "cx2", "gh", "work"]);
    expect(listProfiles(c, sb.env, "codex")).toEqual(["cx", "cx2"]);
    expect(listProfiles(c, sb.env, "claude")).toEqual(["work"]);
  });

  it("resolves folder rules per agent", () => {
    mkdirSync(join(sb.home, "code/acme/sub"), { recursive: true });
    mkdirSync(join(sb.home, "elsewhere"), { recursive: true });
    const c = parseConfig(CONFIG, "config.toml", sb.env);
    const acme = join(sb.home, "code/acme/sub");
    expect(resolveProfile(acme, c, sb.env, [acme]).chosen).toBe("work");
    expect(resolveProfile(acme, c, sb.env, [acme], "codex").chosen).toBe("cx2");
    const other = join(sb.home, "elsewhere");
    expect(resolveProfile(other, c, sb.env, [other], "codex").chosen).toBe("cx");
    expect(resolveProfile(other, c, sb.env, [other], "copilot").chosen).toBe("");
  });

  it("uses the agent's own fallback when its profile is exhausted", () => {
    sb.write(".local/state/turno/exhausted/cx", `${Math.floor(Date.now() / 1000) + 3600}\n`);
    const other = join(sb.home, "elsewhere");
    mkdirSync(other, { recursive: true });
    const c = parseConfig(CONFIG, "config.toml", sb.env);
    const r = resolveProfile(other, c, sb.env, [other], "codex");
    expect(r.assigned).toBe("cx");
    expect(r.chosen).toBe("cx2");
  });
});

describe("agent launchers", () => {
  it("writes a Codex launcher that moves CODEX_HOME and exports the gateway token", () => {
    const text = launcherText("cx", sb.env, "codex");
    expect(text).toContain('export CODEX_HOME="$HOME/.codex-cx"');
    expect(text).toContain('export TURNO_PROFILE="cx"');
    expect(text).toContain("TURNO_MCPD_TOKEN=");
    // Its own profile token (ADR 0023), never the master token.
    expect(text).toContain('"$HOME/.local/state/turno/mcpd-tokens/cx.token"');
    expect(text).not.toContain("mcpd.token");
    expect(text).toContain('exec codex "$@"');
    expect(text).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("isolates the Cursor login with the file credential store", () => {
    const text = launcherText("cur", sb.env, "cursor");
    expect(text).toContain('export CURSOR_CONFIG_DIR="$HOME/.cursor-cur"');
    expect(text).toContain("export AGENT_CLI_CREDENTIAL_STORE=file");
    expect(text).toContain('exec cursor-agent "$@"');
  });

  it("keeps the Claude Code launcher as it was", () => {
    const text = launcherText("work", sb.env);
    expect(text).toContain('export CLAUDE_CONFIG_DIR="$HOME/.claude-work"');
    expect(text).toContain('exec claude "$@"');
    expect(text).not.toContain("TURNO_MCPD_TOKEN");
  });
});

describe("agent profile setup", () => {
  it("sets up a Codex profile: shared sessions, seeded config with file credentials, launcher", () => {
    sb.write(".config/turno/config.toml", CONFIG);
    sb.write(".codex/config.toml", 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n');
    sb.write(".codex/AGENTS.md", "# shared\n");
    const io = fakeIo(sb.env);
    setupProfiles(["cx"], io, { turno: "turno" });
    const dir = join(sb.home, ".codex-cx");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const item of ["sessions", "prompts", "skills", "AGENTS.md"]) {
      expect(lstatSync(join(dir, item)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, item))).toBe(join(sb.home, ".codex", item));
    }
    const cfg = parse(readFileSync(join(dir, "config.toml"), "utf8")) as Record<string, unknown>;
    expect(cfg.cli_auth_credentials_store).toBe("file");
    expect(cfg.model).toBe("gpt-5");
    expect(statSync(join(dir, "config.toml")).mode & 0o777).toBe(0o600);
    expect(launcherPath("cx", sb.env)).toBe(join(sb.home, ".local/bin/codex-cx"));
    expect(io.lines).toContain("  + command codex-cx");
  });

  it("forces file credentials even when the profile already has a config", () => {
    sb.write(".config/turno/config.toml", CONFIG);
    sb.write(".codex-cx/config.toml", 'cli_auth_credentials_store = "keyring"\nmodel = "o5"\n');
    setupProfiles(["cx"], fakeIo(sb.env), { turno: "turno" });
    const cfg = parse(readFileSync(join(sb.home, ".codex-cx/config.toml"), "utf8")) as Record<string, unknown>;
    expect(cfg.cli_auth_credentials_store).toBe("file");
    expect(cfg.model).toBe("o5");
  });

  it("sets up Copilot and Cursor profiles", () => {
    sb.write(".config/turno/config.toml", CONFIG);
    const io = fakeIo(sb.env);
    setupProfiles(["gh", "cur"], io, { turno: "turno" });
    expect(readlinkSync(join(sb.home, ".copilot-gh/session-state"))).toBe(join(sb.home, ".copilot/session-state"));
    expect(existsSync(join(sb.home, ".cursor-cur"))).toBe(true);
    expect(launcherPath("gh", sb.env)).toBe(join(sb.home, ".local/bin/copilot-gh"));
    expect(launcherPath("cur", sb.env)).toBe(join(sb.home, ".local/bin/cursor-agent-cur"));
    const c = loadConfig(sb.env);
    expect(listProfiles(c, sb.env, "cursor")).toEqual(["cur"]);
  });

  it("knows where each agent keeps its MCP entries", () => {
    expect(mcpFileFor("cx", "codex", sb.env)).toBe(join(sb.home, ".codex-cx/config.toml"));
    expect(mcpFileFor("gh", "copilot", sb.env)).toBe(join(sb.home, ".copilot-gh/mcp-config.json"));
    expect(mcpFileFor("cur", "cursor", sb.env)).toBe(join(sb.home, ".cursor/mcp.json"));
    expect(mcpFileFor("work", "claude", sb.env)).toBe(join(sb.home, ".claude-work/.claude.json"));
    expect(agentHub("codex", sb.env)).toBe(join(sb.home, ".codex"));
    expect(agentProfileDir("cx", "codex", sb.env)).toBe(join(sb.home, ".codex-cx"));
  });
});

describe("gateway entries per agent", () => {
  it("Codex reads the token and the session from the environment", () => {
    expect(gatewayEntryFor("codex", "calendar", 47821, "tok", "cx")).toEqual({
      url: "http://127.0.0.1:47821/mcp/calendar",
      bearer_token_env_var: "TURNO_MCPD_TOKEN",
      http_headers: { "X-Turno-Profile": "cx" },
      env_http_headers: { "X-Turno-Pid": "TURNO_SESSION_PID", "X-Turno-Cwd-B64": "TURNO_SESSION_CWD_B64" },
    });
  });

  it("Cursor shares one file, so the profile comes from the environment too", () => {
    const e = gatewayEntryFor("cursor", "calendar", 47821, "tok", "cur") as { headers: Record<string, string> };
    expect(e.headers.Authorization).toBe("Bearer ${env:TURNO_MCPD_TOKEN}");
    expect(e.headers["X-Turno-Profile"]).toBe("${env:TURNO_PROFILE}");
    expect(JSON.stringify(e)).not.toContain("tok\"");
  });

  it("Copilot uses http entries with variables", () => {
    const e = gatewayEntryFor("copilot", "calendar", 47821, "tok", "gh") as Record<string, unknown>;
    expect(e.type).toBe("http");
    expect((e.headers as Record<string, string>).Authorization).toBe("Bearer ${TURNO_MCPD_TOKEN}");
    expect(e.tools).toEqual(["*"]);
  });

  it("Claude Code keeps the token in the entry, as before", () => {
    const e = gatewayEntryFor("claude", "calendar", 47821, "tok", "work") as { headers: Record<string, string> };
    expect(e.headers.Authorization).toBe("Bearer tok");
  });
});

describe("syncing MCP entries", () => {
  it("adds, updates and removes its own Codex tables and keeps everything else", () => {
    const file = sb.write(
      ".codex-cx/config.toml",
      [
        "# my settings",
        'cli_auth_credentials_store = "file"',
        "",
        "[mcp_servers.mine]",
        'command = "my-mcp"',
        "",
        "[mcp_servers.old]",
        'url = "http://127.0.0.1:1/mcp/old"',
        "",
      ].join("\n"),
    );
    const wanted = { calendar: gatewayEntryFor("codex", "calendar", 47821, "tok", "cx") };
    const res = syncCodexToml(file, wanted, ["old"]);
    expect(res.added).toEqual(["calendar"]);
    expect(res.removed).toEqual(["old"]);
    expect(res.foreign).toEqual(["mine"]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my settings");
    const cfg = parse(text) as { mcp_servers: Record<string, Record<string, unknown>> };
    expect(Object.keys(cfg.mcp_servers).sort()).toEqual(["calendar", "mine"]);
    expect(cfg.mcp_servers.calendar!.bearer_token_env_var).toBe("TURNO_MCPD_TOKEN");
    expect(cfg.mcp_servers.calendar!.env_http_headers).toEqual({ "X-Turno-Pid": "TURNO_SESSION_PID", "X-Turno-Cwd-B64": "TURNO_SESSION_CWD_B64" });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const again = syncCodexToml(file, wanted, ["calendar"]);
    expect(again.changed).toBe(false);
  });

  it("writes JSON server maps for Copilot and Cursor", () => {
    const file = join(sb.home, ".cursor/mcp.json");
    sb.write(".cursor/mcp.json", JSON.stringify({ mcpServers: { editorOnly: { command: "x" } }, other: 1 }));
    const res = syncJsonServers(file, "mcpServers", { calendar: gatewayEntryFor("cursor", "calendar", 47821, "tok", "") }, []);
    expect(res.added).toEqual(["calendar"]);
    const json = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(json.mcpServers).sort()).toEqual(["calendar", "editorOnly"]);
    expect(json.other).toBe(1);
  });
});

describe("gateway snippets for other agents", () => {
  it("prints a config snippet for every agent turno does not manage", () => {
    expect(SNIPPET_AGENTS).toEqual(["opencode", "gemini", "goose", "crush", "droid", "kiro"]);
    const servers = ["calendar", "issues"];
    for (const agent of SNIPPET_AGENTS) {
      const s = gatewaySnippet(agent, servers, 47821, "work");
      expect(s.text).toContain("http://127.0.0.1:47821/mcp/calendar");
      expect(s.text).toContain("issues");
      expect(s.text).toContain("work");
      expect(s.text).not.toMatch(/Bearer [a-f0-9]{16}/);
      expect(s.file.length).toBeGreaterThan(0);
    }
    const opencode = JSON.parse(gatewaySnippet("opencode", servers, 47821, "work").text);
    expect(opencode.mcp.calendar).toMatchObject({ type: "remote", url: "http://127.0.0.1:47821/mcp/calendar" });
    expect(opencode.mcp.calendar.headers.Authorization).toBe("Bearer {env:TURNO_MCPD_TOKEN}");
    const gemini = JSON.parse(gatewaySnippet("gemini", servers, 47821, "work").text);
    expect(gemini.mcpServers.calendar.httpUrl).toBe("http://127.0.0.1:47821/mcp/calendar");
    expect(gatewaySnippet("goose", servers, 47821, "work").text).toContain("type: streamable_http");
  });
});

describe("agent commands", () => {
  it("adds a Codex profile, syncs its gateway entries and prints snippets for other agents", async () => {
    const { main } = await import("../src/cli/main.js");
    sb.write(".config/turno/mcp.toml", '[server.calendar]\ncommand = "cal-mcp"\nscope = "shared"\n\n[server.docs]\nurl = "https://docs.example.com/mcp"\n');
    const io = fakeIo(sb.env);
    expect(await main(["profile", "add", "cx", "--agent", "codex"], io)).toBe(0);
    // The sandbox PATH lacks ~/.local/bin, so the next step uses turno <name>.
    expect(io.lines.some((l) => l.includes("run turno cx login"))).toBe(true);
    expect(io.errors.some((l) => l.includes("is not on your PATH, so codex-cx will not be found"))).toBe(true);
    expect(loadConfig(sb.env).profiles.cx!.agent).toBe("codex");

    // Port 1 never answers, so the "mcpd is not running" check stays inside this machine's sandbox.
    sb.write(".local/state/turno/mcpd.port", "1");
    const sync = fakeIo(sb.env);
    expect(await main(["mcp", "sync", "cx"], sync)).toBe(0);
    expect(sync.errors.join("\n")).toContain("mcpd is not running");
    const cfg = parse(readFileSync(join(sb.home, ".codex-cx/config.toml"), "utf8")) as { mcp_servers: Record<string, Record<string, unknown>> };
    expect(Object.keys(cfg.mcp_servers)).toEqual(["calendar"]);
    expect(cfg.mcp_servers.calendar!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/calendar$/);
    expect(readFileSync(join(sb.home, ".codex-cx/config.toml"), "utf8")).not.toMatch(/Bearer/);

    const list = fakeIo(sb.env);
    expect(await main(["profile", "list"], list)).toBe(0);
    expect(list.lines.some((l) => l.startsWith("cx") && l.includes("Codex CLI (codex-cx)"))).toBe(true);

    const snip = fakeIo(sb.env);
    expect(await main(["mcp", "config", "--agent", "opencode", "--profile", "cx"], snip)).toBe(0);
    expect(snip.lines.join("\n")).toContain('"type": "remote"');
    expect(snip.lines.join("\n")).not.toContain("docs.example.com");
  });
});

describe("folder rules per agent", () => {
  it("assigning a Codex profile keeps the folder's Claude Code rule", async () => {
    const { main } = await import("../src/cli/main.js");
    sb.write(".config/turno/config.toml", CONFIG);
    mkdirSync(join(sb.home, "code/new"), { recursive: true });
    expect(await main(["profile", "assign", join(sb.home, "code/new"), "work"], fakeIo(sb.env))).toBe(0);
    expect(await main(["profile", "assign", join(sb.home, "code/new"), "cx"], fakeIo(sb.env))).toBe(0);
    expect(await main(["profile", "assign", join(sb.home, "code/new"), "cx2"], fakeIo(sb.env))).toBe(0);
    const rules = loadConfig(sb.env).projects.filter((r) => r.path === join(sb.home, "code/new"));
    expect(rules.map((r) => r.profile).sort()).toEqual(["cx2", "work"]);
  });
});

describe("status with other agents", () => {
  it("names the agent of a profile instead of a Claude Code login", async () => {
    const { main } = await import("../src/cli/main.js");
    const io = fakeIo(sb.env);
    expect(await main(["profile", "add", "cx", "--agent", "codex"], fakeIo(sb.env))).toBe(0);
    expect(await main(["status"], io)).toBe(0);
    const row = io.lines.find((l) => /^ {2}cx /.test(l));
    expect(row).toContain("Codex CLI");
    expect(row).not.toContain("not logged in");
  });
});
