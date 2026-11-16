import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Manifest, parseManifest } from "../src/core/manifest.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector, RotatingLog } from "../src/mcpd/connectors.js";
import { Gateway, decodeCwdHeaders } from "../src/mcpd/gateway.js";
import { InstanceManager } from "../src/mcpd/instances.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));
const TOKEN = "test-token";
/** Sessions authenticate with a profile token (ADR 0023); "default" unless a test names one. */
const sessionAuth = (headers: Record<string, string> = {}) => `Bearer ${profileToken(TOKEN, headers["X-Turno-Profile"] ?? "default")}`;

let sb: Sandbox;
let gw: Gateway;
let manager: InstanceManager;
let port: number;
let manifest: Manifest;
let clients: Client[] = [];
let children: ChildProcess[] = [];
let remotes: { close(): Promise<void> }[] = [];
let spawnLog: string;
let eventsLog: string;
let toolsFile: string;

function fixtureToml(name: string, extra = "", account = "keychain:default-account"): string {
  const env = `{ FIXTURE_LOG = ${JSON.stringify(spawnLog)}, FIXTURE_EVENTS = ${JSON.stringify(eventsLog)}, FIXTURE_TOOLS_FILE = ${JSON.stringify(toolsFile)}, FIXTURE_ACCOUNT = ${JSON.stringify(account)} }`;
  return `[server.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\nenv = ${env}\n${extra}\n`;
}

interface BootOpts {
  port?: number;
  /** Use the real lookup of a client process folder; other tests get none, to stay deterministic. */
  realProcessCwd?: boolean;
  breakerBaseMs?: number;
}

async function boot(toml: string, o: BootOpts = {}): Promise<void> {
  manifest = parseManifest(toml);
  manager = new InstanceManager({
    cache: new DescriptionCache(join(sb.home, "cache")),
    connector: new DefaultConnector({
      resolve: async (v) =>
        v === "keychain:default-account" ? "personal" : v === "keychain:work-account" ? "work" : v === "keychain:rem-token" ? "Bearer remote-secret" : v,
      serversDir: join(sb.home, "servers"),
      logsDir: join(sb.home, "logs"),
      baseEnv: { PATH: process.env.PATH ?? "" },
    }),
    home: sb.home,
    ...(o.breakerBaseMs ? { breakerBaseMs: o.breakerBaseMs } : {}),
  });
  gw = new Gateway({
    manager,
    manifest: () => manifest,
    token: TOKEN,
    clientRequestTimeoutMs: 5000,
    ...(o.realProcessCwd ? {} : { processCwd: async () => undefined }),
  });
  port = await gw.listen(o.port ?? 0);
}

interface ConnectOpts {
  headers?: Record<string, string>;
  elicit?: () => unknown;
  sample?: () => unknown;
}

async function connectWith(server: string, o: ConnectOpts = {}): Promise<Client> {
  const caps: Record<string, unknown> = {};
  if (o.elicit) caps.elicitation = { form: {} };
  if (o.sample) caps.sampling = {};
  const client = new Client({ name: "test", version: "1" }, { capabilities: caps });
  if (o.elicit) {
    const answer = o.elicit;
    client.setRequestHandler(ElicitRequestSchema, async () => answer() as never);
  }
  if (o.sample) {
    const answer = o.sample;
    client.setRequestHandler(CreateMessageRequestSchema, async () => answer() as never);
  }
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${server}`), {
    requestInit: { headers: { Authorization: sessionAuth(o.headers), ...(o.headers ?? {}) } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const connect = (server: string, headers: Record<string, string> = {}, onElicit?: () => unknown) =>
  connectWith(server, { headers, ...(onElicit ? { elicit: onElicit } : {}) });

async function callText(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return r.content[0]?.text ?? "";
}

function lines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const spawns = () => lines(spawnLog).length;
const events = () => lines(eventsLog);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (path: string) => Buffer.from(path, "utf8").toString("base64url");

async function waitFor(cond: () => boolean, what = "condition", ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const inflight = () => manager.list().reduce((n, i) => n + i.upstream.inflight, 0);

beforeEach(() => {
  sb = sandbox();
  spawnLog = join(sb.home, "spawns.log");
  eventsLog = join(sb.home, "events.log");
  toolsFile = join(sb.home, "tools.txt");
  clients = [];
  children = [];
  remotes = [];
});

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const ch of children) ch.kill("SIGKILL");
  await manager?.stopAll();
  await gw?.close();
  for (const r of remotes) await r.close();
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
    children.push(other);
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

  it("starts project servers in the session's project root (legacy plain header)", async () => {
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
    await sleep(400);
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
    await sleep(450);
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
    const unknown = await fetch(`http://127.0.0.1:${port}/mcp/nope`, { method: "POST", body, headers: { authorization: sessionAuth() } });
    expect(unknown.status).toBe(404);
  });
});

