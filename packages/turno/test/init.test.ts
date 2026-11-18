import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferRules, lineDiff } from "../src/cli/commands/init.js";
import { type Io } from "../src/cli/io.js";
import { main } from "../src/cli/main.js";
import { listJournals } from "../src/core/journal.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
const home = (rel: string) => join(sb.home, rel);
const cfgFile = () => home(".config/turno/config.toml");
const mcpFile = () => home(".config/turno/mcp.toml");
const read = (f: string) => readFileSync(f, "utf8");
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

beforeEach(() => {
  sb = sandbox();
  sb.env.PATH = `${home(".local/bin")}:/usr/bin:/bin`;
  sb.env.SHELL = "/bin/zsh";
  fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
  // `npm view <pkg> bin` answers nothing: the importer keeps npx as the command.
  fakeCommand(sb, "npm", "echo null");
  mkdirSync(home(".claude"), { recursive: true });
  writeFileSync(home(".claude/settings.json"), "{}\n");
});
afterEach(() => sb.cleanup());

/** A machine with agents, MCP servers and an account folder made by hand, as init meets it. */
function existingSetup(): void {
  for (const d of ["code/acme/api", "code/acme/web", "code/side"]) mkdirSync(home(d), { recursive: true });
  sb.write(
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
        github: { command: "github-mcp-server", args: ["stdio"], env: { GITHUB_TOKEN: TOKEN } },
      },
      projects: { [home("code/side")]: {} },
    }),
  );
  // ~/.claude-work: used by hand with CLAUDE_CONFIG_DIR, with its own settings.json.
  sb.write(
    ".claude-work/.claude.json",
    JSON.stringify({ projects: { [home("code/acme/api")]: {}, [home("code/acme/web")]: {} } }),
  );
  sb.write(".claude-work/settings.json", '{"theme":"mine"}\n');
  sb.write(".codex/config.toml", '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n');
  sb.write(".codex-cx/config.toml", 'model = "o4"\n');
  // Not an agent home: no marker file, so it is not offered as a profile.
  mkdirSync(home(".cursor-server/bin"), { recursive: true });
}

