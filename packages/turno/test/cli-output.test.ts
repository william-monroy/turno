import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlags } from "../src/cli/args.js";
import { watchJson } from "../src/cli/commands/limit.js";
import { top } from "../src/cli/commands/mcp-observe.js";
import { Exit, exitName } from "../src/cli/exit.js";
import { colors } from "../src/cli/io.js";
import { writeLauncher } from "../src/cli/launchers.js";
import { main } from "../src/cli/main.js";
import { JsonFieldError, SCHEMA_KEY, emit, emitLine, jsonArg, jsonOutput, selectFields, shape } from "../src/cli/output.js";
import { COMMANDS, visibleCommands } from "../src/cli/registry.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.env.PATH = `${join(sb.home, ".local/bin")}:/usr/bin:/bin`;
  // A port nothing listens on, so mcpd is down in every test here.
  sb.write(".config/turno/config.toml", "[profiles.work]\n[profiles.personal]\n\n[mcpd]\nport = 47999\n");
  fakeCommand(sb, "claude", `echo '{"loggedIn":true,"email":"alice@example.com","subscriptionType":"max"}'`);
  for (const name of ["work", "personal"]) {
    mkdirSync(join(sb.home, `.claude-${name}`), { recursive: true });
    writeLauncher(name, sb.env);
  }
});
afterEach(() => sb.cleanup());

