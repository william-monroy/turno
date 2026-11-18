import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Journal } from "../../core/journal.js";
import { paths, tildify } from "../../core/paths.js";
import { DRY_RUN, JSON_FLAG, TAIL, bool, count, parseFlags, str } from "../args.js";
import { Exit } from "../exit.js";
import { emit, jsonOutput } from "../output.js";
import { type Sub, group } from "../group.js";
import { type Command, type Io, fail, paint, plural } from "../io.js";
import { duration, spinner, style } from "../style.js";

/** GET /status from the running daemon. */
export async function fetchStatus(env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | undefined> {
  const { mcpdPort, readToken } = await import("../../mcpd/state.js");
  const token = readToken(env, () => {});
  if (!token) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${mcpdPort(env)}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function rssOf(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!pids.length) return out;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("ps", ["-o", "pid=,rss=", "-p", pids.join(",")]);
    for (const line of stdout.trim().split("\n")) {
      const [pid, rss] = line.trim().split(/\s+/).map(Number);
      if (pid && rss) out.set(pid, rss * 1024);
    }
  } catch {
    /* processes gone */
  }
  return out;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1048576)} MB`;
}

/** Why mcpd is down, as far as the files and the port can tell (also shown by `turno status`). */
export async function downReasons(env: NodeJS.ProcessEnv): Promise<string[]> {
  const { daemonFiles, loadConfigSafe, readLock, readStartError } = await import("../../mcpd/state.js");
  const { describeOwner, portOwner } = await import("../../mcpd/peerpid.js");
  const out: string[] = [];
  const port = loadConfigSafe(env).config.mcpd.port;
  const owner = await portOwner(port, { env });
  if (owner) out.push(`port ${port} is in use by ${describeOwner(owner)}`);
  const e = readStartError(env);
  if (e) out.push(`last start failed at ${localTime(e.at)}: ${e.message}`);
  const lock = readLock(env);
  if (lock)
    out.push(`stale lock from pid ${lock.pid} (${tildify(daemonFiles(env).lock, env)}); the next start clears it`);
  return out;
}

/** `turno mcp daemon status --json`: mcpd's /status, or `{ running: false, problems }`. */
const STATUS_JSON = jsonOutput([
  "running",
  "problems",
  "pid",
  "version",
  "port",
  "startedAt",
  "sessions",
  "agents",
  "memoryPressure",
  "instances",
  "manifest",
  "config",
  "callLog",
  "serverRss",
]);

async function status(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const s = await fetchStatus(io.env);
  if (!s) {
    const reasons = await downReasons(io.env);
    if (bool(p, "json")) emit(io, p, STATUS_JSON, { running: false, problems: reasons });
    else {
      io.out("mcpd is not running (turno mcp daemon start)");
      for (const r of reasons) io.out(`  ${r}`);
    }
    return Exit.gatewayDown;
  }
  if (bool(p, "json")) {
    emit(io, p, STATUS_JSON, s);
    return 0;
  }
  const instances = (s.instances as Record<string, unknown>[]) ?? [];
  const rss = await rssOf([Number(s.pid), ...instances.map((i) => Number(i.pid)).filter(Boolean)]);
  io.out(
    `${paint(io, "mcpd", "1")} pid ${s.pid}${s.port ? ` · port ${s.port}` : ""} · ${mb(rss.get(Number(s.pid)) ?? 0)} · ${plural(Number(s.sessions) || 0, "client session")}`,
  );
  const manifest = s.manifest as { source: string; error: string | null } | undefined;
  if (manifest?.error)
    io.out(`  ${paint(io, "warn", "33")} mcp.toml is invalid, serving the ${manifest.source}: ${manifest.error}`);
  const config = s.config as { error: string | null } | undefined;
  if (config?.error) io.out(`  ${paint(io, "warn", "33")} config.toml is invalid, using defaults: ${config.error}`);
  if (!instances.length) {
    io.out("  no servers running (they start on first use)");
    return 0;
  }
  let total = rss.get(Number(s.pid)) ?? 0;
  for (const i of instances) {
    const mem = rss.get(Number(i.pid)) ?? 0;
    total += mem;
    const holder = i.holder as { profile: string | null; pid: number | null } | null;
    io.out(
      `  ${String(i.server).padEnd(24)} ${String(i.variant).padEnd(10)} pid ${String(i.pid ?? "-").padEnd(7)} ${mb(mem).padStart(7)}  ${plural(Number(i.clients) || 0, "client")}  idle ${i.idleSeconds}s${holder ? `  held by ${holder.profile ?? "?"}/${holder.pid ?? "?"}` : ""}`,
    );
    const busy = inflightText(i.inflightByClient);
    if (busy) io.out(`    ${busy}`);
  }
  io.out(`  total ${mb(total)}`);
  return 0;
}

/** "2 calls in flight: 1f2e3d4c 1, 9a8b7c6d 1" from /status `inflightByClient` (client session ids). */
export function inflightText(byClient: unknown): string | undefined {
  if (!byClient || typeof byClient !== "object") return undefined;
  const rows = Object.entries(byClient as Record<string, unknown>).filter(([, n]) => Number(n) > 0);
  if (!rows.length) return undefined;
  const total = rows.reduce((t, [, n]) => t + Number(n), 0);
  return `${plural(total, "call")} in flight: ${rows.map(([id, n]) => `${id.slice(0, 8)} ${n}`).join(", ")}`;
}

/** The CLI entry the service runs when no stable `turno` is on PATH. */
export function entryScript(): string {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  for (const f of ["main.js", "main.ts"]) {
    const file = join(dir, f);
    if (existsSync(file)) return realpathSync(file);
  }
  return join(dir, "main.js");
}

/** "2026-11-16 15:26:45" in the local time zone, from an ISO timestamp. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A log line with its leading UTC timestamp shown in local time. */
export function localizeLine(line: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /.exec(line);
  return m ? `${localTime(m[1]!)} ${line.slice(m[0].length)}` : line;
}

async function logs(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { ...TAIL, utc: { type: "boolean" } }, 0);
  const n = count(p, "tail", 40);
  const file = join(paths(io.env).logsDir, "mcpd.log");
  if (!existsSync(file)) {
    io.out("no log yet");
    return 0;
  }
  const size = statSync(file).size;
  const start = Math.max(0, size - 256 * 1024);
  const chunks: Buffer[] = [];
  for await (const c of createReadStream(file, { start })) chunks.push(c as Buffer);
  const lines = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n");
  for (const l of lines.slice(-n)) io.out(bool(p, "utc") ? l : localizeLine(l));
  return 0;
}

const isService = (env: NodeJS.ProcessEnv): boolean => Boolean(env.TURNO_MCPD_SERVICE);

async function runDaemon(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { port: { type: "string" } }, 0);
  const raw = str(p, "port");
  let port: number | undefined;
  if (raw !== undefined) {
    port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== raw.trim())
      fail("--port must be an integer between 0 and 65535");
  }
  const { AlreadyRunningError, PortBusyError, installCrashGuards, startDaemon } = await import("../../mcpd/daemon.js");
  const service = isService(io.env);
  let waiting = false;
  for (;;) {
    try {
      const d = await startDaemon({
        env: io.env,
        logToStdout: Boolean(process.stdout.isTTY) && !service,
        ...(port !== undefined ? { port } : {}),
      });
      io.err(`mcpd listening on 127.0.0.1:${d.port}`);
      const unguard = installCrashGuards(d.log, () => d.stop());
      await new Promise<void>((resolve) => {
        const stop = () => {
          void d.stop().then(resolve, resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      unguard();
      return 0;
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        io.err(`turno: ${err.message}`);
        // Under a service a clean exit is not restarted: the other mcpd serves.
        return service ? 0 : 1;
      }
      if (err instanceof PortBusyError && service) {
        // Exiting would make the supervisor loop; wait for the port instead (doctor shows why).
        if (!waiting) io.err(`turno: ${err.message}; retrying every 30 s`);
        waiting = true;
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      if (err instanceof PortBusyError) {
        io.err(`turno: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }
}