describe("call lifecycle (ADR 0016)", () => {
  it("settles a cancelled call, so the instance can idle out", async () => {
    await boot(fixtureToml("fx", 'idle = "0.2s"'));
    const a = await connect("fx");
    const ac = new AbortController();
    const call = a.callTool({ name: "hang", arguments: { ms: 10_000 } }, undefined, { signal: ac.signal });
    await waitFor(() => inflight() === 1, "the call in flight");
    ac.abort();
    await expect(call).rejects.toThrow();
    await waitFor(() => inflight() === 0, "the cancelled call to settle");
    await waitFor(() => events().some((e) => e.startsWith("cancelled")), "the server to see the cancellation");
    await sleep(300);
    expect(await manager.reap()).toEqual(["fx: idle"]);
  });

  it("cancels and settles the calls of a session that goes away", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx");
    const call = a.callTool({ name: "hang", arguments: { ms: 10_000 } }).catch((err: Error) => err);
    await waitFor(() => inflight() === 1, "the call in flight");
    await (a.transport as StreamableHTTPClientTransport).terminateSession();
    await waitFor(() => inflight() === 0, "the orphaned call to settle");
    await waitFor(() => events().some((e) => e.startsWith("cancelled")), "the server to see the cancellation");
    await a.close();
    await call;
  });

  it("cancels a call that runs past call_timeout", async () => {
    await boot(fixtureToml("fx", 'call_timeout = "0.3s"'));
    const a = await connect("fx");
    const started = Date.now();
    await expect(a.callTool({ name: "hang", arguments: { ms: 10_000 } })).rejects.toThrow(/timed out after 0.3s/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(inflight()).toBe(0);
    await waitFor(() => events().some((e) => e.startsWith("cancelled")), "the server to see the cancellation");
  });

  it("applies a manifest reload to open sessions and retires the old instance", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx");
    expect(JSON.parse(await callText(a, "whoami")).account).toBe("personal");

    manifest = parseManifest(fixtureToml("fx", "", "keychain:work-account"));
    expect(JSON.parse(await callText(a, "whoami")).account).toBe("work"); // same session, new definition
    const b = await connect("fx");
    expect(JSON.parse(await callText(b, "whoami")).account).toBe("work");
    expect(await manager.reap()).toEqual(["fx: definition changed"]);
    expect(manager.list()).toHaveLength(1);

    // Settings outside the launch line count too: a new idle limit means a new instance.
    manifest = parseManifest(fixtureToml("fx", 'idle = "45m"', "keychain:work-account"));
    await callText(a, "counter");
    expect(manager.list().map((i) => i.server.idle).sort()).toEqual([1800, 2700]);

    manifest = parseManifest("");
    await expect(a.callTool({ name: "counter", arguments: {} })).rejects.toThrow(/no longer served by mcpd/);
  });

  it("keeps an exclusive lease while its holder has a call in flight", async () => {
    await boot(fixtureToml("fx", 'exclusive = true\nlease = "0.3s"'));
    const a = await connect("fx", { "X-Turno-Pid": String(process.pid) });
    const b = await connect("fx");
    const long = callText(a, "hang", { ms: 1200 });
    await waitFor(() => inflight() === 1, "the long call");
    await sleep(450);
    await expect(b.callTool({ name: "counter", arguments: {} })).rejects.toThrow(/in use by another session/);
    expect(await long).toBe("woke");
  });

  it("keeps a session server past its idle limit while the session's process lives", async () => {
    await boot(fixtureToml("fx", 'scope = "session"\nidle = "0.2s"'));
    const a = await connect("fx", { "X-Turno-Pid": String(process.pid) });
    await callText(a, "echo", { text: "x" });
    await sleep(400);
    expect(await manager.reap()).toEqual([]);
    expect(manager.list()).toHaveLength(1);
  });

  it("accepts request bodies larger than the SDK's 4 MiB default", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx");
    const big = "x".repeat(6 * 1024 * 1024);
    expect((await callText(a, "echo", { text: big })).length).toBe(big.length);
  });

  it("opens a circuit breaker after repeated start failures and shows the server log", async () => {
    await boot(`[server.bad]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", "console.error('boom from bad'); process.exit(1)"]\n`, {
      breakerBaseMs: 60_000,
    });
    for (let i = 0; i < 3; i++) await expect(connect("bad")).rejects.toThrow(/could not start|initialize failed|exited/);
    await waitFor(() => lines(join(sb.home, "logs", "bad.log")).some((l) => l.includes("boom from bad")), "the server log");
    const started = Date.now();
    const err = (await connect("bad").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/failed to start 3 times in a row/);
    expect(err.message).toContain("boom from bad");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("recreates a session it does not know (mcpd restarted) instead of answering 404", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx");
    expect(await callText(a, "counter")).toBe("1");
    const samePort = port;
    await manager.stopAll();
    await gw.close();
    await sleep(100); // let the client notice its sockets were closed
    await boot(fixtureToml("fx"), { port: samePort });
    expect(await callText(a, "echo", { text: "back" })).toBe("back");
    expect(gw.sessionCount()).toBe(1);
  });
});

