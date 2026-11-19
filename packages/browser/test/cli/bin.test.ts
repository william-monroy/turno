import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeSecretStore, fakeSecretStore } from "../helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "../helpers/sandbox.js";

/**
 * The `turno-browser` program, run from dist/ in a throwaway HOME: the identity commands without
 * turno-cli. The secret store is the file-backed fake, and no command here starts Chrome.
 */

const BIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
  bin: Record<string, string>;
};

let sb: Sandbox;
let store: FakeSecretStore;
beforeEach(() => {
  sb = sandbox();
  store = fakeSecretStore(sb);
});
afterEach(() => sb.cleanup());

function run(args: string[], input = "") {
  return runWith(args, {}, input);
}

function runWith(args: string[], extra: NodeJS.ProcessEnv, input = "") {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...sb.env, TURNO_NO_INPUT: "1", ...extra },
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A PATH where turno-browser-mcp is found: a stand-in in the sandbox. */
function onPath(): NodeJS.ProcessEnv {
  const dir = join(sb.home, "mcpbin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "turno-browser-mcp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { PATH: `${dir}:${sb.env.PATH ?? ""}` };
}

/** Every file under `dir`, for "writes nothing". */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !f.includes("/mcpbin/"))
    .sort();
}

const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);

describe("turno-browser", () => {
  it("is a bin of the package, and prints its version and its help by section", () => {
    expect(PKG.bin["turno-browser"]).toBe("dist/cli/main.js");
    expect(run(["--version"])).toMatchObject({ code: 0, out: `turno-browser ${PKG.version}\n` });
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    for (const section of ["Identities", "Connect an agent", "Sign-ins and sessions", "Flows and recordings", "Checks"])
      expect(help.out).toContain(section);
    expect(help.out).toMatch(/^ {2}add +create an identity/m);
    expect(help.out).toContain("turno-browser-mcp --identity <id>");
    expect(help.out).not.toMatch(/detector|fingerprint|patchright/i);
    expect(run([]).out).toBe(help.out);
    expect(run(["help", "add"]).out).toContain("turno-browser add <id>");
  });

  it("adds an identity and prints how to connect an agent instead of an mcp.toml block", () => {
    const r = run(["add", "school", "--languages", "es-MX,es,en"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/identity "school" ready at ~\/\.local\/share\/turno\/browser\/identities\/school/);
    expect(r.out).toContain("turno-browser setup claude-code --identity school");
    expect(r.out).toContain("turno-browser-mcp --identity school");
    expect(r.out).toContain("turno-browser login school");
    expect(r.out).not.toMatch(/mcp\.toml|turno mcp sync|turno identity/);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).languages).toEqual(["es-MX", "es", "en"]);
  });

  it("lists identities, as text and as JSON", () => {
    expect(run(["list"]).out).toMatch(/No browser identities yet\. Create one with `turno-browser add <id>`\./);
    run(["add", "school"]);
    const text = run(["list"]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^school +free/m);
    expect(JSON.parse(run(["list", "--json"]).out)).toEqual([
      { schemaVersion: 1, id: "school", inUse: false, dir: "~/.local/share/turno/browser/identities/school" },
    ]);
  });

  it("sets and shows identity.json, with turno-browser in its hints", () => {
    run(["add", "school"]);
    const set = run(["set", "school", "--timezone", "Europe/Madrid", "--sharing", "tabs"]);
    expect(set.code).toBe(0);
    expect(set.out).toMatch(/updated identity\.json of "school"/);
    // On its own there is no mcp.toml to change after --sharing.
    expect(set.out).not.toMatch(/mcp\.toml|turno mcp sync/);
    const show = run(["show", "school", "--json"]);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out).settings).toMatchObject({ timezone: "Europe/Madrid", sharing: "tabs" });
    expect(run(["show", "nobody"])).toMatchObject({ code: 2 });
    expect(run(["show", "nobody"]).err).toBe(
      'turno-browser: identity "nobody" does not exist (turno-browser add nobody)\n',
    );
    expect(run(["set", "--help"]).out).toContain("(turno-browser doctor says how)");
  });

  it("lists a vault without its values", () => {
    run(["add", "school"]);
    const add = run(
      ["vault", "add", "school", "mail", "--url", "https://mail.example.com", "--username", "alice@example.com"],
      "hunter2-correct-horse\n",
    );
    expect(add.code).toBe(0);
    expect(add.out).not.toContain("hunter2");
    const list = run(["vault", "list", "school"]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/^mail +password +https:\/\/mail\.example\.com$/m);
    expect(list.out).toContain("turno-browser vault submit school auto|confirm");
    expect(list.out).not.toContain("hunter2");
  });

  it("runs the doctor without starting Chrome", () => {
    run(["add", "school"]);
    const r = run(["doctor", "--no-launch", "--json"]);
    expect([0, 1]).toContain(r.code);
    const report = JSON.parse(r.out) as { ok: boolean; checks: { area: string }[] };
    expect(report.checks.some((c) => c.area === "identity school")).toBe(true);
  });

  it("runs do through the identity's background server, and prints its help", () => {
    run(["add", "school"]);
    const session = run(["do", "school", "session"]);
    expect(session.code).toBe(0);
    expect(session.out).toContain("server: not running; the next action starts it");
    expect(session.out).toContain("state: none yet; the next action opens it");
    expect(run(["do", "school", "end"])).toMatchObject({ code: 0, out: "no session default of school to end\n" });
    const missing = run(["do", "nobody", "open", "https://example.com"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toBe('turno-browser: browser identity "nobody" does not exist (turno-browser add nobody)\n');
    const help = run(["do", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("turno-browser do <id> <action>");
    expect(help.out).toContain("through its background server");
    expect(help.out).not.toContain("--profile");
  });

  it("shows, starts and stops background servers by name", () => {
    run(["add", "school"]);
    expect(run(["background"])).toMatchObject({
      code: 0,
      out: "No background server runs. turno-browser do <id> <action> starts one.\n",
    });
    expect(JSON.parse(run(["background", "status", "--json"]).out)).toEqual([]);
    expect(run(["background", "stop", "school"])).toMatchObject({
      code: 0,
      out: 'no background server of "school" runs\n',
    });
    expect(run(["background", "start", "nobody"]).code).toBe(2);
    expect(run(["background", "--help"]).out).toContain("turno-browser background stop <id>");
  });

  it("prints the MCP config of each agent, and writes nothing", () => {
    run(["add", "school"]);
    const before = files(sb.home);
    const claude = runWith(["setup", "claude-code", "--identity", "school"], onPath());
    expect(claude.code).toBe(0);
    expect(claude.out).toBe(
      [
        'Run this once to give Claude Code the browser identity "school":',
        "",
        "claude mcp add --scope user browser-school -- turno-browser-mcp --identity school",
        "",
        "--scope user adds it to every project; leave it out to add it to the current folder only.",
        "Start a new agent session to load it. Sign in to your sites once with turno-browser login school.",
        "",
      ].join("\n"),
    );
    const codex = runWith(["setup", "codex"], onPath());
    expect(codex.out).toContain(
      '[mcp_servers.browser-school]\ncommand = "turno-browser-mcp"\nargs = ["--identity", "school"]\n',
    );
    expect(codex.out).toContain("Or run: codex mcp add browser-school -- turno-browser-mcp --identity school");
    for (const [agent, entry] of [
      ["cursor", { type: "stdio", command: "turno-browser-mcp", args: ["--identity", "school"] }],
      ["copilot", { type: "local", command: "turno-browser-mcp", args: ["--identity", "school"], tools: ["*"] }],
      ["gemini", { command: "turno-browser-mcp", args: ["--identity", "school"] }],
      ["json", { command: "turno-browser-mcp", args: ["--identity", "school"] }],
    ] as const) {
      const r = runWith(["setup", agent, "--json"], onPath());
      expect(r.code).toBe(0);
      const out = JSON.parse(r.out) as { config: string; server: string };
      expect(out.server).toBe("browser-school");
      expect(JSON.parse(out.config)).toEqual({ mcpServers: { "browser-school": entry } });
    }
    // Not on the PATH: the full path of this install's server.
    const full = runWith(["setup", "json", "--json"], { PATH: dirname(process.execPath) });
    expect(JSON.parse(full.out)).toMatchObject({
      command: fileURLToPath(new URL("../../dist/bin/mcp.js", import.meta.url)),
      notes: expect.arrayContaining([expect.stringMatching(/not on the PATH/)]),
    });
    expect(files(sb.home)).toEqual(before);
  });

  it("refuses setup without an agent it knows or an identity to pick", () => {
    expect(run(["setup", "claude-code"])).toMatchObject({
      code: 2,
      err: "turno-browser: no identity yet: create one with turno-browser add <id>, then turno-browser setup <agent> --identity <id>\n",
    });
    run(["add", "school"]);
    run(["add", "work"]);
    expect(run(["setup", "codex"]).err).toBe("turno-browser: pick an identity with --identity: school, work\n");
    expect(run(["setup", "vim", "--identity", "school"]).err).toBe(
      'turno-browser: unknown agent "vim" (agents: claude-code, codex, cursor, copilot, gemini, json)\n',
    );
    expect(run(["setup", "codex", "--identity", "nobody"])).toMatchObject({ code: 2 });
  });

  it("stores, checks, lists and removes the secrets identity.json names, never printing them", () => {
    run(["add", "school"]);
    run([
      "set",
      "school",
      "--proxy-server",
      "http://proxy.example.com:8080",
      "--proxy-username",
      "alice",
      "--proxy-password",
      "keychain:school-proxy",
    ]);
    const missing = run(["secret", "list"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(
      /^MISSING {2}keychain:school-proxy {2}\(school\) {2}turno-browser secret set school-proxy$/m,
    );
    const set = run(["secret", "set", "school-proxy"], "correct-horse-battery");
    expect(set).toMatchObject({ code: 0, out: "stored keychain:school-proxy\n" });
    expect(store.read("school-proxy")).toBe("correct-horse-battery");
    expect(run(["secret", "has", "school-proxy"]).code).toBe(0);
    const list = run(["secret", "list", "--json"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out)).toEqual([
      { schemaVersion: 1, item: "school-proxy", stored: true, identities: ["school"] },
    ]);
    expect(list.out + set.out).not.toContain("correct-horse");
    expect(run(["secret", "remove", "school-proxy"])).toMatchObject({
      code: 0,
      out: "removed keychain:school-proxy\n",
    });
    expect(run(["secret", "has", "school-proxy"]).code).toBe(1);
    expect(run(["secret", "set", "empty"], "").code).toBe(2);
  });

  it("reports usage errors with exit 2, as text or JSON", () => {
    expect(run(["add"])).toMatchObject({
      code: 2,
      err: "turno-browser: add needs an identity id (for example: turno-browser add school)\n",
    });
    const json = run(["show", "nobody", "--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.err).error).toMatchObject({ code: "usage", exitCode: 2 });
    expect(run(["nope"]).code).toBe(2);
    expect(run(["--color", "pink", "list"]).code).toBe(2);
    expect(existsSync(join(sb.home, ".config", "turno"))).toBe(false);
  });
});