async function backendOrReport(io: Io): Promise<import("../../mcpd/service.js").ServiceBackend | undefined> {
  const { ServiceError, serviceBackend } = await import("../../mcpd/service.js");
  try {
    return await serviceBackend(io.env);
  } catch (err) {
    if (err instanceof ServiceError) {
      io.err(`turno: ${err.message}`);
      return undefined;
    }
    throw err;
  }
}

/** Run a service step; a ServiceError is one line on stderr and exit 1, never a stack. */
async function serviceStep(io: Io, step: () => Promise<number>): Promise<number> {
  const { ServiceError } = await import("../../mcpd/service.js");
  try {
    return await step();
  } catch (err) {
    if (err instanceof ServiceError) {
      io.err(`turno: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (let waited = 0; waited <= ms; waited += 250) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Write (or rewrite) the service file and (re)load it. Shared by `start` and `upgrade --finish`. */
export async function installDaemonService(
  io: Io,
  opts: { dryRun?: boolean; command?: string; journal?: Journal } = {},
): Promise<number> {
  const backend = await backendOrReport(io);
  if (!backend) return 1;
  return serviceStep(io, async () => {
    const { chooseProgram, installService } = await import("../../mcpd/service.js");
    const choice = chooseProgram({ env: io.env, execPath: process.execPath, script: entryScript() });
    const journal = opts.journal ?? new Journal(io.env, opts.command ?? "mcp daemon start", Boolean(opts.dryRun));
    if (!opts.dryRun) {
      const { ensureToken } = await import("../../mcpd/state.js");
      ensureToken(io.env, (m) => io.err(`turno: ${m}`));
    }
    const r = await installService(backend, { program: choice.program, env: io.env }, journal);
    if (opts.dryRun) {
      io.out(`would write ${tildify(r.file, io.env)}${r.changed ? "" : " (unchanged)"} and load the ${backend.noun}:`);
      io.out("");
      io.out(r.text.trimEnd());
    } else
      io.out(
        style(io).note("ok", `${backend.noun} ${r.changed ? "written" : "unchanged"}: ${tildify(r.file, io.env)}`),
      );
    if (choice.warning) io.err(style(io).note("warn", `warning: ${choice.warning}`));
    const hint = opts.journal ? undefined : journal.hint();
    if (hint) io.out(hint);
    return 0;
  });
}

/** Install the service and wait until mcpd answers. Non-zero when either step fails. */
export async function startDaemonService(io: Io, opts: { journal?: Journal } = {}): Promise<number> {
  const code = await installDaemonService(io, opts);
  if (code) return code;
  const st = style(io);
  const spin = spinner(io, "waiting for mcpd to answer");
  const up = await waitFor(async () => Boolean(await fetchStatus(io.env)), 5000);
  const ms = spin.stop();
  if (up) {
    io.out(st.note("ok", `mcpd is running ${st.muted(`(${duration(ms)})`)}`));
    return 0;
  }
  io.err(st.note("err", "mcpd did not answer yet; see turno mcp daemon status and turno mcp daemon logs"));
  return 1;
}

async function start(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 0);
  const dryRun = bool(p, "dry-run");
  if (dryRun) return installDaemonService(io, { dryRun });
  return startDaemonService(io);
}

/** Stop the service and remove its file, so mcpd does not come back at login. A hand-started mcpd gets SIGTERM. */
async function stop(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 0);
  const dryRun = bool(p, "dry-run");
  const { installedBackend, removeService } = await import("../../mcpd/service.js");
  const { liveLock } = await import("../../mcpd/state.js");
  return serviceStep(io, async () => {
    const backend = (await installedBackend(io.env)) ?? (await backendOrReport({ ...io, err: () => {} }));
    const journal = new Journal(io.env, "mcp daemon stop", dryRun);
    let did = false;
    if (backend) {
      const r = await removeService(backend, io.env, journal);
      if (r.existed) {
        io.out(
          `${dryRun ? "would remove" : "removed"} ${tildify(r.file, io.env)} (turno mcp daemon start installs it again)`,
        );
        did = true;
      }
    }
    const lock = liveLock(io.env);
    if (lock && lock.pid !== process.pid) {
      if (dryRun) io.out(`would stop mcpd (pid ${lock.pid})`);
      else {
        try {
          process.kill(lock.pid, "SIGTERM");
        } catch {
          /* gone already */
        }
        await waitFor(async () => !liveLock(io.env), 5000);
      }
      did = true;
    }
    if (!dryRun) io.out(did ? "mcpd stopped" : "mcpd was not running");
    const hint = journal.hint();
    if (hint) io.out(hint);
    return 0;
  });
}

async function restart(args: string[], io: Io): Promise<number> {
  parseFlags(args, {}, 0);
  const { installedBackend } = await import("../../mcpd/service.js");
  return serviceStep(io, async () => {
    const backend = await installedBackend(io.env);
    if (!backend) {
      io.err("turno: the mcpd service is not installed (turno mcp daemon start)");
      return 1;
    }
    await backend.restart(io.env);
    io.out("mcpd restarted; open sessions reconnect on their next call");
    return 0;
  });
}

/** `turno mcp token rotate`: a new master token, then mcpd picks it up and profiles need a sync. */
async function token(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const action = p.positionals[0];
  if (action !== "rotate") return fail(`usage: turno mcp token rotate [--dry-run]`);
  const file = tildify(paths(io.env).mcpdToken, io.env);
  if (bool(p, "dry-run")) {
    io.out(`would write a new token to ${file} and restart mcpd`);
    return 0;
  }
  const { liveLock, rotateToken } = await import("../../mcpd/state.js");
  const { installedBackend } = await import("../../mcpd/service.js");
  rotateToken(io.env);
  io.out(`new gateway token written to ${file}`);
  const code = await serviceStep(io, async () => {
    const backend = await installedBackend(io.env);
    if (backend && (await backend.isLoaded(io.env))) {
      await backend.restart(io.env);
      io.out("mcpd restarted with the new token");
      return 0;
    }
    const lock = liveLock(io.env);
    if (lock && lock.pid !== process.pid) {
      process.kill(lock.pid, "SIGHUP");
      io.out(`mcpd (pid ${lock.pid}) reloads the new token`);
    } else io.out("mcpd is not running; it uses the new token when it starts");
    return 0;
  });
  io.out(
    "Every profile token derives from it and stopped working: run `turno mcp sync` so each profile gets its new one; open sessions need a restart.",
  );
  return code;
}

const SUBS: Record<string, Sub> = {
  start: {
    synopsis: "[--dry-run]",
    summary: "install the service (LaunchAgent or systemd user unit) and start mcpd",
    flags: ["--dry-run"],
    run: start,
  },
  stop: {
    synopsis: "[--dry-run]",
    summary: "stop mcpd and remove the service, so it does not start at login",
    flags: ["--dry-run"],
    run: stop,
  },
  restart: { summary: "restart the service (open sessions reconnect)", run: restart },
  status: {
    synopsis: "[--json]",
    summary: "running servers, their clients and memory; why mcpd is down (exit 5)",
    flags: ["--json"],
    json: STATUS_JSON,
    run: status,
  },
  logs: {
    synopsis: "[-n N] [--utc]",
    summary: "last lines of the mcpd log, in local time",
    flags: ["--tail", "--utc"],
    run: logs,
  },
  run: {
    synopsis: "[--port N]",
    summary: "run the gateway in the foreground (what the service runs)",
    flags: ["--port"],
    run: runDaemon,
  },
  token: {
    synopsis: "rotate [--dry-run]",
    summary: "replace the gateway token (then turno mcp sync)",
    args: ["any"],
    flags: ["--dry-run"],
    run: token,
  },
};

export const tokenCommand: Command = {
  summary: "replace the gateway token",
  usage:
    "Usage: turno mcp token rotate [--dry-run]\n\nWrites a new token (mode 600), restarts mcpd, and asks you to run turno mcp sync.\n\nExamples:\n  $ turno mcp token rotate --dry-run\n  $ turno mcp token rotate && turno mcp sync",
  run: async (args, io) => {
    if (!args.includes("--help") && !args.includes("-h")) return token(args, io);
    io.out(tokenCommand.usage);
    return 0;
  },
};

export const command: Command = group("mcp daemon", "run or manage the MCP gateway daemon", SUBS, {
  footer:
    "mcpd listens on 127.0.0.1 at mcpd.port (config.toml) and never moves to another port.\n" +
    "start keeps it alive with a LaunchAgent on macOS or a systemd user unit on Linux; stop removes it.",
  examples: [
    "turno mcp daemon start",
    "turno mcp daemon status --json",
    "turno mcp daemon restart",
    "turno mcp daemon logs -n 50",
    "turno mcp daemon stop --dry-run",
    "turno mcp daemon run --port 47900",
    "turno mcp daemon token rotate",
  ],
});