describe("server-to-client routing (ADR 0016)", () => {
  it("refuses an elicitation it cannot tie to one session instead of guessing", async () => {
    await boot(fixtureToml("fx"));
    const asked: string[] = [];
    const a = await connect("fx", {}, () => (asked.push("A"), { action: "accept", content: { n: "A" } }));
    const b = await connect("fx", {}, () => (asked.push("B"), { action: "accept", content: { n: "B" } }));
    const fromA = callText(a, "askLater", { ms: 300 });
    const fromB = callText(b, "hang", { ms: 1000 });
    expect(JSON.parse(await fromA).error).toMatch(/cannot tell which one/);
    expect(asked).toEqual([]);
    expect(await fromB).toBe("woke");
  });

  it("offers elicitation upstream only when the client supports it", async () => {
    await boot(fixtureToml("fx"));
    const plain = await connect("fx");
    await expect(plain.callTool({ name: "ask", arguments: {} })).rejects.toThrow(/does not support form elicitation/);
  });

  it("passes sampling through to the calling session", async () => {
    await boot(fixtureToml("fx"));
    const a = await connectWith("fx", { sample: () => ({ model: "test-model", role: "assistant", content: { type: "text", text: "pong" } }) });
    expect(JSON.parse(await callText(a, "sample"))).toEqual({ model: "test-model", text: "pong" });
  });

  it("answers roots/list from the project folder, also right after the server starts", async () => {
    await boot(fixtureToml("fx", 'scope = "project"'));
    const dir = join(sb.home, "proj");
    mkdirSync(dir, { recursive: true });
    const a = await connect("fx", { "X-Turno-Cwd-B64": b64(dir) });
    const expected = [{ uri: pathToFileURL(realpathSync(dir)).href, name: "proj" }];
    expect(JSON.parse(await callText(a, "roots")).roots).toEqual(expected);
    await waitFor(() => events().some((e) => e.startsWith("init-roots")), "the startup roots");
    expect(events().find((e) => e.startsWith("init-roots"))).toBe(`init-roots ${JSON.stringify(expected)}`);
  });

  it("does not offer roots to a shared server", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx", { "X-Turno-Cwd-B64": b64(sb.home) });
    expect(JSON.parse(await callText(a, "roots")).error).toMatch(/turno did not offer roots to fx/);
  });

  it("sends resource updates only to the sessions that subscribed", async () => {
    await boot(fixtureToml("fx"));
    const got = { a: 0, b: 0 };
    const a = await connect("fx");
    const b = await connect("fx");
    a.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => void got.a++);
    b.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => void got.b++);
    await a.subscribeResource({ uri: "test://one" });
    await b.subscribeResource({ uri: "test://two" });
    await callText(b, "touch", { uri: "test://one" });
    await waitFor(() => got.a === 1, "the subscriber's update");
    await sleep(100);
    expect(got.b).toBe(0);
    await b.subscribeResource({ uri: "test://one" });
    await a.unsubscribeResource({ uri: "test://one" });
    // One upstream subscription per URI, dropped only when its last subscriber leaves.
    expect(events().filter((e) => e === "subscribe test://one")).toHaveLength(1);
    expect(events().filter((e) => e === "unsubscribe test://one")).toHaveLength(0);
    await b.unsubscribeResource({ uri: "test://one" });
    expect(events().filter((e) => e === "unsubscribe test://one")).toHaveLength(1);
  });
});

