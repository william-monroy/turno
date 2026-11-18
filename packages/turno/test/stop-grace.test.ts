import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/core/config.js";
import { type StdioServer, effectiveStopGrace, parseManifest } from "../src/core/manifest.js";
import { DefaultConnector } from "../src/mcpd/connectors.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `stop_grace` (ADR 0044): how long mcpd waits, after closing a server's stdin, before it sends
 * SIGTERM. The MCP SDK waits a fixed 2 seconds; a browser server needs that time to close Chrome
 * and write its profile, so turno-browser-mcp gets 5 seconds by default.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** A server that exits `delay` ms after its stdin closes, and records stdin end and SIGTERM. */
const SERVER = [
  "const fs = require('node:fs'); const log = (l) => fs.appendFileSync(process.env.EVENTS, l + '\\n');",
  "process.stdin.resume();",
  "process.stdin.on('end', () => { log('stdin closed'); setTimeout(() => { log('exit'); process.exit(0); }, Number(process.env.DELAY)); });",
  "process.on('SIGTERM', () => { log('SIGTERM'); if (!process.env.IGNORE_TERM) process.exit(0); });",
  "log('ready');",
].join("\n");

function server(toml: string): StdioServer {
  return parseManifest(toml).servers.s as StdioServer;
}

async function stopTimed(def: StdioServer, env: Record<string, string>): Promise<{ ms: number; events: string[] }> {
  const events = join(sb.home, `events-${Math.random()}`);
  const connector = new DefaultConnector({
    resolve: async (v) => v,
    serversDir: join(sb.home, "servers"),
    logsDir: join(sb.home, "logs"),
    baseEnv: { PATH: process.env.PATH ?? "", EVENTS: events, ...env },
  });
  const { transport } = await connector.connect(def, "default", { serverName: "s", sessionId: "t" }, sb.home);
  await transport.start();
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      if (readFileSync(events, "utf8").includes("ready")) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const t0 = Date.now();
  await transport.close();
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 100));
  return { ms, events: readFileSync(events, "utf8").trim().split("\n").slice(1) };
}

const node = JSON.stringify(process.execPath);
const script = JSON.stringify(SERVER);

describe("stop_grace", () => {
  it("parses as a duration and refuses nonsense", () => {
    expect(server(`[server.s]\ncommand = "x"\nstop_grace = "5s"`).stopGrace).toBe(5);
    expect(server(`[server.s]\ncommand = "x"\nstop_grace = 1.5`).stopGrace).toBe(1.5);
    expect(server(`[server.s]\ncommand = "x"`).stopGrace).toBeUndefined();
    expect(() => server(`[server.s]\ncommand = "x"\nstop_grace = "soon"`)).toThrow(ConfigError);
    expect(() => server(`[server.s]\ncommand = "x"\nstop_grace = "10m"`)).toThrow(/stop_grace must be at most 60s/);
  });

  it("defaults to 5 seconds for turno-browser-mcp, however it is started, and to the SDK's 2 otherwise", () => {
    expect(effectiveStopGrace(server(`[server.s]\ncommand = "turno-browser-mcp"\nargs = ["--identity", "school"]`), "default")).toBe(5);
    expect(effectiveStopGrace(server(`[server.s]\ncommand = "/opt/homebrew/bin/turno-browser-mcp"`), "default")).toBe(5);
    expect(effectiveStopGrace(server(`[server.s]\ncommand = "npx"\nargs = ["-y", "-p", "turno-browser@0.3.0", "turno-browser-mcp"]`), "default")).toBe(5);
    expect(effectiveStopGrace(server(`[server.s]\ncommand = "turno-browser-mcp"\nstop_grace = "8s"`), "default")).toBe(8);
    expect(effectiveStopGrace(server(`[server.s]\ncommand = "other-mcp"`), "default")).toBe(2);
    expect(effectiveStopGrace(server(`[server.s]\ncommand = "other-mcp"\nstop_grace = "0"`), "default")).toBe(0);
  });

  it("lets a server finish its own shutdown within the grace, without SIGTERM", async () => {
    const def = server(`[server.s]\ncommand = ${node}\nargs = ["-e", ${script}]\nstop_grace = "4s"`);
    const { ms, events } = await stopTimed(def, { DELAY: "2600" });
    expect(events).toEqual(["stdin closed", "exit"]);
    expect(ms).toBeGreaterThanOrEqual(2500);
    expect(ms).toBeLessThan(4000);
  }, 20_000);

  it("keeps the SDK's 2 seconds when unset: a slower server gets SIGTERM", async () => {
    const def = server(`[server.s]\ncommand = ${node}\nargs = ["-e", ${script}]`);
    const { events } = await stopTimed(def, { DELAY: "2600" });
    expect(events).toEqual(["stdin closed", "SIGTERM"]);
  }, 20_000);

  it("sends SIGTERM after a short grace, then SIGKILL 2 seconds later", async () => {
    const def = server(`[server.s]\ncommand = ${node}\nargs = ["-e", ${script}]\nstop_grace = "0.5s"`);
    const { ms, events } = await stopTimed(def, { DELAY: "10000", IGNORE_TERM: "1" });
    expect(events).toEqual(["stdin closed", "SIGTERM"]);
    expect(ms).toBeGreaterThanOrEqual(2400);
    expect(ms).toBeLessThan(4000);
  }, 20_000);
});
