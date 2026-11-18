import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "../src/accounts/audit.js";
import { command as accounts } from "../src/cli/commands/accounts.js";
import { doctor } from "../src/cli/commands/doctor.js";
import { command as identity } from "../src/cli/commands/identity.js";
import { inflightText } from "../src/cli/commands/mcpd.js";
import { renderUsage } from "../src/cli/commands/usage.js";
import { main } from "../src/cli/main.js";
import { isExactNpmSpec, scanPermissions } from "../src/cli/security.js";
import { parseConfig, parseSize } from "../src/core/config.js";
import { markExhausted } from "../src/core/exhausted.js";
import { parseManifest } from "../src/core/manifest.js";
import { paths, resetPrivateDirCache, writePrivateFile } from "../src/core/paths.js";
import { SecretError, expandVars, keychainResolver } from "../src/core/secrets.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector, RotatingLog } from "../src/mcpd/connectors.js";
import { type RunningDaemon, createLogger, startDaemon } from "../src/mcpd/daemon.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { writeManaged } from "../src/mcpd/sync.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));
/** Shaped like real tokens so the secret detection fires; none of them is real. */
const GH = "ghp_FAKEfakeFAKEfakeFAKEfake0123456789";
const SK = "sk-FAKEfakeFAKEfakeFAKE0123";

let sb: Sandbox;
let servers: Server[] = [];
let daemons: RunningDaemon[] = [];

beforeEach(() => {
  sb = sandbox();
  servers = [];
  daemons = [];
  resetPrivateDirCache();
});
afterEach(async () => {
  for (const d of daemons) await d.stop().catch(() => {});
  for (const s of servers) s.close();
  sb.cleanup();
});

const mode = (p: string) => statSync(p).mode & 0o777;
const cfg = (rel: string) => join(sb.home, ".config/turno", rel);
const state = (rel: string) => join(sb.home, ".local/state/turno", rel);

/** An HTTP server on a free loopback port; `handler` answers every request. */
function listen(handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, r) => r.end()): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** A port nothing listens on (bound once, then released). */
async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((r) => servers.pop()!.close(r));
  return port;
}

async function security(env = sb.env, fix = false): Promise<{ code: number; lines: string[] }> {
  const io = fakeIo(env);
  const code = await doctor(io, { security: true, fix });
  return { code, lines: io.lines };
}

