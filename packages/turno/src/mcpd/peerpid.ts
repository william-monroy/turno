import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * PID of the local process that owns the client side of a TCP connection to mcpd, found
 * with lsof. Used when a session did not send X-Turno-Pid (not started by a launcher).
 */
export async function peerPid(remotePort: number, self = process.pid): Promise<number | undefined> {
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${remotePort}`, "-sTCP:ESTABLISHED", "-Fpn"], { timeout: 3000 });
    let pid: number | undefined;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      // The client side is the socket whose local port is remotePort: "n127.0.0.1:<remotePort>->..."
      if (line.startsWith("n") && pid && pid !== self && line.slice(1).split("->")[0]?.endsWith(`:${remotePort}`)) return pid;
    }
  } catch {
    // lsof missing or nothing found
  }
  return undefined;
}