describe("session folder (ADR 0016)", () => {
  it("decodes a base64url folder with characters outside Latin-1", async () => {
    await boot(fixtureToml("fx", 'scope = "project"'));
    const dir = join(sb.home, "日本 Café 🚀");
    mkdirSync(dir, { recursive: true });
    const a = await connect("fx", { "X-Turno-Cwd-B64": b64(dir) });
    expect(realpathSync(JSON.parse(await callText(a, "whoami")).cwd)).toBe(realpathSync(dir));
  });

  it("repairs a legacy header that carried raw UTF-8 bytes", () => {
    const path = "/Users/a/Café/日本";
    expect(decodeCwdHeaders({ "x-turno-cwd": Buffer.from(path, "utf8").toString("latin1") })).toBe(path);
    expect(decodeCwdHeaders({ "x-turno-cwd-b64": b64(path), "x-turno-cwd": "/elsewhere" })).toBe(path);
    expect(decodeCwdHeaders({ "x-turno-cwd-b64": "${TURNO_SESSION_CWD_B64}" })).toBeUndefined();
    expect(decodeCwdHeaders({ "x-turno-cwd": "relative/path" })).toBeUndefined();
  });

  it("falls back to the folder of the client process", async () => {
    await boot(fixtureToml("fx", 'scope = "project"'), { realProcessCwd: true });
    const dir = join(sb.home, "from-pid");
    mkdirSync(dir, { recursive: true });
    const child = spawn("sleep", ["30"], { cwd: dir });
    children.push(child);
    const a = await connect("fx", { "X-Turno-Pid": String(child.pid) });
    expect(realpathSync(JSON.parse(await callText(a, "whoami")).cwd)).toBe(realpathSync(dir));
  });

  it("says which folder is missing instead of failing the spawn", async () => {
    await boot(fixtureToml("fx", `cwd = ${JSON.stringify(join(sb.home, "gone"))}`));
    await expect(connect("fx")).rejects.toThrow(/gone \(cwd in mcp.toml\) does not exist/);
  });
});