describe("turno doctor --security", () => {
  beforeEach(async () => {
    // The port check must not meet a real mcpd: point it at a port nobody holds.
    sb.write(".config/turno/config.toml", `[mcpd]\nport = ${await freePort()}\n`);
  });

  it("reports items other users can read under turno's folders and --fix narrows them", async () => {
    sb.write(".local/state/turno/usage/work.json", "{}", 0o644);
    chmodSync(state("usage"), 0o755);
    const before = await security();
    const line = before.lines.find((l) => l.includes("permissions:"))!;
    expect(line).toMatch(/^ {2}! +permissions:/);
    expect(line).toContain("~/.local/state/turno/usage/work.json");
    expect(before.lines.join("\n")).toContain("turno doctor --security --fix");

    const after = await security(sb.env, true);
    expect(after.lines.join("\n")).toContain("narrowed");
    expect(mode(state("usage/work.json"))).toBe(0o600);
    expect(mode(state("usage"))).toBe(0o700);
    expect(after.lines.find((l) => l.includes("permissions:"))).toMatch(/^ {2}ok .*only you can read/);
  });

  it("fails when other users can write into turno's folders, and skips npm installs", async () => {
    sb.write(".local/share/turno/servers/fx/node_modules/pkg/index.js", "", 0o644);
    mkdirSync(cfg(""), { recursive: true });
    chmodSync(cfg(""), 0o777);
    const { code, lines } = await security();
    expect(code).toBe(1);
    expect(lines.find((l) => l.includes("permissions:"))).toMatch(
      /^ {2}x +permissions: .*can be changed by other users: ~\/\.config\/turno/,
    );
    expect(scanPermissions(sb.env).wide.map((f) => f.path)).not.toContain(
      join(sb.home, ".local/share/turno/servers/fx/node_modules/pkg/index.js"),
    );
  });

  it("finds literal secrets in mcp.toml, agent configs and backups, never printing them", async () => {
    sb.write(
      ".config/turno/mcp.toml",
      `[server.gh]\ncommand = "gh-mcp"\nenv = { GITHUB_TOKEN = "${GH}", LOG = "info" }\n`,
      0o600,
    );
    sb.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          linear: { type: "http", url: "https://mcp.example.com/sse", headers: { Authorization: `Bearer ${SK}` } },
          fx: {
            type: "http",
            url: "http://127.0.0.1:47821/mcp/fx",
            headers: { Authorization: "Bearer 0123456789abcdef0123456789abcdef", "X-Turno-Profile": "work" },
          },
          fine: { command: "x", env: { API_KEY: "env:API_KEY" } },
        },
      }),
    );
    sb.write(
      ".local/state/turno/backups/20261101-120000/files/0-.claude.json",
      JSON.stringify({ mcpServers: { gh: { command: "x", args: [`--token=${GH}`] } } }),
      0o600,
    );
    const { lines } = await security();
    const text = lines.join("\n");
    expect(text).toContain("literal secrets in ~/.config/turno/mcp.toml: gh.env.GITHUB_TOKEN");
    expect(text).toContain("literal secrets in ~/.claude.json: linear.headers.Authorization");
    expect(text).not.toContain("fx.headers"); // a gateway entry: its token is the gateway's
    expect(text).not.toContain("fine.env");
    expect(text).toMatch(/1 backup in .* hold configs with literal secrets \(oldest 20261101-120000\)/);
    expect(text).not.toContain(GH);
    expect(text).not.toContain(SK);
  });

  it("flags MCP servers that do not run an exact version", async () => {
    sb.write(
      ".config/turno/mcp.toml",
      [
        '[server.loose]\ncommand = "loose-mcp"\npackage = "loose-mcp@^1.2.0"',
        '[server.npx]\ncommand = "npx"\nargs = ["-y", "@scope/fresh-mcp"]',
        '[server.pinned]\ncommand = "npx"\nargs = ["-y", "@scope/pinned-mcp@1.2.3"]',
        '[server.uv]\ncommand = "uvx"\nargs = ["py-mcp==0.4.1"]',
        '[server.fixed]\ncommand = "fixed-mcp"\npackage = "fixed-mcp@2.0.0"',
      ].join("\n"),
      0o600,
    );
    const text = (await security()).lines.join("\n");
    expect(text).toContain("loose (package loose-mcp@^1.2.0)");
    expect(text).toContain(
      "manual: write an exact version (pkg@1.2.3) in each command in mcp.toml; turno mcp install loose pins the npm packages",
    );
    expect(text).toContain("npx (npx @scope/fresh-mcp fetches the newest version at each start)");
    expect(text).not.toMatch(/pinned \(|uv \(/);
    expect(text).toContain("pinned but not installed, so npx downloads them at each start: fixed");
    expect(isExactNpmSpec("@scope/pkg@1.2.3")).toBe(true);
    expect(isExactNpmSpec("@scope/pkg")).toBe(false);
    expect(isExactNpmSpec("pkg@latest")).toBe(false);
  });

  it("warns about an old mcpd token", async () => {
    const file = sb.write(".local/state/turno/mcpd.token", `${"a".repeat(64)}\n`, 0o600);
    expect((await security()).lines.join("\n")).toMatch(/ok +the mcpd token is 0 days old/);
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    expect((await security()).lines.join("\n")).toMatch(
      /! +the mcpd token is 120 days old .*\n +fix: turno mcp token rotate && turno mcp sync$/m,
    );
  });

  it("checks the audit log's hash chain", async () => {
    for (const task of ["one", "two", "three"]) {
      appendAudit(
        {
          caller: { profile: "work", pid: 1 },
          account: "linear:work",
          owner: "work",
          write: false,
          task,
          outcome: "ok",
          detail: "",
          durationMs: 1,
          costUsd: null,
        },
        sb.env,
      );
    }
    expect((await security()).lines.join("\n")).toMatch(/ok +audit log: hash chain intact \(3 lines\)/);
    const file = paths(sb.env).auditLog;
    writeFileSync(file, readFileSync(file, "utf8").replace('"two"', '"TWO"'));
    const { code, lines } = await security();
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(
      /x +audit log: line 3: hash does not match.*\n +manual: .*turno identity log --verify shows the line/,
    );
  });

  it("names a port holder that is not mcpd", async () => {
    const port = await listen((_q, r) => {
      r.statusCode = 404;
      r.end();
    });
    sb.write(".config/turno/config.toml", `[mcpd]\nport = ${port}\n`);
    const line = (await security()).lines.find((l) => l.includes(`mcpd port ${port}`))!;
    // lsof (macOS) or /proc (Linux) names the holder; without either the port reads as free.
    expect(line).toMatch(/does not answer as mcpd|nothing listens/);
  });

  it("shows the secret store, and fails when keychain: references have none", async () => {
    fakeCommand(sb, "security", "exit 44");
    fakeCommand(sb, "secret-tool", "exit 1");
    expect((await security()).lines.join("\n")).toMatch(
      /ok +secret store: (macOS Keychain \(security\)|Secret Service \(secret-tool\))/,
    );
    const doctorIo = fakeIo(sb.env);
    await doctor(doctorIo);
    expect(doctorIo.lines.join("\n")).toMatch(/secret store: (macOS Keychain|Secret Service)/);

    sb.write(
      ".config/turno/mcp.toml",
      '[server.gh]\ncommand = "gh-mcp"\nenv = { GITHUB_TOKEN = "keychain:gh" }\n',
      0o600,
    );
    const bare = { ...sb.env, PATH: join(sb.home, "nothing") };
    const { code, lines } = await security(bare);
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(
      /x +secret store: none found .*keychain: references that cannot resolve\n +manual: install secret-tool/,
    );
  });

  it("prints JSON with --json", async () => {
    const io = fakeIo(sb.env);
    await doctor(io, { security: true, json: true });
    const out = JSON.parse(io.lines.join("\n")) as { ok: boolean; checks: { area: string }[] };
    expect(out.checks.length).toBeGreaterThan(0);
    expect(out.checks.every((c) => c.area === "security")).toBe(true);
  });
});

