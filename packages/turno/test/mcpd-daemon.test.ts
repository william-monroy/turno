import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/main.js";
import { finishUpgrade } from "../src/cli/commands/upgrade.js";
import { localTime } from "../src/cli/commands/mcpd.js";
import { collectChecks } from "../src/cli/commands/doctor.js";
import { Journal } from "../src/core/journal.js";
import { fetchLatest, isSemver } from "../src/core/update.js";
import {
  AlreadyRunningError,
  PortBusyError,
  type RunningDaemon,
  createLogger,
  daemonFiles,
  installCrashGuards,
  loadConfigSafe,
  masterToken,
  mcpdPort,
  readStartError,
  readToken,
  rotateToken,
  startDaemon,
} from "../src/mcpd/daemon.js";
import { plist, plistProgram, plistPath } from "../src/mcpd/launchd.js";
import { peerPid, portOwner } from "../src/mcpd/peerpid.js";
import {
  ServiceError,
  chooseProgram,
  installService,
  removeService,
  runTool,
  serviceBackend,
} from "../src/mcpd/service.js";
import { systemd, unit, unitPath, unitProgram } from "../src/mcpd/systemd.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let daemons: RunningDaemon[] = [];
let servers: Server[] = [];
let calls: string;

const state = (rel: string) => join(sb.home, ".local/state/turno", rel);

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

async function start(port = 0): Promise<RunningDaemon> {
  const d = await startDaemon({ env: sb.env, port });
  daemons.push(d);
  return d;
}

