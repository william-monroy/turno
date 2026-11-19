import { execFile } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PeerOptions {
  platform?: NodeJS.Platform;
  /** Root of the proc filesystem (tests point it at a fake tree). */
  procRoot?: string;
  /** PATH used to find lsof. */
  env?: NodeJS.ProcessEnv;
}

/** portOwner's options: a pid to check first, such as the one mcpd reports. */
export interface PortOwnerOptions extends PeerOptions {
  pid?: number;
}

/** One row of /proc/net/tcp or tcp6. */
interface TcpRow {
  localPort: number;
  remotePort: number;
  /** Hex state: 01 established, 0A listen. */
  state: string;
  uid: number;
  inode: string;
}

function hexPort(addr: string | undefined): number {
  const port = addr?.split(":").pop();
  return port ? Number.parseInt(port, 16) : Number.NaN;
}

/** Parse the rows of /proc/net/tcp and /proc/net/tcp6 (empty when they do not exist). */
function procTcpRows(procRoot = "/proc"): TcpRow[] {
  const rows: TcpRow[] = [];
  for (const name of ["tcp", "tcp6"]) {
    let text: string;
    try {
      text = readFileSync(join(procRoot, "net", name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      rows.push({
        localPort: hexPort(f[1]),
        remotePort: hexPort(f[2]),
        state: f[3] ?? "",
        uid: Number(f[7]),
        inode: f[9] ?? "",
      });
    }
  }
  return rows;
}

/** PID of the process holding socket `inode`, scanning the fds we are allowed to read. */
function pidOfInode(inode: string, procRoot = "/proc", skip?: number): number | undefined {
  if (!inode || inode === "0") return undefined;
  const want = `socket:[${inode}]`;
  let pids: string[];
  try {
    pids = readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return undefined;
  }
  for (const pid of pids) {
    if (Number(pid) === skip) continue;
    let fds: string[];
    try {
      fds = readdirSync(join(procRoot, pid, "fd"));
    } catch {
      continue; // another user's process, or gone
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(join(procRoot, pid, "fd", fd)) === want) return Number(pid);
      } catch {
        /* closed meanwhile */
      }
    }
  }
  return undefined;
}

async function lsofPeer(remotePort: number, self: number, env: NodeJS.ProcessEnv): Promise<number | undefined> {
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${remotePort}`, "-sTCP:ESTABLISHED", "-Fpn"], {
      timeout: 3000,
      env,
    });
    let pid: number | undefined;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      // The client side is the socket whose local port is remotePort: "n127.0.0.1:<remotePort>->..."
      if (line.startsWith("n") && pid && pid !== self && line.slice(1).split("->")[0]?.endsWith(`:${remotePort}`))
        return pid;
    }
  } catch {
    // lsof missing or nothing found
  }
  return undefined;
}

/**
 * PID of the local process that owns the client side of a TCP connection to mcpd. Used when a
 * session did not send X-Turno-Pid (not started by a launcher). On Linux it reads
 * /proc/net/tcp(6) and /proc/<pid>/fd; elsewhere, or when that finds nothing, it asks lsof;
 * without either it gives up.
 */
export async function peerPid(
  remotePort: number,
  self = process.pid,
  opts: PeerOptions = {},
): Promise<number | undefined> {
  const platform = opts.platform ?? process.platform;
  if (platform === "linux") {
    const procRoot = opts.procRoot ?? "/proc";
    const row = procTcpRows(procRoot).find((r) => r.localPort === remotePort && r.state === "01");
    const pid = row ? pidOfInode(row.inode, procRoot, self) : undefined;
    if (pid) return pid;
  }
  return lsofPeer(remotePort, self, opts.env ?? process.env);
}

export interface PortOwner {
  pid?: number;
  uid?: number;
  command?: string;
}

/** Whether something accepts TCP connections on 127.0.0.1:`port`, the address mcpd binds. */
function listensOn(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (yes: boolean) => {
      socket.destroy();
      resolve(yes);
    };
    socket.setTimeout(timeoutMs, () => done(true)); // accepted the SYN but slow to finish: busy
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function parseLsof(stdout: string): PortOwner | undefined {
  const owner: PortOwner = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p") && owner.pid === undefined) owner.pid = Number(line.slice(1));
    else if (line.startsWith("c") && owner.command === undefined) owner.command = line.slice(1);
    else if (line.startsWith("u") && owner.uid === undefined) owner.uid = Number(line.slice(1));
  }
  return owner.pid !== undefined ? owner : undefined;
}

/**
 * Which process listens on 127.0.0.1:`port`, as far as this user can tell. Undefined when the
 * port is free; an empty object when something listens but the system cannot say what.
 *
 * On macOS lsof scans every process and can take many seconds on a busy machine, so a free port
 * is told by a refused connection without lsof, and `opts.pid` (a process expected to hold the
 * port) is checked alone first.
 */
export async function portOwner(port: number, opts: PortOwnerOptions = {}): Promise<PortOwner | undefined> {
  const platform = opts.platform ?? process.platform;
  if (platform === "linux") {
    const procRoot = opts.procRoot ?? "/proc";
    const row = procTcpRows(procRoot).find((r) => r.localPort === port && r.state === "0A");
    if (row) {
      const pid = pidOfInode(row.inode, procRoot);
      let command: string | undefined;
      try {
        if (pid) command = readFileSync(join(procRoot, String(pid), "comm"), "utf8").trim();
      } catch {
        /* gone */
      }
      return { uid: row.uid, ...(pid ? { pid } : {}), ...(command ? { command } : {}) };
    }
  }
  if (!(await listensOn(port))) return undefined;
  const lsof = async (args: string[]): Promise<PortOwner | undefined> => {
    try {
      const { stdout } = await run("lsof", ["-nP", ...args, `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcu"], {
        timeout: 3000,
        env: opts.env ?? process.env,
      });
      return parseLsof(stdout);
    } catch {
      return undefined; // lsof exits 1 when it finds nothing; also missing or too slow
    }
  };
  if (opts.pid !== undefined) {
    const own = await lsof(["-a", "-p", String(opts.pid)]);
    if (own) return own;
  }
  return (await lsof([])) ?? {};
}

/** "node (pid 123, uid 501)" for messages. */
export function describeOwner(o: PortOwner | undefined): string {
  if (!o) return "another process";
  const bits = [o.pid !== undefined ? `pid ${o.pid}` : "", o.uid !== undefined ? `uid ${o.uid}` : ""].filter(Boolean);
  return `${o.command ?? "a process"}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}