describe("audit log verify", () => {
  const entry = (task: string) => ({
    caller: { profile: "work", pid: 1 },
    account: "linear:work",
    owner: "work",
    write: false,
    task,
    outcome: "ok" as const,
    detail: "",
    durationMs: 1,
    costUsd: null,
  });

  it("identity log --verify and accounts log --verify check the chain", async () => {
    appendAudit(entry("one"), sb.env);
    appendAudit(entry("two"), sb.env);
    let io = fakeIo(sb.env);
    expect(await identity.run(["log", "--verify"], io)).toBe(0);
    expect(io.lines.join("\n")).toMatch(/ok +~\/\.local\/state\/turno\/audit\.jsonl: 2 lines, hash chain intact/);

    const file = paths(sb.env).auditLog;
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, `${[lines[1], lines[0]].join("\n")}\n`);
    io = fakeIo(sb.env);
    expect(await accounts.run(["log", "--verify"], io)).toBe(1);
    expect(io.lines[0]).toMatch(
      /broken +~\/\.local\/state\/turno\/audit\.jsonl: line 1: first line does not start the chain/,
    );

    io = fakeIo(sb.env);
    expect(await identity.run(["log", "--verify", "--json"], io)).toBe(1);
    expect(JSON.parse(io.lines.join("\n"))).toMatchObject({ ok: false, line: 1, lines: 1 });
  });

  it("says so when there is no log yet, and log --json lists entries", async () => {
    let io = fakeIo(sb.env);
    expect(await identity.run(["log", "--verify"], io)).toBe(0);
    expect(io.lines[0]).toContain("No delegations recorded yet");
    appendAudit(entry("one"), sb.env);
    io = fakeIo(sb.env);
    expect(await identity.run(["log", "--json"], io)).toBe(0);
    expect(JSON.parse(io.lines.join("\n"))).toMatchObject([{ task: "one", account: "linear:work" }]);
  });
});

describe("${VAR} expansion in mcpd", () => {
  it("expands variables inside strings, with defaults, and refuses unset ones", () => {
    const env = { HOST: "example.com", EMPTY: "" };
    expect(expandVars("https://${HOST}/v1", env)).toBe("https://example.com/v1");
    expect(expandVars("--host=${env:HOST}", env)).toBe("--host=example.com");
    expect(expandVars("${EMPTY:-fallback}/${MISSING:-x}", env)).toBe("fallback/x");
    expect(expandVars("${workspaceFolder}/a $HOST", env)).toBe("${workspaceFolder}/a $HOST");
    expect(() => expandVars("Bearer ${MISSING}", env)).toThrow(SecretError);
    expect(() => expandVars("Bearer ${MISSING}", env)).toThrow("environment variable MISSING is not set");
  });

  it("the resolver keeps whole references and expands the rest", async () => {
    const resolve = keychainResolver({ TOKEN: "t0k", PATH: "" }, "linux");
    expect(await resolve("env:TOKEN")).toBe("t0k");
    expect(await resolve("Bearer ${TOKEN}")).toBe("Bearer t0k");
    expect(await resolve("plain")).toBe("plain");
  });

  it("expands ${VAR} in a stdio server's args and env values", async () => {
    const m = parseManifest(
      `[server.fx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}, "--region=\${REGION}"]\nenv = { URL = "https://\${HOST}/x" }\n`,
    );
    const vars = { REGION: "eu", HOST: "example.com" };
    const connector = new DefaultConnector({
      resolve: keychainResolver(vars, "linux"),
      serversDir: join(sb.home, "servers"),
      logsDir: join(sb.home, "logs"),
      vars,
    });
    const { transport } = await connector.connect(m.servers.fx!, "default", { sessionId: "s" } as never, sb.home);
    const params = (transport as unknown as { _serverParams: { args: string[]; env: Record<string, string> } })
      ._serverParams;
    expect(params.args).toEqual([FIXTURE, "--region=eu"]);
    expect(params.env.URL).toBe("https://example.com/x");
  });
});

