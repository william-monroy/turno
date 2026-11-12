import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Manifest, parseManifest } from "../src/core/manifest.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector } from "../src/mcpd/connectors.js";
import { Gateway } from "../src/mcpd/gateway.js";
import { InstanceManager } from "../src/mcpd/instances.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));
const TOKEN = "test-token";

let sb: Sandbox;
let gw: Gateway;
let manager: InstanceManager;
let port: number;
let manifest: Manifest;
let clients: Client[] = [];
let spawnLog: string;

function fixtureToml(name: string, extra = ""): string {
  return `[server.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\nenv = { FIXTURE_LOG = ${JSON.stringify(spawnLog)}, FIXTURE_ACCOUNT = "keychain:default-account" }\n${extra}\n`;
}

async function boot(toml: string): Promise<void> {
  manifest = parseManifest(toml);
  manager = new InstanceManager({
    cache: new DescriptionCache(join(sb.home, "cache")),
    connector: new DefaultConnector({
      resolve: async (v) => (v === "keychain:default-account" ? "personal" : v === "keychain:work-account" ? "work" : v),
      serversDir: join(sb.home, "servers"),
      logsDir: join(sb.home, "logs"),
      baseEnv: { PATH: process.env.PATH ?? "" },
    }),
    home: sb.home,
  });
  gw = new Gateway({ manager, manifest: () => manifest, token: TOKEN, clientRequestTimeoutMs: 5000 });
  port = await gw.listen(0);
}

async function connect(server: string, headers: Record<string, string> = {}, onElicit?: () => unknown): Promise<Client> {
  const client = new Client({ name: "test", version: "1" }, { capabilities: onElicit ? { elicitation: { form: {} } } : {} });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async () => onElicit() as never);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${server}`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function callText(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return r.content[0]?.text ?? "";
}

function spawns(): number {
  try {
    return readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  sb = sandbox();
  spawnLog = join(sb.home, "spawns.log");
  clients = [];
});

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await manager?.stopAll();
  await gw?.close();
  sb.cleanup();
});

describe("mcpd gateway", () => {
  it("answers lists from the cache and starts the server only on a real call", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx");
    expect(spawns()).toBe(1); // cold cache: one start to learn the tools
    expect(a.getInstructions()).toBe("fixture instructions");
    await manager.stopAll();

    const b = await connect("fx");
    const tools = await b.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("counter");
    expect(spawns()).toBe(1); // warm cache: nothing started
    expect(await callText(b, "echo", { text: "hi" })).toBe("hi");
    expect(spawns()).toBe(2);
  });

  it("shares one process across sessions in shared scope", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx");
    const b = await connect("fx");
    expect(await callText(a, "counter")).toBe("1");
    expect(await callText(b, "counter")).toBe("2");
  });

  it("isolates by Claude session PID in session scope and reuses on reconnect", async () => {
    await boot(fixtureToml("fx", 'scope = "session"'));
    const a = await connect("fx", { "X-Turno-Pid": String(process.pid) });
    const a2 = await connect("fx", { "X-Turno-Pid": String(process.pid) });
    const other = spawn("sleep", ["30"]);
    const b = await connect("fx", { "X-Turno-Pid": String(other.pid) });
    expect(await callText(a, "counter")).toBe("1");
    expect(await callText(a2, "counter")).toBe("2");
    expect(await callText(b, "counter")).toBe("1");

    other.kill();
    await new Promise((r) => other.once("exit", r));
    const stopped = await manager.reap();
    expect(stopped.some((s) => s.includes("owner exited"))).toBe(true);
    expect(manager.list()).toHaveLength(1);
  });

  it("runs a profile variant with its own credentials", async () => {
    await boot(fixtureToml("fx", '[server.fx.variant.work]\nenv = { FIXTURE_ACCOUNT = "keychain:work-account" }'));
    const personal = await connect("fx", { "X-Turno-Profile": "personal" });
    const work = await connect("fx", { "X-Turno-Profile": "work" });
    expect(JSON.parse(await callText(personal, "whoami")).account).toBe("personal");
    expect(JSON.parse(await callText(work, "whoami")).account).toBe("work");
    expect(manager.list().map((i) => i.variant).sort()).toEqual(["default", "work"]);
  });

  it("starts project servers in the session's project root", async () => {
    await boot(fixtureToml("fx", 'scope = "project"'));
    const dir = join(sb.home, "proj", "sub");
    mkdirSync(dir, { recursive: true });
    const a = await connect("fx", { "X-Turno-Cwd": dir });
    expect(realpathSync(JSON.parse(await callText(a, "whoami")).cwd)).toBe(realpathSync(dir));
  });

  it("stops idle instances", async () => {
    await boot(fixtureToml("fx", 'idle = "0.2s"'));
    const a = await connect("fx");
    await callText(a, "echo", { text: "x" });
    await new Promise((r) => setTimeout(r, 400));
    await manager.reap();
    expect(manager.list()).toHaveLength(0);
    expect(await callText(a, "counter")).toBe("1"); // restarts transparently
  });

  it("grants exclusive servers to one session at a time", async () => {
    await boot(fixtureToml("fx", 'exclusive = true\nlease = "0.3s"'));
    const a = await connect("fx", { "X-Turno-Pid": String(process.pid), "X-Turno-Profile": "personal" });
    const b = await connect("fx");
    expect(await callText(a, "counter")).toBe("1");
    await expect(b.callTool({ name: "counter", arguments: {} })).rejects.toThrow(/in use by another session/);
    await new Promise((r) => setTimeout(r, 450));
    expect(await callText(b, "counter")).toBe("2");
  });

  it("relays elicitation to the calling session and progress back to it", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx", {}, () => ({ action: "accept", content: { name: "Ada" } }));
    expect(JSON.parse(await callText(a, "ask"))).toEqual({ action: "accept", content: { name: "Ada" } });
    const seen: number[] = [];
    await a.callTool({ name: "slow", arguments: { steps: 3 } }, undefined, { onprogress: (p) => seen.push(p.progress) });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("rejects requests without the token or from a browser origin", async () => {
    await boot(fixtureToml("fx"));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const noToken = await fetch(`http://127.0.0.1:${port}/mcp/fx`, { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(noToken.status).toBe(401);
    const origin = await fetch(`http://127.0.0.1:${port}/mcp/fx`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
    });
    expect(origin.status).toBe(403);
    const unknown = await fetch(`http://127.0.0.1:${port}/mcp/nope`, { method: "POST", body, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(unknown.status).toBe(404);
  });
});