async function run(
  args: string[],
  io: ReturnType<typeof fakeIo> = fakeIo(sb.env),
): Promise<{ code: number; out: string; err: string }> {
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

/** An Io whose questions are answered by the first matching rule. */
function answering(rules: [RegExp, string][]): ReturnType<typeof fakeIo> & { asked: string[] } {
  const io = fakeIo(sb.env) as ReturnType<typeof fakeIo> & { asked: string[] };
  io.asked = [];
  (io as Io).ask = async (q: string) => {
    io.asked.push(q);
    const hit = rules.find(([re]) => re.test(q));
    if (!hit) throw new Error(`unexpected question: ${q}`);
    return hit[1];
  };
  return io;
}

describe("turno init", () => {
  it("--dry-run shows what it found and the full diff, and writes nothing", async () => {
    existingSetup();
    const r = await run(["init", "--dry-run"]);
    expect(r.code).toBe(0);
    const all = `${r.out}\n${r.err}`;
    expect(all).toMatch(/Claude Code/);
    expect(all).toMatch(/not installed +.*Codex CLI/);
    expect(all).toContain("~/.claude-work");
    expect(all).toContain("~/.codex-cx");
    expect(all).not.toContain(".cursor-server");
    // The folder rule comes from the projects ~/.claude-work used, collapsed to their parent.
    expect(r.out).toContain('+path = "~/code/acme"');
    expect(r.out).toContain("+[profiles.work]");
    expect(r.out).toContain('+agent = "codex"');
    // mcp.toml from every agent config, with the secret masked.
    expect(r.out).toContain("[server.memory]");
    expect(r.out).toContain("[server.context7]");
    expect(all).not.toContain(TOKEN);
    expect(all).toMatch(/moves your own settings\.json/);
    expect(existsSync(cfgFile())).toBe(false);
    expect(existsSync(mcpFile())).toBe(false);
    expect(existsSync(home(".local/bin/claude-work"))).toBe(false);
    expect(listJournals(sb.env)).toHaveLength(0);
  });

  it("imports MCP servers from the agent folders it adopts, not only the main configs", async () => {
    existingSetup();
    sb.write(
      ".claude-work/.claude.json",
      JSON.stringify({
        mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
        projects: { [home("code/acme/api")]: { mcpServers: { db: { command: "db-mcp" } } } },
      }),
    );
    sb.write(".codex-cx/config.toml", 'model = "o4"\n\n[mcp_servers.postgres]\ncommand = "pg-mcp"\n');
    const r = await run(["init", "--dry-run"]);
    expect(r.code).toBe(0);
    for (const s of ["linear", "db", "postgres"]) expect(r.out).toContain(`[server.${s}]`);
    expect(r.out).toContain("1 in ~/.codex-cx/config.toml (postgres)");
  });

  it("previews without asking npm, and asks it only when it writes", async () => {
    existingSetup();
    const log = home("npm.log");
    fakeCommand(sb, "npm", `echo "$*" >> "${log}"; echo '{"mcp-server-memory":"dist/index.js"}'`);
    const dry = await run(["init", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(dry.out).toContain('command = "server-memory"');
    expect(dry.err + dry.out).toMatch(/memory: command name guessed as server-memory; checked on npm when written/);
    const yes = await run(["init", "--yes"]);
    expect(yes.code).toBe(0);
    expect(read(log)).toContain("view @modelcontextprotocol/server-memory bin --json");
    expect(read(mcpFile())).toContain('command = "mcp-server-memory"');
  });

  it("without a terminal it needs --yes, and changes nothing", async () => {
    existingSetup();
    const r = await run(["init"]);
    expect(r.code).toBe(2);
    expect(r.err.split("\n").at(-1)).toBe("turno: init needs an answer; pass --yes (or run it in a terminal)");
    expect(existsSync(cfgFile())).toBe(false);
    expect(existsSync(mcpFile())).toBe(false);
    expect(listJournals(sb.env)).toHaveLength(0);
  });

  const noInput: [string, string[], NodeJS.ProcessEnv][] = [
    ["--no-input before the command", ["--no-input", "init"], {}],
    ["--no-input after it", ["init", "--no-input"], {}],
    ["TURNO_NO_INPUT=1", ["init"], { TURNO_NO_INPUT: "1" }],
    ["Claude Code (CLAUDECODE)", ["init"], { CLAUDECODE: "1" }],
    ["Claude Code (CLAUDE_CODE_CHILD_SESSION)", ["init"], { CLAUDE_CODE_CHILD_SESSION: "1" }],
    ["Codex (CODEX_THREAD_ID)", ["init"], { CODEX_THREAD_ID: "0199a7c1-0000-7000-8000-000000000000" }],
    ["Codex (CODEX_SANDBOX)", ["init"], { CODEX_SANDBOX: "seatbelt" }],
    ["Copilot CLI (COPILOT_CLI)", ["init"], { COPILOT_CLI: "1" }],
    ["Copilot CLI (COPILOT_AGENT_SESSION_ID)", ["init"], { COPILOT_AGENT_SESSION_ID: "abc" }],
    ["Cursor (CURSOR_AGENT)", ["init"], { CURSOR_AGENT: "1" }],
  ];
  for (const [label, args, env] of noInput) {
    it(`asks nothing with ${label}: exit 2, names --yes, changes nothing`, async () => {
      existingSetup();
      Object.assign(sb.env, env);
      const io = answering([[/./, "y"]]);
      const r = await run(args, io);
      expect(io.asked).toEqual([]);
      expect(r.code).toBe(2);
      expect(r.err.split("\n").at(-1)).toBe("turno: init needs an answer; pass --yes (or run it in a terminal)");
      expect(existsSync(cfgFile())).toBe(false);
      expect(existsSync(mcpFile())).toBe(false);
      expect(listJournals(sb.env)).toHaveLength(0);
    });
  }

  it("TURNO_NO_INPUT=0 lets a person answer inside an agent session", async () => {
    existingSetup();
    Object.assign(sb.env, { CLAUDECODE: "1", TURNO_NO_INPUT: "0" });
    const io = answering([[/./, "n"]]);
    await run(["init"], io);
    expect(io.asked.length).toBeGreaterThan(0);
  });

  it("--yes writes config, mcp.toml and profiles as one journal that one undo reverts", async () => {
    existingSetup();
    const r = await run(["init", "--yes"]);
    expect(r.code).toBe(0);
    const cfg = read(cfgFile());
    expect(cfg).toContain("[profiles.work]");
    expect(cfg).toMatch(/\[profiles\.cx\]\nagent = "codex"/);
    expect(cfg).toContain('path = "~/code/acme"');
    expect(read(mcpFile())).toContain("[server.context7]");
    expect(statSync(mcpFile()).mode & 0o777).toBe(0o600);
    expect(existsSync(home(".local/bin/claude-work"))).toBe(true);
    expect(existsSync(home(".local/bin/codex-cx"))).toBe(true);
    expect(isLink(home(".claude-work/settings.json"))).toBe(true);
    const journals = listJournals(sb.env);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.manifest!.command).toBe("init");
    expect(r.out).toContain(`turno undo ${journals[0]!.stamp}`);
    // What is left to do by hand.
    expect(r.out).toMatch(/turno mcp daemon start/);
    expect(r.out).toMatch(/turno mcp sync/);

    const u = await run(["undo", journals[0]!.stamp]);
    expect(u.code).toBe(0);
    expect(existsSync(cfgFile())).toBe(false);
    expect(existsSync(mcpFile())).toBe(false);
    expect(existsSync(home(".local/bin/claude-work"))).toBe(false);
    expect(existsSync(home(".local/bin/codex-cx"))).toBe(false);
    expect(isLink(home(".claude-work/settings.json"))).toBe(false);
    expect(read(home(".claude-work/settings.json"))).toContain("mine");
    expect(readdirSync(home(".claude-work")).filter((n) => n.startsWith(".aside-"))).toEqual([]);
  });

  it("Try it names the launcher of the profile this folder resolves to, else the first new one", async () => {
    existingSetup();
    const saved = process.cwd();
    process.chdir(home("code/acme/api"));
    try {
      // ~/.claude-work was used in ~/code/acme: init makes the rule, so this folder opens work.
      const r = await run(["init", "--yes", "--no-mcp", "--profile", "lab"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Try it: claude-work");
      // The plan said where the file goes; the Write phase only says that it moved.
      expect(r.out).toMatch(/moves your own settings\.json to ~\/\.claude-work\/\.aside-<time>\//);
      expect(r.out).toContain("    ! moved settings.json aside (turno undo puts it back)");
      expect(r.out).toMatch(/^ok Done in \d+(ms|\.\ds)\. Undo all of it with: turno undo \d{8}-\d{6}/m);
      expect(r.out).toMatch(/^Write\n {2}ok wrote ~\/\.config\/turno\/config\.toml$/m);
    } finally {
      process.chdir(saved);
    }
    const other = sandbox();
    try {
      const io = fakeIo({ ...other.env, PATH: sb.env.PATH });
      expect(await main(["init", "--yes", "--no-mcp", "--profile", "lab"], io)).toBe(0);
      expect(io.lines).toContain("Try it: claude-lab");
    } finally {
      other.cleanup();
    }
  });

  it("keeps literal secrets out of the output and says how to move them", async () => {
    existingSetup();
    const r = await run(["init", "--yes"]);
    expect(`${r.out}\n${r.err}`).not.toContain(TOKEN);
    expect(r.err).toMatch(/literal secrets.*github/);
    expect(r.err).toMatch(/--move-secrets/);
  });

  it("asks which folders to adopt, which profiles to make and the default, then confirms", async () => {
    sb.write(".claude-old/.claude.json", "{}");
    const io = answering([
      [/~\/\.claude-old/, "n"],
      [/Profiles to create/, "work personal"],
      [/Default profile/, ""],
      [/Write all of this/, "y"],
    ]);
    const r = await run(["init", "--no-mcp"], io);
    expect(r.code).toBe(0);
    expect(io.asked).toHaveLength(4);
    const cfg = read(cfgFile());
    expect(cfg).toContain('default = "personal"');
    expect(cfg).toContain("[profiles.work]");
    expect(cfg).toContain("[profiles.personal]");
    expect(cfg).not.toContain("[profiles.old]");
    expect(existsSync(home(".local/bin/claude-old"))).toBe(false);
    expect(existsSync(mcpFile())).toBe(false);
  });

  it("answering no at the end changes nothing", async () => {
    existingSetup();
    const io = answering([
      [/Use ~\//, ""],
      [/Default profile/, "none"],
      [/Also start the gateway/, "y"],
      [/Write all of this/, "n"],
    ]);
    const r = await run(["init"], io);
    expect(r.code).toBe(1);
    expect(existsSync(cfgFile())).toBe(false);
    expect(listJournals(sb.env)).toHaveLength(0);
  });

  it("--yes --start also starts the gateway and points every profile at it, in the same journal", async () => {
    existingSetup();
    const calls = home("calls.log");
    fakeCommand(sb, "launchctl", `echo "launchctl $*" >> "${calls}"`);
    fakeCommand(sb, "systemctl", `echo "systemctl $*" >> "${calls}"`);
    // An mcpd already answering /status in this sandbox, as the service would.
    const { startDaemon } = await import("../src/mcpd/daemon.js");
    const d = await startDaemon({ env: sb.env, port: 0 });
    try {
      const r = await run(["init", "--yes", "--start"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("mcpd is running");
      expect(r.out).not.toMatch(/turno mcp daemon start {3}/);
      expect(r.out).toContain("Try it: claude-work");
      const service = process.platform === "darwin" ? home("Library/LaunchAgents") : home(".config/systemd/user");
      expect(readdirSync(service).length).toBe(1);
      expect(read(home(".claude-work/.claude.json"))).toContain("127.0.0.1");
      const journals = listJournals(sb.env);
      expect(journals).toHaveLength(1);
      expect(r.out).toContain("the gateway keeps running until turno mcp daemon stop");

      expect((await run(["undo", journals[0]!.stamp])).code).toBe(0);
      expect(existsSync(join(service, readdirSync(service)[0] ?? "none"))).toBe(false);
      expect(read(home(".claude-work/.claude.json"))).not.toContain("127.0.0.1");
    } finally {
      await d.stop();
    }
  });

  it("--dry-run --start says it would start the gateway; --start and --no-start do not go together", async () => {
    existingSetup();
    const dry = await run(["init", "--dry-run", "--start"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Then: start the gateway as a login service");
    expect(listJournals(sb.env)).toHaveLength(0);
    const both = await run(["init", "--yes", "--start", "--no-start"]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("--start and --no-start do not go together");
  });

  it("takes profiles and the default from flags", async () => {
    const r = await run([
      "init",
      "--yes",
      "--no-mcp",
      "--profile",
      "work",
      "--profile",
      "cx:codex",
      "--default",
      "work",
    ]);
    expect(r.code).toBe(0);
    const cfg = read(cfgFile());
    expect(cfg).toContain('default = "work"');
    expect(cfg).toMatch(/\[profiles\.cx\]\nagent = "codex"/);
    expect(existsSync(home(".local/bin/claude-work"))).toBe(true);
    expect(existsSync(home(".local/bin/codex-cx"))).toBe(true);
  });

  it("refuses a default that is not a Claude Code profile it knows", async () => {
    const r = await run(["init", "--yes", "--no-mcp", "--profile", "cx:codex", "--default", "cx"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--default/);
    expect(existsSync(cfgFile())).toBe(false);
  });

  it("--skip leaves a found folder alone", async () => {
    existingSetup();
    const r = await run(["init", "--yes", "--no-mcp", "--skip", "cx"]);
    expect(r.code).toBe(0);
    expect(read(cfgFile())).not.toContain("[profiles.cx]");
    expect(existsSync(home(".local/bin/codex-cx"))).toBe(false);
  });

  it("offers one profile when two agents' folders share a name", async () => {
    sb.write(".claude-dup/.claude.json", "{}");
    sb.write(".codex-dup/config.toml", "");
    const r = await run(["init", "--dry-run", "--no-mcp"]);
    expect(r.code).toBe(0);
    expect(r.out.match(/\+\[profiles\.dup\]/g)).toHaveLength(1);
    expect(`${r.out}\n${r.err}`).toMatch(/~\/\.codex-dup.*already/);
  });

  it("has nothing to do the second time", async () => {
    existingSetup();
    expect((await run(["init", "--yes"])).code).toBe(0);
    const again = await run(["init", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/Nothing to set up/);
    expect(listJournals(sb.env)).toHaveLength(1);
  });

  it("stops while the bash config waits for turno migrate", async () => {
    sb.write(".config/claudio/proyectos", "~/code work\n");
    const r = await run(["init", "--yes", "--profile", "work"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/turno migrate/);
    expect(existsSync(cfgFile())).toBe(false);
  });
});

describe("inferRules", () => {
  const H = "/h";
  const dirs = new Set([
    "/h/code/acme/api",
    "/h/code/acme/web",
    "/h/code/side",
    "/h/code/mixed/a",
    "/h/code/mixed/b",
    "/h/code/both",
    "/h/x",
  ]);
  const isDir = (d: string) => dirs.has(d);
  const owners = (entries: [string, string[]][]) => new Map(entries.map(([d, ps]) => [d, new Set(ps)]));

  it("collapses sibling folders of one profile to their parent", () => {
    expect(
      inferRules(
        owners([
          ["/h/code/acme/api", ["work"]],
          ["/h/code/acme/web", ["work"]],
        ]),
        H,
        [],
        isDir,
      ),
    ).toEqual([{ path: "/h/code/acme", profile: "work" }]);
  });

  it("keeps siblings of different profiles apart", () => {
    const r = inferRules(
      owners([
        ["/h/code/mixed/a", ["work"]],
        ["/h/code/mixed/b", ["personal"]],
      ]),
      H,
      [],
      isDir,
    );
    expect(r).toEqual([
      { path: "/h/code/mixed/a", profile: "work" },
      { path: "/h/code/mixed/b", profile: "personal" },
    ]);
  });

  it("skips folders used by two accounts, by the plain account, missing, outside HOME or already ruled", () => {
    const r = inferRules(
      owners([
        ["/h/code/both", ["work", "personal"]],
        ["/h/code/side", [""]],
        ["/h/gone", ["work"]],
        ["/tmp/x", ["work"]],
        ["/h/x", ["work"]],
      ]),
      H,
      ["/h/x"],
      isDir,
    );
    expect(r).toEqual([]);
  });

  it("does not collapse into HOME itself", () => {
    expect(
      inferRules(
        owners([
          ["/h/x", ["work"]],
          ["/h/code", ["work"]],
        ]),
        H,
        [],
        (d) => d === "/h/x" || d === "/h/code",
      ),
    ).toEqual([
      { path: "/h/code", profile: "work" },
      { path: "/h/x", profile: "work" },
    ]);
  });
});

describe("lineDiff", () => {
  it("marks added and removed lines", () => {
    expect(lineDiff("a\nb\n", "a\nc\nb\n")).toEqual([
      [" ", "a"],
      ["+", "c"],
      [" ", "b"],
    ]);
    expect(lineDiff("a\nb\n", "b\n")).toEqual([
      ["-", "a"],
      [" ", "b"],
    ]);
  });
});