describe("one-line errors", () => {
  it("prints a SecretError without a stack trace", async () => {
    sb.write(".claude.json", JSON.stringify({ mcpServers: { gh: { command: "gh-mcp", env: { GITHUB_TOKEN: GH } } } }));
    const io = fakeIo({ ...sb.env, PATH: join(sb.home, "nothing") });
    const code = await main(["mcp", "import", "--write", "--move-secrets"], io);
    expect(code).toBe(1);
    const err = io.errors.join("\n");
    expect(err).toContain("turno: no secret store found");
    expect(err).not.toMatch(/\n\s+at /);
    expect(err).not.toContain(GH);
  });
});

describe("private modes where turno writes its own state", () => {
  it("exhausted marks, state files, managed lists, caches and logs are 0600 in 0700 folders", async () => {
    markExhausted("work", Date.now() / 1000 + 60, sb.env);
    expect(mode(state("exhausted/work"))).toBe(0o600);
    expect(mode(state("exhausted"))).toBe(0o700);
    expect(mode(state(""))).toBe(0o700);

    const old = sb.write(".local/state/turno/version", "0.1.0\n", 0o644);
    writePrivateFile(old, "0.2.0\n", sb.env);
    expect(mode(old)).toBe(0o600);

    writeManaged(state("mcp-managed.json"), {});
    expect(mode(state("mcp-managed.json"))).toBe(0o600);

    new DescriptionCache(join(sb.home, ".local/share/turno/mcpd/cache")).set("fx@default", { tools: [] } as never);
    expect(mode(join(sb.home, ".local/share/turno/mcpd/cache/fx@default.json"))).toBe(0o600);

    const logFile = sb.write(".local/state/turno/logs/fx.log", "old\n", 0o644);
    const rotating = new RotatingLog(logFile);
    rotating.write("line\n");
    rotating.end();
    expect(mode(logFile)).toBe(0o600);

    const mcpdLog = createLogger(state("logs/mcpd.log"), { env: sb.env });
    mcpdLog("hello");
    await mcpdLog.close();
    expect(mode(state("logs/mcpd.log"))).toBe(0o600);
  });

  it("mcpd writes its port file and start errors 0600", async () => {
    const d = await startDaemon({ env: sb.env, port: 0 });
    daemons.push(d);
    expect(mode(state("mcpd.port"))).toBe(0o600);
    await d.stop();
    const port = await listen();
    await startDaemon({ env: sb.env, port }).catch(() => undefined);
    expect(mode(state("mcpd.error.json"))).toBe(0o600);
  });
});

