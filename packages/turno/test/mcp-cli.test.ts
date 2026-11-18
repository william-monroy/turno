import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinPackage } from "../src/cli/commands/mcp.js";
import { fakeIo } from "./helpers/cli.js";
import { freePort } from "./helpers/net.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let servers: Server[] = [];

async function run(args: string[]) {
  const { main } = await import("../src/cli/main.js");
  const io = fakeIo(sb.env);
  const code = await main(args, io);
  return { code, io, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

/** Every file under the sandbox with its size and mtime, to prove a command wrote nothing. */
function snapshot(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const st = statSync(f);
        out.push(`${f} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  walk(sb.home);
  return out.sort().join("\n");
}

const MANIFEST = '[server.calc]\ncommand = "calc-mcp"\nscope = "shared"\n\n[server.docs]\nurl = "https://docs.example.com/mcp"\n';

beforeEach(async () => {
  sb = sandbox();
  sb.write(".config/turno/config.toml", `default = "work"\nsystem = "personal"\n\n[profiles.work]\n[profiles.personal]\n\n[mcpd]\nport = ${await freePort()}\n`);
  sb.write(".config/turno/mcp.toml", MANIFEST);
  sb.write(".claude.json", "{}\n");
});

afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
  sb.cleanup();
});

describe("turno mcp flags", () => {
  const SUBS = ["list", "sync", "config", "import", "install", "refresh", "doctor"];

  it("--help prints usage and changes nothing; a mistyped flag is a usage error", async () => {
    const before = snapshot();
    for (const sub of SUBS) {
      const help = await run(["mcp", sub, "--help"]);
      expect(help.code, sub).toBe(0);
      expect(help.out, sub).toContain(`turno mcp ${sub}`);
      for (const typo of ["--dryrun", "--dry-rn", "--hlep"]) {
        const bad = await run(["mcp", sub, typo]);
        expect(bad.code, `${sub} ${typo}`).toBe(2);
        expect(bad.err, `${sub} ${typo}`).toContain(`turno: unknown option ${typo}`);
      }
    }
    for (const args of [["mcp", "--help"], ["mcp", "daemon", "--help"], ["mcp", "daemon", "start", "--help"], ["mcp", "import", "--move-secrets", "--write", "--help"]]) {
      expect((await run(args)).code, args.join(" ")).toBe(0);
    }
    expect(snapshot()).toBe(before);
  });

  it("read commands take --json", async () => {
    const list = await run(["mcp", "list", "--json"]);
    expect(JSON.parse(list.out).map((s: { name: string }) => s.name)).toEqual(["calc", "docs"]);
    const doctor = await run(["mcp", "doctor", "--json"]);
    expect(JSON.parse(doctor.out)).toEqual({ schemaVersion: 1, ok: true, plugins: [], direct: [] });
    const config = await run(["mcp", "config", "--agent", "opencode", "--json"]);
    expect(JSON.parse(config.out).servers).toEqual(["calc"]);
  });

  it("aligns the list table", async () => {
    const { out } = await run(["mcp", "list"]);
    const [title, head, calc, docs] = out.split("\n");
    expect(title).toBe("MCP servers");
    expect(head).toMatch(/^ {2}SERVER\s+KIND\s+SCOPE\s+IDLE\s+PROFILES\s+STATE\s+AUTH\s+DETAILS$/);
    const col = head!.indexOf("DETAILS");
    expect(calc!.indexOf("calc-mcp")).toBe(col);
    expect(docs!.indexOf("https://docs.example.com/mcp")).toBe(col);
    expect(calc!.indexOf("stdio")).toBe(head!.indexOf("KIND"));
    expect(docs!.indexOf("remote")).toBe(head!.indexOf("KIND"));
    // Without a running mcpd nothing runs, and the list says so once.
    expect(out).toContain("mcpd is not running");
  });
});

describe("turno mcp sync", () => {
  it("skips plain claude while the system profile has a live session, and reads only the sandbox", async () => {
    // A decoy home with a dead run record: if anything fell back to os.homedir(), it would prune it.
    const decoy = realpathSync(mkdtempSync(join(tmpdir(), "turno-decoy-")));
    const decoyRecord = join(decoy, ".local/state/turno/run/999999");
    mkdirSync(join(decoy, ".local/state/turno/run"), { recursive: true });
    writeFileSync(decoyRecord, "work\n");
    const sandboxRecord = sb.write(".local/state/turno/run/999998", "work\n");
    // A live plain `claude` session (this test process) with no run record: the system profile.
    sb.write(".claude/sessions/1.json", JSON.stringify({ pid: process.pid, sessionId: "abcdef12", cwd: sb.home, entrypoint: "cli", status: "idle" }));
    const realHome = process.env.HOME;
    process.env.HOME = decoy;
    try {
      const first = await run(["mcp", "sync"]);
      expect(first.code).toBe(1);
      expect(first.out).toMatch(/^ {2}! +plain claude, profile personal +~\/\.claude\.json +skipped: has open sessions; close them or use --force$/m);
      expect(readFileSync(join(sb.home, ".claude.json"), "utf8")).toBe("{}\n");
      expect(first.out).toMatch(/^ {2}ok +work +~\/\.claude-work\/\.claude\.json +added calc, docs$/m);
      expect(existsSync(decoyRecord)).toBe(true);
      expect(existsSync(sandboxRecord)).toBe(false);
      expect(readdirSync(decoy).sort()).toEqual([".local"]);

      const forced = await run(["mcp", "sync", "--force"]);
      expect(forced.code).toBe(0);
      expect(JSON.parse(readFileSync(join(sb.home, ".claude.json"), "utf8")).mcpServers.calc.url).toMatch(/\/mcp\/calc$/);
    } finally {
      process.env.HOME = realHome;
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it("a dry run creates no token and words its plan as would", async () => {
    const dry = await run(["mcp", "sync", "work", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/^ {2}- +work +~\/\.claude-work\/\.claude\.json +would add calc, docs$/m);
    expect(dry.out).toMatch(/Planned 1 config in \d+(ms|\.\ds)\./);
    expect(dry.out).not.toContain("undo with");
    expect(existsSync(join(sb.home, ".local/state/turno/mcpd.token"))).toBe(false);
    expect(existsSync(join(sb.home, ".claude-work/.claude.json"))).toBe(false);
  });

  it("warns when mcpd is not running and omits the undo hint when nothing changed", async () => {
    const first = await run(["mcp", "sync", "work"]);
    expect(first.out).toContain("undo with: turno undo");
    expect(first.err).toContain("warning: mcpd is not running, so these profiles have no local MCP servers until you run: turno mcp daemon start");
    const again = await run(["mcp", "sync", "work"]);
    expect(again.out).toMatch(/^ {2}- +work +~\/\.claude-work\/\.claude\.json +no changes$/m);
    expect(again.out).not.toContain("undo with");
    expect(again.out).not.toContain("New sessions pick this up");
  });

  it("rejects an unknown profile", async () => {
    const r = await run(["mcp", "sync", "nobody"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no profile 'nobody'");
  });
});

/** A fake npm on the sandbox PATH that logs its arguments and installs a bin named calc-mcp. */
function fakeNpm(): string {
  const dir = join(sb.home, "fakebin");
  mkdirSync(dir, { recursive: true });
  const log = join(sb.home, "npm.log");
  const file = join(dir, "npm");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "view") { console.log(args[2] === "bin" ? "null" : JSON.stringify(["1.2.2", "1.2.3"])); process.exit(0); }
const prefix = args[args.indexOf("--prefix") + 1];
fs.mkdirSync(path.join(prefix, "node_modules", ".bin"), { recursive: true });
fs.writeFileSync(path.join(prefix, "node_modules", ".bin", "calc-mcp"), "");
if (args[0] === "install") {
  fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ private: true, dependencies: { "calc-pkg": "1.2.3" } }));
  fs.writeFileSync(path.join(prefix, "package-lock.json"), "{}");
}
`,
  );
  chmodSync(file, 0o755);
  sb.env.PATH = `${dir}:${sb.env.PATH ?? ""}`;
  return log;
}

describe("turno mcp install", () => {
  it("pins an exact version, skips install scripts, keeps a lockfile and reinstalls from it", async () => {
    sb.write(".config/turno/mcp.toml", '# mine\n[server.calc]\ncommand = "calc-mcp"\npackage = "calc-pkg@^1.2"  # keep\nscope = "shared"\n');
    const log = fakeNpm();
    const dry = await run(["mcp", "install", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would install calc-pkg@1.2.3 for calc without install scripts");
    expect(existsSync(join(sb.home, ".local/share/turno/servers"))).toBe(false);

    const first = await run(["mcp", "install"]);
    expect(first.code).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const inst = calls.find((c) => c[0] === "install")!;
    expect(inst).toContain("--ignore-scripts");
    expect(inst).toContain("--package-lock=true");
    expect(inst.at(-1)).toBe("calc-pkg@1.2.3");
    const text = readFileSync(join(sb.home, ".config/turno/mcp.toml"), "utf8");
    expect(text).toBe('# mine\n[server.calc]\ncommand = "calc-mcp"\npackage = "calc-pkg@1.2.3"  # keep\nscope = "shared"\n');
    expect(first.out).toContain("pinned calc to calc-pkg@1.2.3");

    writeFileSync(log, "");
    expect((await run(["mcp", "install", "calc", "--allow-scripts"])).code).toBe(0);
    const again = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(again.map((c) => c[0])).toEqual(["ci"]);
    expect(again[0]).not.toContain("--ignore-scripts");
  });

  it("rewrites only the package line of the right table", () => {
    const text = '[server.a]\ncommand = "a"\npackage = "x@1"\n\n[server."b.c"]\ncommand = "b"\npackage = "y@latest"\n';
    expect(pinPackage(text, "b.c", "y@2.0.0")).toBe('[server.a]\ncommand = "a"\npackage = "x@1"\n\n[server."b.c"]\ncommand = "b"\npackage = "y@2.0.0"\n');
    expect(pinPackage(text, "missing", "z@1.0.0")).toBeUndefined();
  });
});

describe("turno mcp refresh", () => {
  async function daemon(status: number): Promise<string[]> {
    const seen: string[] = [];
    const s = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${"t".padEnd(40, "0")}` ? "auth" : "noauth"}`);
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    sb.write(".local/state/turno/mcpd.port", String((s.address() as AddressInfo).port));
    sb.write(".local/state/turno/mcpd.token", `${"t".padEnd(40, "0")}\n`, 0o600);
    return seen;
  }

  it("asks the running mcpd to refresh each server", async () => {
    sb.write(".local/share/turno/mcpd/cache/calc@default.json", "{}");
    const seen = await daemon(200);
    const r = await run(["mcp", "refresh", "calc"]);
    expect(r.code).toBe(0);
    expect(seen).toEqual(["POST /refresh/calc auth"]);
    expect(r.out).toContain("forgot 1 cached description\n");
    expect(r.out).toContain("mcpd refreshed calc");
    expect(existsSync(join(sb.home, ".local/share/turno/mcpd/cache/calc@default.json"))).toBe(false);
  });

  it("falls back to the restart hint when mcpd has no refresh endpoint, and previews with --dry-run", async () => {
    sb.write(".local/share/turno/mcpd/cache/calc@default.json", "{}");
    await daemon(404);
    const dry = await run(["mcp", "refresh", "--dry-run"]);
    expect(dry.out).toBe("would forget 1 cached description and ask mcpd to relearn calc, docs");
    expect(existsSync(join(sb.home, ".local/share/turno/mcpd/cache/calc@default.json"))).toBe(true);
    const r = await run(["mcp", "refresh"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("restart mcpd so it relearns them: turno mcp daemon restart");
  });

  it("rejects an unknown server", async () => {
    const r = await run(["mcp", "refresh", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown server 'nope'");
  });
});
