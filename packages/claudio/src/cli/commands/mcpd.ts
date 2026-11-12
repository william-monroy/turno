import { createReadStream, existsSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../../core/paths.js";
import { type Command, type Io, fail, paint } from "../io.js";

const USAGE = `Usage:
  claudio mcpd run [--port N]     run the gateway in the foreground
  claudio mcpd start              install and start the LaunchAgent (keeps mcpd alive)
  claudio mcpd stop               stop and unload the LaunchAgent
  claudio mcpd restart            restart the LaunchAgent
  claudio mcpd status [--json]    running servers, their clients and memory
  claudio mcpd logs [-n N]        last lines of the mcpd log`;

/** GET /status from the running daemon. */
export async function fetchStatus(env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | undefined> {
  const { mcpdPort, readToken } = await import("../../mcpd/daemon.js");
  const token = readToken(env);
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

async function status(args: string[], io: Io): Promise<number> {
  const s = await fetchStatus(io.env);
  if (!s) {
    io.out("mcpd is not running (claudio mcpd start)");
    return 1;
  }
  if (args.includes("--json")) {
    io.out(JSON.stringify(s, null, 2));
    return 0;
  }
  const instances = (s.instances as Record<string, unknown>[]) ?? [];
  const rss = await rssOf([Number(s.pid), ...instances.map((i) => Number(i.pid)).filter(Boolean)]);
  io.out(`${paint(io, "mcpd", "1")} pid ${s.pid} · ${mb(rss.get(Number(s.pid)) ?? 0)} · ${s.sessions} client sessions`);
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
      `  ${String(i.server).padEnd(24)} ${String(i.variant).padEnd(10)} pid ${String(i.pid ?? "-").padEnd(7)} ${mb(mem).padStart(7)}  ${i.clients} clients  idle ${i.idleSeconds}s${holder ? `  held by ${holder.profile ?? "?"}/${holder.pid ?? "?"}` : ""}`,
    );
  }
  io.out(`  total ${mb(total)}`);
  return 0;
}

function entryScript(): string {
  return realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "main.js"));
}

async function logs(args: string[], io: Io): Promise<number> {
  const n = Number(args[args.indexOf("-n") + 1]) || 40;
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
  for (const l of lines.slice(-n)) io.out(l);
  return 0;
}

export const command: Command = {
  summary: "run or manage the MCP gateway daemon",
  usage: USAGE,
  async run(args, io) {
    const [sub, ...rest] = args;
    switch (sub) {
      case "run": {
        const { startDaemon } = await import("../../mcpd/daemon.js");
        const portArg = rest.indexOf("--port");
        const d = await startDaemon({
          env: io.env,
          logToStdout: process.stdout.isTTY,
          ...(portArg >= 0 ? { port: Number(rest[portArg + 1]) } : {}),
        });
        io.err(`mcpd listening on 127.0.0.1:${d.port}`);
        await new Promise<void>((resolve) => {
          const stop = () => {
            void d.stop().then(resolve);
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        return 0;
      }
      case "start": {
        const { install } = await import("../../mcpd/launchd.js");
        const { ensureToken } = await import("../../mcpd/daemon.js");
        ensureToken(io.env);
        const file = await install({ node: process.execPath, script: entryScript(), env: io.env });
        io.out(`LaunchAgent installed: ${file}`);
        for (let i = 0; i < 20; i++) {
          if (await fetchStatus(io.env)) {
            io.out("mcpd is running");
            return 0;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        io.err("mcpd did not answer yet; see claudio mcpd logs");
        return 1;
      }
      case "stop": {
        const { uninstall } = await import("../../mcpd/launchd.js");
        await uninstall();
        io.out("mcpd stopped");
        return 0;
      }
      case "restart": {
        const { restart } = await import("../../mcpd/launchd.js");
        await restart();
        io.out("mcpd restarted");
        return 0;
      }
      case "status":
        return status(rest, io);
      case "logs":
        return logs(rest, io);
      default:
        return fail(`unknown mcpd command "${sub ?? ""}"\n${USAGE}`);
    }
  },
};