describe("[mcpd] max_request_body", () => {
  it("parses sizes and refuses out of range values", () => {
    expect(parseSize("64MiB")).toBe(64 * 1024 * 1024);
    expect(parseSize("1 GB")).toBe(1e9);
    expect(parseSize(2_000_000)).toBe(2_000_000);
    expect(parseSize("lots")).toBeUndefined();
    expect(parseConfig('[mcpd]\nmax_request_body = "8MiB"\n', "config.toml").mcpd.maxRequestBody).toBe(8 * 1024 * 1024);
  });

  it("is refused below 1 MiB and accepted by turno config set", async () => {
    expect(() => parseConfig("[mcpd]\nmax_request_body = 1024\n", "config.toml")).toThrow(/between 1MiB and 1GiB/);
    const io = fakeIo(sb.env);
    expect(await main(["config", "set", "mcpd.max_request_body", "64MiB"], io)).toBe(0);
    expect(readFileSync(cfg("config.toml"), "utf8")).toContain('max_request_body = "64MiB"');
    expect(await main(["config", "set", "mcpd.max_request_body", "10"], fakeIo(sb.env))).not.toBe(0);
  });

  it("reaches the gateway", async () => {
    sb.write(".config/turno/config.toml", '[mcpd]\nmax_request_body = "1MiB"\n');
    sb.write(
      ".config/turno/mcp.toml",
      `[server.fx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\n`,
    );
    const d = await startDaemon({ env: sb.env, port: 0 });
    daemons.push(d);
    const token = readFileSync(state("mcpd.token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${d.port}/mcp/fx`, {
      method: "POST",
      body: "x".repeat(2 * 1024 * 1024),
      // MCP sessions take a profile token (ADR 0023).
      headers: {
        authorization: `Bearer ${profileToken(token, "default")}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    });
    expect(res.status).toBe(413);
  });
});

describe("small fixes", () => {
  it("usage says why an account is unknown instead of ? · ?", () => {
    const io = fakeIo(sb.env);
    const text = renderUsage(["work"], { work: { email: "?", plan: "", why: "claude is not on PATH" } }, io);
    expect(text).toContain("work  account unknown (claude is not on PATH)");
    expect(text).not.toContain("? · ?");
  });

  it("daemon status shows calls in flight per client session", () => {
    expect(inflightText({ "1f2e3d4c-aaaa-bbbb-cccc-111111111111": 2, "9a8b7c6d-aaaa-bbbb-cccc-222222222222": 1 })).toBe(
      "3 calls in flight: 1f2e3d4c 2, 9a8b7c6d 1",
    );
    expect(inflightText({})).toBeUndefined();
  });
});

describe("talking to a running mcpd", () => {
  /** A fake mcpd: our token and port file, and canned answers by "METHOD /path". */
  async function fakeMcpd(answers: Record<string, unknown>): Promise<void> {
    const token = "f".repeat(64);
    const port = await listen((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end();
        return;
      }
      const body = answers[`${req.method} ${req.url}`];
      res.statusCode = body === undefined ? 404 : 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body ?? { error: "not found" }));
    });
    sb.write(".local/state/turno/mcpd.token", `${token}\n`, 0o600);
    sb.write(".local/state/turno/mcpd.port", `${port}\n`, 0o600);
  }

  it("mcp refresh reports the instances a 200 says failed", async () => {
    sb.write(".config/turno/mcp.toml", '[server.fx]\ncommand = "fx-mcp"\n', 0o600);
    await fakeMcpd({
      "POST /refresh/fx": {
        server: "fx",
        refreshed: ["fx@work"],
        forgotten: [],
        errors: { "fx@default": "relist failed: boom\nstack" },
      },
    });
    const io = fakeIo(sb.env);
    expect(await main(["mcp", "refresh", "fx"], io)).toBe(1);
    expect(io.errors).toContain("fx@default: mcpd could not refresh it: relist failed: boom");
    expect(io.lines.join("\n")).not.toContain("mcpd refreshed fx");
  });

  it("mcp daemon status counts sessions and clients in the singular and shows calls in flight", async () => {
    await fakeMcpd({
      "GET /status": {
        pid: process.pid,
        port: 1,
        sessions: 1,
        instances: [
          {
            server: "fx",
            variant: "default",
            pid: null,
            clients: 1,
            idleSeconds: 3,
            inflightByClient: { "abcdef12-0000-0000-0000-000000000000": 1 },
          },
        ],
      },
    });
    const io = fakeIo(sb.env);
    expect(await main(["mcp", "daemon", "status"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain("1 client session");
    expect(text).not.toContain("1 client sessions");
    expect(text).toMatch(/fx +default .* 1 client {2}idle 3s/);
    expect(text).toContain("1 call in flight: abcdef12 1");
  });

  it("turno status says why mcpd is down", async () => {
    sb.write(".config/turno/config.toml", `[mcpd]\nport = ${await freePort()}\n`);
    sb.write(
      ".local/state/turno/mcpd.error.json",
      JSON.stringify({ at: "2026-11-16T12:00:00.000Z", message: "port 47821 is in use by node (pid 42)" }),
      0o600,
    );
    const io = fakeIo(sb.env);
    expect(await main(["status"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain("not running (turno mcp daemon start)");
    expect(text).toMatch(/last start failed at .*: port 47821 is in use by node \(pid 42\)/);
    const json = fakeIo(sb.env);
    await main(["status", "--json"], json);
    expect((JSON.parse(json.lines.join("\n")) as { mcpd: { problems: string[] } }).mcpd.problems[0]).toContain(
      "last start failed",
    );
  });
});