describe("descriptions (ADR 0016)", () => {
  it("relists after a real start and tells clients when the tools changed", async () => {
    await boot(fixtureToml("fx"));
    const a = await connect("fx");
    await manager.stopAll();
    writeFileSync(toolsFile, "extra_tool\n");
    let changed = 0;
    a.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed++);
    expect((await a.listTools()).tools.map((t) => t.name)).not.toContain("extra_tool"); // still the cache
    await callText(a, "echo", { text: "start it" });
    await waitFor(() => changed === 1, "tools/list_changed");
    expect((await a.listTools()).tools.map((t) => t.name)).toContain("extra_tool");
  });

  it("forwards resources/list to the instance of each project", async () => {
    await boot(fixtureToml("fx", 'scope = "project"'));
    const one = join(sb.home, "one");
    const two = join(sb.home, "two");
    mkdirSync(one);
    mkdirSync(two);
    const a = await connect("fx", { "X-Turno-Cwd-B64": b64(one) });
    const b = await connect("fx", { "X-Turno-Cwd-B64": b64(two) });
    expect((await a.listResources()).resources.map((r) => r.uri)).toEqual([pathToFileURL(realpathSync(one)).href]);
    expect((await b.listResources()).resources.map((r) => r.uri)).toEqual([pathToFileURL(realpathSync(two)).href]);
  });

  it("refreshes through POST /refresh/<server> without a restart", async () => {
    await boot(fixtureToml("fx"));
    const post = (path: string, auth = true) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} });
    const a = await connect("fx");
    await manager.stopAll();
    expect(await (await post("/refresh/fx")).json()).toEqual({ server: "fx", refreshed: [], forgotten: ["fx@default"], errors: {} });
    expect(existsSync(join(sb.home, "cache", "fx@default.json"))).toBe(false);

    await callText(a, "counter"); // running again
    writeFileSync(toolsFile, "late_tool\n");
    await manager.stopAll();
    await callText(a, "counter");
    expect(await (await post("/refresh/fx")).json()).toMatchObject({ refreshed: ["fx@default"], forgotten: [] });
    expect(await (await post("/refresh")).json()).toMatchObject({ servers: { fx: { refreshed: ["fx@default"] } } });
    expect((await post("/refresh/fx", false)).status).toBe(401);
    expect((await post("/refresh/nope")).status).toBe(404);
  });
});

/** A remote MCP server that can forget its sessions, over Streamable HTTP or legacy SSE. */
async function remote(kind: "http" | "sse"): Promise<{ url: string; forget(): void; auth: string[]; close(): Promise<void> }> {
  const auth: string[] = [];
  const make = () => {
    const s = new Server({ name: "remote", version: "1" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping2", inputSchema: { type: "object" as const, properties: {} } }] }));
    s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
    return s;
  };
  const http = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();
  const server: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    auth.push(String(req.headers.authorization ?? ""));
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (kind === "sse") {
      if (req.method === "GET" && url.pathname === "/sse") {
        const t = new SSEServerTransport("/messages", res);
        sse.set(t.sessionId, t);
        await make().connect(t);
        return;
      }
      const t = sse.get(url.searchParams.get("sessionId") ?? "");
      if (!t) return void res.writeHead(404).end();
      await t.handlePostMessage(req, res);
      return;
    }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid) {
      const t = http.get(sid);
      if (!t) return void res.writeHead(404).end("Session not found");
      await t.handleRequest(req, res);
      return;
    }
    const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void http.set(id, t),
    });
    await make().connect(t);
    await t.handleRequest(req, res);
  });
  const p = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
  const handle = {
    url: `http://127.0.0.1:${p}/${kind === "sse" ? "sse" : "mcp"}`,
    auth,
    forget: () => http.clear(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  remotes.push(handle);
  return handle;
}

describe("remote proxies (ADR 0016)", () => {
  it("reconnects once when the remote server forgot the session", async () => {
    const r = await remote("http");
    await boot(`[server.rem]\nurl = ${JSON.stringify(r.url)}\nheaders = { Authorization = "keychain:rem-token" }\n`);
    const a = await connect("rem");
    expect(await callText(a, "ping2")).toBe("pong");
    r.forget();
    expect(await callText(a, "ping2")).toBe("pong");
    expect(r.auth.every((h) => h === "Bearer remote-secret")).toBe(true);
  });

  it("speaks legacy SSE when the entry says type = \"sse\"", async () => {
    const r = await remote("sse");
    await boot(`[server.rem]\nurl = ${JSON.stringify(r.url)}\ntype = "sse"\nheaders = { Authorization = "keychain:rem-token" }\n`);
    const a = await connect("rem");
    expect(await callText(a, "ping2")).toBe("pong");
    expect(r.auth.every((h) => h === "Bearer remote-secret")).toBe(true);
  });
});

describe("server logs", () => {
  it("rotates by size while the server runs", () => {
    const file = join(sb.home, "logs", "x.log");
    const log = new RotatingLog(file, 10);
    log.write("12345678\n");
    log.write("abcdefgh\n");
    log.end();
    expect(readFileSync(`${file}.1`, "utf8")).toBe("12345678\n");
    expect(readFileSync(file, "utf8")).toBe("abcdefgh\n");
  });
});