async function statusOf(d: RunningDaemon): Promise<Record<string, unknown>> {
  const token = readFileSync(state("mcpd.token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${d.port}/status`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as Record<string, unknown>;
}

function callLog(): string[] {
  try {
    return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(() => {
  sb = sandbox();
  daemons = [];
  servers = [];
  calls = join(sb.home, "calls.log");
  // Never reach the real service managers: both answer "ok" and record their arguments.
  fakeCommand(sb, "launchctl", `echo "launchctl $*" >> "${calls}"`);
  fakeCommand(sb, "systemctl", `echo "systemctl $*" >> "${calls}"`);
});

afterEach(async () => {
  for (const d of daemons) await d.stop().catch(() => {});
  for (const s of servers) s.close();
  sb.cleanup();
});

describe("single instance and port policy", () => {
  it("refuses a second mcpd in the same home and cleans its lock and port file on stop", async () => {
    const d = await start();
    expect(JSON.parse(readFileSync(daemonFiles(sb.env).lock, "utf8"))).toMatchObject({
      pid: process.pid,
      port: d.port,
    });
    expect(mcpdPort(sb.env)).toBe(d.port);
    await expect(startDaemon({ env: sb.env, port: 0 })).rejects.toBeInstanceOf(AlreadyRunningError);
    await d.stop();
    expect(existsSync(daemonFiles(sb.env).lock)).toBe(false);
    expect(existsSync(state("mcpd.port"))).toBe(false);
  });

  it("fails loudly when the configured port is busy, names the owner and records why", async () => {
    const { port } = await listen();
    const err = await startDaemon({ env: sb.env, port }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PortBusyError);
    expect((err as Error).message).toContain(`port ${port} is in use by`);
    expect((err as Error).message).toContain("does not move to another port");
    expect(readStartError(sb.env)?.message).toContain(`port ${port}`);
    expect(existsSync(daemonFiles(sb.env).lock)).toBe(false);
    // A later good start clears the recorded error.
    await start();
    expect(readStartError(sb.env)).toBeUndefined();
  });

  it("names the owner of a busy port when the system can tell", async () => {
    const { port } = await listen();
    const owner = await portOwner(port, { env: sb.env });
    if (owner) expect(owner.pid).toBe(process.pid); // lsof or /proc available
  });

  it("recognizes an mcpd without a lock (an older version) on the port as already running", async () => {
    const d = await start();
    writeFileSync(daemonFiles(sb.env).lock, "not json");
    const err = await startDaemon({ env: sb.env, port: d.port }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as Error).message).toContain(`already running on port ${d.port}`);
  });

  it("ignores a port file left by a crash", () => {
    sb.write(".config/turno/config.toml", "[mcpd]\nport = 51234\n");
    sb.write(".local/state/turno/mcpd.port", "40000\n");
    expect(mcpdPort(sb.env)).toBe(40000); // no lock at all: an older mcpd, trusted
    sb.write(".local/state/turno/mcpd.lock", JSON.stringify({ pid: 999_999_99, port: 40000, startedAt: "x" }));
    expect(mcpdPort(sb.env)).toBe(51234);
  });
});

describe("manifest and config that do not validate", () => {
  const good = '[server.one]\ncommand = "echo"\n';

  it("starts with the last good mcp.toml, then with none, and says so in /status", async () => {
    sb.write(".config/turno/mcp.toml", good);
    await (await start()).stop();
    expect(readFileSync(daemonFiles(sb.env).lastGood, "utf8")).toBe(good);

    sb.write(".config/turno/mcp.toml", "[server.x]\ncommand = 1\n");
    const d = await start();
    const s = await statusOf(d);
    expect(s.manifest).toMatchObject({ source: "last good copy", servers: 1 });
    expect(String((s.manifest as { error: string }).error)).toContain("command");
    await d.stop();

    writeFileSync(daemonFiles(sb.env).lastGood, "not = [valid");
    const e = await start();
    expect((await statusOf(e)).manifest).toMatchObject({ source: "empty", servers: 0 });
  });

  it("keeps serving and remembers the error when a reload finds a broken file", async () => {
    sb.write(".config/turno/mcp.toml", good);
    const d = await start();
    sb.write(".config/turno/mcp.toml", "[server.x]\ncommand = 1\n");
    process.emit("SIGHUP", "SIGHUP");
    await vi.waitFor(async () =>
      expect(((await statusOf(d)).manifest as { error: string | null }).error).toContain("command"),
    );
    expect((await statusOf(d)).manifest).toMatchObject({ servers: 1 });
  });

  it("uses defaults for a broken config.toml but keeps its port when readable", () => {
    sb.write(".config/turno/config.toml", 'icons = "sparkles"\n[mcpd]\nport = 50123\n');
    const r = loadConfigSafe(sb.env);
    expect(r.error).toContain("icons");
    expect(r.config.mcpd.port).toBe(50123);
  });
});

describe("log and crash handling", () => {
  it("rotates mcpd.log by size and keeps a bounded number of old files", async () => {
    const file = join(sb.home, "logs", "mcpd.log");
    const log = createLogger(file, { maxBytes: 300, keep: 2 });
    for (let i = 0; i < 40; i++) log(`line ${i} ${"x".repeat(20)}`);
    await log.close();
    expect(statSync(file).size).toBeLessThanOrEqual(300);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("line 39");
  });

  it("survives a log file that cannot be written", async () => {
    sb.write("blocker", "a file where the log folder should be");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger(join(sb.home, "blocker", "mcpd.log"));
    expect(() => log("hello")).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(stderr.mock.calls.some((c) => String(c[0]).includes("cannot write"))).toBe(true);
    stderr.mockRestore();
  });

  it("logs recoverable exceptions and rejections and keeps running; exits 1 on others", async () => {
    const lines: string[] = [];
    const stop = vi.fn(async () => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const off = installCrashGuards((l) => lines.push(l), stop);
    try {
      process.emit("uncaughtException", Object.assign(new Error("pipe"), { code: "EPIPE" }), "uncaughtException");
      process.emit("unhandledRejection", new Error("nobody waited"), Promise.resolve());
      expect(stop).not.toHaveBeenCalled();
      expect(lines.join("\n")).toContain("uncaught EPIPE, still running");
      expect(lines.join("\n")).toContain("unhandled rejection, still running");
      process.emit("uncaughtException", new TypeError("bug"), "uncaughtException");
      expect(stop).toHaveBeenCalled();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally {
      off();
      exit.mockRestore();
    }
  });
});

describe("token", () => {
  it("fixes a token file readable by others and warns", () => {
    const file = sb.write(".local/state/turno/mcpd.token", `${"a".repeat(64)}\n`, 0o644);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    expect(masterToken(sb.env, "read", (m) => warnings.push(m))).toBe("a".repeat(64));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(warnings.join()).toContain("readable by others");
  });

  it("reads nothing when missing, creates on ensure, replaces on rotate, always mode 600", () => {
    expect(readToken(sb.env)).toBeUndefined();
    const t1 = masterToken(sb.env, "ensure")!;
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(masterToken(sb.env, "ensure")).toBe(t1);
    const t2 = rotateToken(sb.env);
    expect(t2).not.toBe(t1);
    expect(readToken(sb.env)).toBe(t2);
    expect(statSync(state("mcpd.token")).mode & 0o777).toBe(0o600);
  });
});

describe("peer and port owner on Linux", () => {
  function fakeProc(): string {
    const root = join(sb.home, "proc");
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    sb.write(
      "proc/net/tcp",
      header +
        "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999 1 0000000000000000 100 0 0 10 0\n" +
        "   1: 0100007F:C350 0100007F:BAAD 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 20 4 30 10 -1\n",
    );
    sb.write("proc/net/tcp6", header);
    for (const [pid, fd, inode] of [
      ["4242", "3", "12345"],
      ["77", "5", "999"],
    ] as const) {
      mkdirSync(join(root, pid, "fd"), { recursive: true });
      symlinkSync(`socket:[${inode}]`, join(root, pid, "fd", fd));
    }
    sb.write("proc/77/comm", "node\n");
    return root;
  }

  it("finds the client of a connection from /proc/net/tcp and /proc/<pid>/fd", async () => {
    const procRoot = fakeProc();
    expect(await peerPid(0xc350, 1, { platform: "linux", procRoot, env: { PATH: "" } })).toBe(4242);
    expect(await peerPid(0xc351, 1, { platform: "linux", procRoot, env: { PATH: "" } })).toBeUndefined();
  });

  it("finds who listens on a port", async () => {
    const procRoot = fakeProc();
    expect(await portOwner(8080, { platform: "linux", procRoot, env: { PATH: "" } })).toEqual({
      pid: 77,
      uid: 1000,
      command: "node",
    });
  });
});

describe("service files", () => {
  it("writes a LaunchAgent that is Interactive, restarts only after failures and runs `mcp daemon run`", () => {
    const text = plist({ program: ["/opt/x & y/turno"], env: sb.env });
    expect(text).toContain("<string>Interactive</string>");
    expect(text).not.toContain("Background");
    expect(text).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(text).toContain("<key>TURNO_MCPD_SERVICE</key>");
    expect(plistProgram(text)).toEqual(["/opt/x & y/turno", "mcp", "daemon", "run"]);
  });

  it("writes a systemd user unit with Restart=on-failure and quoted arguments", () => {
    const env = { ...sb.env, XDG_CONFIG_HOME: join(sb.home, "xdg") };
    expect(unitPath(env)).toBe(join(sb.home, "xdg", "systemd", "user", "turno-mcpd.service"));
    const text = unit({ program: ["/opt/my dir/node", "/srv/100%/$main.js"], env });
    expect(text).toContain("Restart=on-failure");
    expect(text).toContain("WantedBy=default.target");
    expect(unitProgram(text)).toEqual(["/opt/my dir/node", "/srv/100%/$main.js", "mcp", "daemon", "run"]);
  });

  it("prefers a stable turno on PATH, else a stable node, and warns about versioned paths", () => {
    const script = sb.write("lib/turno/dist/cli/main.js", "");
    const bin = join(sb.home, "stable-bin");
    mkdirSync(bin);
    symlinkSync(script, join(bin, "turno"));
    chmodSync(script, 0o755);
    expect(
      chooseProgram({ env: { PATH: bin }, execPath: "/x/.nvm/versions/node/v1/bin/node", script }).program,
    ).toEqual([join(bin, "turno")]);
    expect(chooseProgram({ env: { PATH: "" }, execPath: "/usr/bin/node", script })).toEqual({
      program: ["/usr/bin/node", script],
    });
    const nvmScript = sb.write(".nvm/versions/node/v1/lib/node_modules/turno-cli/dist/cli/main.js", "");
    const pinned = chooseProgram({
      env: { PATH: "", HOME: "/x" },
      execPath: "/x/.nvm/versions/node/v1/bin/node",
      script: nvmScript,
    });
    expect(pinned.warning).toBe(
      "the service runs node from ~/.nvm/versions/node/v1/bin/node; after switching Node versions run `turno upgrade --finish`",
    );
  });

  it("gives one clear line when there is no service manager", async () => {
    const empty = { ...sb.env, PATH: join(sb.home, "nothing") };
    await expect(serviceBackend(empty, "linux")).rejects.toThrow(/no systemd user instance/);
    await expect(serviceBackend(empty, "win32")).rejects.toThrow(/not supported on win32/);
    const err = await runTool("launchctl", ["print"], empty).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as Error).message).toBe("launchctl was not found on PATH; it is needed to manage the mcpd service");
  });

  it("installs and removes the systemd unit through the journal, never creating ~/Library", async () => {
    const backend = await serviceBackend(sb.env, "linux");
    expect(backend).toBe(systemd);
    const r = await installService(
      backend,
      { program: ["/usr/bin/turno"], env: sb.env },
      new Journal(sb.env, "test start"),
    );
    expect(readFileSync(r.file, "utf8")).toContain("ExecStart=");
    expect(callLog()).toEqual(
      expect.arrayContaining([
        "systemctl --user daemon-reload",
        "systemctl --user enable turno-mcpd.service",
        "systemctl --user restart turno-mcpd.service",
      ]),
    );
    await removeService(backend, sb.env, new Journal(sb.env, "test stop"));
    expect(existsSync(r.file)).toBe(false);
    expect(callLog()).toContain("systemctl --user disable --now turno-mcpd.service");
    expect(existsSync(join(sb.home, "Library"))).toBe(false);
  });
});

const serviceFile = () => (process.platform === "darwin" ? plistPath(sb.env) : unitPath(sb.env));

describe("turno mcp daemon", () => {
  it("--help never runs an action, unknown flags are usage errors, and the usage names turno mcp daemon", async () => {
    let io = fakeIo(sb.env);
    expect(await main(["mcp", "daemon", "start", "--help"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain("turno mcp daemon start");
    expect(existsSync(serviceFile())).toBe(false);
    expect(callLog()).toEqual([]);
    io = fakeIo(sb.env);
    expect(await main(["mcp", "daemon", "start", "--dryrun"], io)).toBe(2);
    expect(io.errors.join("\n")).toContain("unknown option --dryrun");
    io = fakeIo(sb.env);
    expect(await main(["mcpd", "--help"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain("turno mcp daemon stop");
    expect(io.lines.join("\n")).not.toMatch(/turno mcpd /);
    expect(await main(["mcp", "daemon", "logs", "-n", "x"], fakeIo(sb.env))).toBe(2);
    expect(existsSync(state("mcpd.token"))).toBe(false);
  });

  it("start --dry-run prints the service file and writes nothing", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["mcp", "daemon", "start", "--dry-run"], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("would write");
    expect(out).toMatch(/daemon/);
    expect(existsSync(serviceFile())).toBe(false);
    expect(existsSync(state("mcpd.token"))).toBe(false);
    expect(callLog().some((l) => /bootstrap|enable/.test(l))).toBe(false);
  });

  it("start installs the service through the journal; stop removes it; undo brings the file back", async () => {
    await start(); // answers /status, as the service would
    let io = fakeIo(sb.env);
    expect(await main(["mcp", "daemon", "start"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain("mcpd is running");
    expect(existsSync(serviceFile())).toBe(true);
    expect(callLog().some((l) => /bootstrap|enable/.test(l))).toBe(true);

    io = fakeIo(sb.env);
    expect(await main(["mcp", "daemon", "stop"], io)).toBe(0);
    expect(existsSync(serviceFile())).toBe(false);
    expect(io.lines.join("\n")).toContain("turno mcp daemon start installs it again");
    expect(callLog().some((l) => /bootout|disable --now/.test(l))).toBe(true);

    expect(await main(["undo", "last"], fakeIo(sb.env))).toBe(0);
    expect(existsSync(serviceFile())).toBe(true);
  });

  it("logs show local time unless --utc", async () => {
    sb.write(".local/state/turno/logs/mcpd.log", "2026-01-02T03:04:05.000Z hello\n");
    let io = fakeIo(sb.env);
    await main(["mcp", "daemon", "logs"], io);
    expect(io.lines).toEqual([`${localTime("2026-01-02T03:04:05.000Z")} hello`]);
    io = fakeIo(sb.env);
    await main(["mcp", "daemon", "logs", "--utc", "-n", "1"], io);
    expect(io.lines).toEqual(["2026-01-02T03:04:05.000Z hello"]);
  });

  it("status explains why mcpd is down", async () => {
    sb.write(
      ".local/state/turno/mcpd.error.json",
      JSON.stringify({ at: "2026-01-02T03:04:05.000Z", message: "port 1 is in use by x" }),
    );
    const io = fakeIo(sb.env);
    // Exit 5: the gateway does not answer (ADR 0045; it was 1).
    expect(await main(["mcp", "daemon", "status"], io)).toBe(5);
    expect(io.lines.join("\n")).toContain("last start failed");
  });

  it("token rotate writes a new token, never prints it, and asks for a sync", async () => {
    const before = masterToken(sb.env, "ensure")!;
    const io = fakeIo(sb.env);
    expect(await main(["mcp", "token", "rotate"], io)).toBe(0);
    const after = readToken(sb.env)!;
    expect(after).not.toBe(before);
    const all = [...io.lines, ...io.errors].join("\n");
    expect(all).not.toContain(after);
    expect(all).toContain("turno mcp sync");
    expect(await main(["mcp", "token", "spin"], fakeIo(sb.env))).toBe(2);
  });

  it("upgrade --finish rewrites an installed service and restarts it", async () => {
    const file = serviceFile();
    sb.write(
      file.slice(sb.home.length + 1),
      process.platform === "darwin" ? "<plist><string>Background</string></plist>" : "[Service]\nExecStart=/old/node\n",
    );
    const io = fakeIo(sb.env);
    expect(await finishUpgrade(io)).toBe(0);
    expect(io.lines.join("\n")).toContain("restarting it");
    expect(readFileSync(file, "utf8")).toContain("daemon");
    expect(callLog().some((l) => /bootstrap|restart/.test(l))).toBe(true);
  });
});

describe("doctor, mcpd section", () => {
  const mcpdLines = async () => (await collectChecks(sb.env)).filter((c) => c.area === "mcpd");

  it("fails when the port belongs to another process", async () => {
    const { port } = await listen();
    sb.write(".config/turno/config.toml", `[mcpd]\nport = ${port}\n`);
    masterToken(sb.env, "ensure");
    const checks = await mcpdLines();
    const c = checks.find((x) => x.text.includes(`port ${port} is in use`));
    expect(c?.level).toBe("fail");
  });

  it("is happy with our own mcpd and warns about synced profiles on another port", async () => {
    const d = await start();
    const synced = sb.write(
      ".claude-work/.claude.json",
      JSON.stringify({ mcpServers: { x: { url: "http://127.0.0.1:1234/mcp/x" } } }),
    );
    sb.write(".local/state/turno/mcp-managed.json", JSON.stringify({ [synced]: ["x"] }));
    const checks = await mcpdLines();
    expect(checks.find((c) => c.text.includes(`reachable on port ${d.port}`))?.level).toBe("ok");
    const sync = checks.find((c) => c.text.includes("point at port 1234"));
    expect(sync?.level).toBe("warn");
    expect(sync?.fix?.label).toBe("turno mcp sync");
  });

  it("fails when the service file runs a path that no longer exists", async () => {
    const file = serviceFile();
    const text =
      process.platform === "darwin"
        ? plist({ program: ["/nonexistent/turno"], env: sb.env })
        : unit({ program: ["/nonexistent/turno"], env: sb.env });
    sb.write(file.slice(sb.home.length + 1), text);
    const c = (await mcpdLines()).find((x) => x.text.includes("no longer exists"));
    expect(c?.level).toBe("fail");
    expect(c?.fix?.label).toBe("turno mcp daemon start");
  });
});

describe("registry versions", () => {
  it("accepts only strict semver from the registry and for --to", async () => {
    expect(isSemver("1.2.3")).toBe(true);
    expect(isSemver("1.2.3-next.0")).toBe(true);
    for (const bad of ["git+https://example.com/x.git", "^1.2.3", "1.2", "v1.2.3", "1.2.3 && rm", "latest"])
      expect(isSemver(bad)).toBe(false);
    const env = { ...sb.env, TURNO_NO_UPDATE_CHECK: "" };
    const evil = (async () =>
      new Response(JSON.stringify({ version: "git+https://example.com/x.git" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const s = await fetchLatest(env, "latest", evil);
    expect(s.latest).toBeUndefined();
    expect(s.error).toContain("invalid version");
    expect(await main(["upgrade", "--to", "git+https://example.com/x.git", "--dry-run"], fakeIo(sb.env))).toBe(2);
  });
});