async function run(args: string[]) {
  const io = fakeIo(sb.env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n"), io };
}

const OUT = jsonOutput(["name", "email"]);

describe("the output layer (ADR 0045)", () => {
  it("puts schemaVersion first on an object and on each element of a list", () => {
    expect(shape({ name: "work", email: null }, OUT)).toEqual({ schemaVersion: 1, name: "work", email: null });
    expect(Object.keys(shape({ name: "w" }, OUT) as object)[0]).toBe(SCHEMA_KEY);
    expect(shape([{ name: "a" }, { name: "b" }], jsonOutput(["name"], 3))).toEqual([
      { schemaVersion: 3, name: "a" },
      { schemaVersion: 3, name: "b" },
    ]);
  });

  it("keeps only the fields asked for, and refuses an unknown one with the known list", () => {
    expect(shape({ name: "w", email: "e" }, OUT, "email")).toEqual({ schemaVersion: 1, email: "e" });
    expect(selectFields("fields", OUT)).toBe("list");
    expect(selectFields("", OUT)).toBeUndefined();
    expect(() => selectFields("name,nope", OUT)).toThrow(JsonFieldError);
    expect(() => selectFields("nope", OUT)).toThrow('unknown JSON field "nope"; available: email, name');
  });

  it("reads --json=<value> among a command's own flags only", () => {
    expect(jsonArg(["--json"])).toBe("");
    expect(jsonArg(["--json=name"])).toBe("name");
    expect(jsonArg(["x", "--", "--json"])).toBeUndefined();
    const p = parseFlags(["--json=name,email"], { json: { type: "boolean" } });
    expect(p.values.json).toBe(true);
    expect(p.json).toBe("name,email");
    expect(parseFlags(["--json"], { json: { type: "boolean" } }).json).toBe("");
  });

  it("prints indented JSON, and one compact line for NDJSON", () => {
    const io = fakeIo(sb.env);
    emit(io, "", OUT, { name: "w" });
    emitLine(io, "", OUT, { name: "x" });
    expect(io.lines).toEqual(["{", '  "schemaVersion": 1,', '  "name": "w"', "}", '{"schemaVersion":1,"name":"x"}']);
  });
});

describe("--json on the commands", () => {
  it("adds schemaVersion and keeps every existing key", async () => {
    const list = JSON.parse((await run(["profile", "list", "--json"])).out) as Record<string, unknown>[];
    expect(list.map((p) => p.name)).toEqual(["personal", "work"]);
    expect(list[0]).toMatchObject({ schemaVersion: 1, name: "personal", agent: "claude", setUp: true, email: "alice@example.com", plan: "max" });
    const version = JSON.parse((await run(["version", "--json"])).out) as Record<string, unknown>;
    expect(Object.keys(version)).toEqual(["schemaVersion", "name", "version", "node", "method", "path", "latest"]);
  });

  it("--json=fields lists the fields and runs nothing", async () => {
    for (const args of [["status", "--json=fields"], ["profile", "list", "--json=fields"], ["profile", "--json=fields"], ["mcp", "top", "--json=fields"], ["secret", "list", "--json=fields"]]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out.split("\n")[0], args.join(" ")).toMatch(/^Fields for --json/);
      expect(r.out, args.join(" ")).not.toContain("{");
    }
    const r = await run(["profile", "list", "--json=fields"]);
    expect(r.out.split("\n").slice(1)).toContain("  email");
  });

  it("--json=a,b keeps those fields; an unknown field is exit 2 with a JSON error listing the fields", async () => {
    const picked = JSON.parse((await run(["profile", "list", "--json=name,email"])).out) as Record<string, unknown>[];
    expect(picked[0]).toEqual({ schemaVersion: 1, name: "personal", email: "alice@example.com" });
    const bad = await run(["profile", "list", "--json=nope"]);
    expect(bad.code).toBe(Exit.usage);
    expect(bad.out).toBe("");
    const e = JSON.parse(bad.err) as { schemaVersion: number; error: { code: string; exitCode: number; message: string; fields: string[] } };
    expect(e.schemaVersion).toBe(1);
    expect(e.error).toMatchObject({ code: "usage", exitCode: 2 });
    expect(e.error.message).toContain('unknown JSON field "nope"');
    expect(e.error.fields).toContain("email");
  });

  it("errors under --json are one JSON line on stderr with the exit code's name", async () => {
    const r = await run(["profile", "list", "--json", "extra"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err)).toEqual({ schemaVersion: 1, error: { code: "usage", exitCode: 2, message: "unexpected argument 'extra'" } });
    const text = await run(["profile", "list", "extra"]);
    expect(text.err).toBe("turno: unexpected argument 'extra'");
    const missing = await run(["config", "get", "nope", "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err).error).toEqual({ code: "failure", exitCode: 1, message: "nope is not set" });
    expect((await run(["config", "get", "--json=fields"])).code).toBe(Exit.usage);
  });

  it("mcp top and savings exit 5 while mcpd is down, as JSON too", async () => {
    for (const sub of ["top", "savings"]) {
      const r = await run(["mcp", sub, "--json"]);
      expect(r.code, sub).toBe(Exit.gatewayDown);
      expect(JSON.parse(r.out), sub).toEqual({ schemaVersion: 1, running: false });
    }
    const st = await run(["mcp", "daemon", "status", "--json"]);
    expect(st.code).toBe(Exit.gatewayDown);
    expect(JSON.parse(st.out)).toMatchObject({ schemaVersion: 1, running: false });
  });

  it("--watch --json prints NDJSON: limit show and mcp top", async () => {
    const io = fakeIo(sb.env);
    const stop = new AbortController();
    let rounds = 0;
    const counting = { ...io, out: (l = "") => { io.out(l); if (++rounds === 4) stop.abort(); } };
    expect(await watchJson(counting, "", stop.signal, 1)).toBe(0);
    expect(io.lines).toHaveLength(4);
    for (const l of io.lines) expect(JSON.parse(l)).toMatchObject({ schemaVersion: 1, agent: "claude" });
    expect(io.lines.map((l) => JSON.parse(l).profile)).toEqual(["personal", "work", "personal", "work"]);

    const t = fakeIo(sb.env);
    const halt = new AbortController();
    const one = { ...t, out: (l = "") => { t.out(l); halt.abort(); } };
    expect(await top(["--watch", "--json"], one, halt.signal, 1)).toBe(0);
    expect(t.lines).toEqual(['{"schemaVersion":1,"running":false}']);
  });

  it("mcp log --json and resolve --json stay one record per line", async () => {
    sb.write(".local/state/turno/logs/calls.jsonl", '{"time":"2026-11-17T10:00:00Z","server":"gh","tool":"t","durationMs":3,"outcome":"ok"}\nnot json\n');
    const log = await run(["mcp", "log", "--json"]);
    expect(log.out.split("\n")).toHaveLength(1);
    expect(JSON.parse(log.out)).toMatchObject({ schemaVersion: 1, server: "gh", tool: "t" });
    const r = await run(["resolve", sb.home, "--json"]);
    expect(r.out.split("\n")).toHaveLength(1);
    expect(JSON.parse(r.out)).toMatchObject({ schemaVersion: 1, chosen: "", reason: expect.any(String) });
  });

  it("every --json subcommand declares its fields (so --json=fields can answer)", async () => {
    const missing: string[] = [];
    for (const name of [...visibleCommands(), "resolve"]) {
      const { command } = await COMMANDS[name]!();
      if (command.subcommands) {
        for (const [sub, c] of Object.entries(command.subcommands)) {
          // config get prints a config value as config.toml holds it: the one exception.
          if (!c.flags?.includes("--json") || `${name} ${sub}` === "config get") continue;
          const r = await run([name, sub, "--json=fields"]);
          if (r.code !== 0 || !r.out.startsWith("Fields for --json")) missing.push(`${name} ${sub}`);
        }
      } else if (command.flags?.includes("--json") && !command.json) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});

describe("exit codes", () => {
  it("have stable names", () => {
    expect([0, 1, 2, 3, 4, 5, 127, 130].map(exitName)).toEqual(["ok", "failure", "usage", "no_profile", "not_signed_in", "gateway_down", "not_installed", "cancelled"]);
    expect(exitName(42)).toBe("failure");
  });

  it("turno auto exits 3 when the folder's profile does not exist", async () => {
    sb.write(".config/turno/config.toml", `[profiles.work]\n\n[[projects]]\npath = "${sb.home}"\nprofile = "ghost"\n`);
    const { planAuto } = await import("../src/cli/commands/auto.js");
    try {
      planAuto([], fakeIo(sb.env), sb.home);
      expect.unreachable();
    } catch (err) {
      expect((err as { code: number }).code).toBe(Exit.noProfile);
    }
    sb.write(".config/turno/config.toml", 'system = ""\n[profiles.work]\n');
    expect(() => planAuto([], fakeIo(sb.env), sb.home)).toThrow(expect.objectContaining({ code: Exit.noProfile }));
  });

  it("profile which --check: 0 ready, 3 without a profile, 4 not signed in, quiet on success", async () => {
    const dir = join(sb.home, "code");
    mkdirSync(dir);
    let r = await run(["profile", "which", dir, "--check"]);
    expect(r.code).toBe(Exit.noProfile);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^turno: ~\/code has no Claude Code profile .*turno profile assign ~\/code <profile>/);

    sb.write(".config/turno/config.toml", `[profiles.work]\n\n[[projects]]\npath = "~/code"\nprofile = "work"\n`);
    r = await run(["profile", "which", dir, "--check"]);
    expect(r.code).toBe(Exit.ok);
    expect(r.out + r.err).toBe("");

    sb.write(".config/turno/config.toml", `[profiles.work]\n\n[[projects]]\npath = "~/code"\nprofile = "gone"\n`);
    expect((await run(["profile", "which", dir, "--check"])).code).toBe(Exit.noProfile);

    sb.write(".config/turno/config.toml", `[profiles.work]\n\n[[projects]]\npath = "~/code"\nprofile = "work"\n`);
    fakeCommand(sb, "claude", `echo '{"loggedIn":false}'`);
    sb.write(".claude-work/.claude.json", "{}");
    r = await run(["profile", "which", dir, "--check", "--json"]);
    expect(r.code).toBe(Exit.notSignedIn);
    expect(JSON.parse(r.out).check).toEqual({ ok: false, code: "not_signed_in", exitCode: 4, message: "work is not signed in: run claude-work, then /login" });
    expect((await run(["profile", "which", dir, "--agent", "codex"])).code).toBe(Exit.usage);
  });
});

describe("help topics", () => {
  it("turno help exit-codes lists every code", async () => {
    const r = await run(["help", "exit-codes"]);
    expect(r.code).toBe(0);
    for (const n of ["0  ok", "1  failure", "2  usage", "3  no_profile", "4  not_signed_in", "5  gateway_down"]) expect(r.out).toContain(n);
    expect(r.out).toContain("Examples:");
  });

  it("turno help json and environment exist, and turno help names the topics", async () => {
    expect((await run(["help", "json"])).out).toContain("--json=fields");
    const env = (await run(["help", "environment"])).out;
    for (const v of ["NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "DO_NOT_TRACK", "CI", "TERM", "TURNO_NO_UPDATE_NOTIFIER"]) expect(env).toContain(v);
    expect((await run(["help"])).out).toContain("turno help exit-codes");
  });
});

describe("colors from the environment", () => {
  const tty = (env: NodeJS.ProcessEnv) => colors({ env, isTty: true });
  const pipe = (env: NodeJS.ProcessEnv) => colors({ env, isTty: false });
  it("CLICOLOR=0 and TERM=dumb turn them off, CLICOLOR_FORCE turns them on; NO_COLOR and FORCE_COLOR come first", () => {
    expect(tty({})).toBe(true);
    expect(tty({ CLICOLOR: "0" })).toBe(false);
    expect(tty({ CLICOLOR: "1" })).toBe(true);
    expect(tty({ TERM: "dumb" })).toBe(false);
    expect(pipe({ CLICOLOR_FORCE: "1" })).toBe(true);
    expect(pipe({ CLICOLOR_FORCE: "0" })).toBe(false);
    expect(tty({ CLICOLOR_FORCE: "1", TERM: "dumb" })).toBe(true);
    expect(pipe({ CLICOLOR_FORCE: "1", NO_COLOR: "1" })).toBe(false);
    expect(tty({ FORCE_COLOR: "0", CLICOLOR_FORCE: "1" })).toBe(false);
    expect(pipe({ TERM: "dumb", FORCE_COLOR: "1" })).toBe(true);
    expect(colors({ env: { TERM: "dumb" }, isTty: true, color: "always" })).toBe(true);
  });
});

describe("help that ends with examples, and every variable named", () => {
  it("every visible command and subcommand help ends with Examples:", async () => {
    const missing: string[] = [];
    const examples = (text: string) => {
      const i = text.lastIndexOf("\nExamples:\n");
      return i >= 0 && text.slice(i).split("\n").slice(2).every((l) => l.startsWith("  $ turno ") || l.startsWith("  $ ") || l === "");
    };
    for (const name of visibleCommands()) {
      const { command } = await COMMANDS[name]!();
      const top = await run([name, "--help"]);
      if (!examples(top.out)) missing.push(name);
      for (const sub of Object.keys(command.subcommands ?? {})) {
        const r = await run([name, sub, "--help"]);
        if (!examples(r.out)) missing.push(`${name} ${sub}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("turno help environment names every TURNO_ variable in the source", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const root = join(__dirname, "..", "..");
    const used = new Set<string>();
    for (const f of [...files(join(root, "turno/src")), ...files(join(root, "browser/src"))]) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bTURNO_[A-Z0-9_]+\b/g)) used.add(m[0]);
    }
    // Identifiers, not environment variables.
    used.delete("TURNO_TOOLS");
    const text = (await run(["help", "environment"])).out;
    expect([...used].filter((v) => !text.includes(v)).sort()).toEqual([]);
  });
});
