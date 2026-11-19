import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseProcTable, readProcTable } from "turno-core/process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrphanLightpandas, sweepOrphanLightpandas } from "../src/engine-lightpanda.js";
import { alive, waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The sweep of a Lightpanda that a server killed with SIGKILL left running: which processes
 * count (a fake process table), and the sweep of a real orphaned process standing in for
 * Lightpanda (a waiting Node process with that command line, whose parent exits).
 */

const bin = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "bin", "mcp.js");

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const JAR = "/home/alice/.local/state/turno/browser/identities/work/lightpanda-cookies.json";
const serve = (dir: string, jar?: string) =>
  `/usr/local/bin/lightpanda serve --unix-socket ${dir}/cdp.sock --log-level warn --cdp-max-message-size 67108864${
    jar ? ` --cookie ${jar} --cookie-jar ${jar}` : ""
  }`;

describe("findOrphanLightpandas", () => {
  const table = parseProcTable(
    [
      "1 0 1 /sbin/launchd",
      "300 1 300 node /usr/local/bin/turno-browser-mcp --identity work",
      `410 1 300 ${serve("/tmp/turno-lightpanda-AAAAAA", JAR)}`,
      `411 300 300 ${serve("/tmp/turno-lightpanda-BBBBBB", JAR)}`,
      `412 1 412 ${serve("/tmp/turno-lightpanda-CCCCCC")}`,
      `413 1 413 ${serve("/tmp/turno-lightpanda-DDDDDD", `${JAR}.other`)}`,
      `414 1 414 ${serve("/tmp/someone-else", JAR)}`,
      "415 1 415 /usr/local/bin/lightpanda serve --host 127.0.0.1 --port 9222",
    ].join("\n"),
  );

  it("finds only turno's orphaned Lightpanda for this identity's cookie jar", () => {
    expect(findOrphanLightpandas(JAR, table)).toEqual([{ pid: 410, socketDir: "/tmp/turno-lightpanda-AAAAAA" }]);
  });

  it("finds only the ones without a cookie jar for a server without an identity", () => {
    expect(findOrphanLightpandas(undefined, table)).toEqual([{ pid: 412, socketDir: "/tmp/turno-lightpanda-CCCCCC" }]);
  });
});

/**
 * A Node process that only waits, with the command line of turno's `lightpanda serve`. The
 * parent shell exits at once: it is left with no parent, as after a SIGKILL of the server.
 */
function orphan(dir: string, jar?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cdp.sock"), "");
  const args = serve(dir, jar).replace("/usr/local/bin/lightpanda ", "").split(" ");
  const quoted = args.map((a) => `'${a}'`).join(" ");
  execFileSync("/bin/sh", ["-c", `'${process.execPath}' -e 'setTimeout(() => {}, 60000)' ${quoted} >/dev/null 2>&1 &`]);
}

async function orphanPid(jar: string | undefined): Promise<number | undefined> {
  let pid: number | undefined;
  await waitFor(() => {
    const table = readProcTable();
    pid = table ? findOrphanLightpandas(jar, table)[0]?.pid : undefined;
    return pid !== undefined;
  }, 5_000);
  return pid;
}

function kill(pid: number | undefined): void {
  try {
    if (pid !== undefined) process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

describe.skipIf(process.platform === "win32")("sweepOrphanLightpandas on a real orphan", () => {
  it("stops it and removes its socket folder", async () => {
    const dir = join(sb.home, "turno-lightpanda-XYZ123");
    const jar = join(sb.home, "jar.json");
    orphan(dir, jar);
    const pid = await orphanPid(jar);
    expect(pid, "the stand-in runs with no parent").toBeDefined();
    try {
      const swept = await sweepOrphanLightpandas(jar, { graceMs: 2_000 });
      expect(swept).toEqual([{ pid, action: "exited" }]);
      expect(await waitFor(() => !alive(pid!), 2_000)).toBe(true);
      expect(existsSync(dir)).toBe(false);
    } finally {
      kill(pid);
    }
  }, 20_000);

  it("runs when a read mode server starts, and says what it closed", async () => {
    const dir = join(sb.home, "tmp", "turno-lightpanda-START1");
    orphan(dir);
    const pid = await orphanPid(undefined);
    expect(pid).toBeDefined();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--engine", "lightpanda"],
      env: sb.env as Record<string, string>,
      cwd: sb.home,
      stderr: "pipe",
    });
    let err = "";
    transport.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    const client = new Client({ name: "sweep", version: "0.0.0" });
    try {
      await client.connect(transport);
      expect(err).toContain(`closed a Lightpanda an earlier run left open (pid ${pid})`);
      expect(alive(pid!)).toBe(false);
    } finally {
      await client.close().catch(() => {});
      kill(pid);
    }
  }, 30_000);
});
