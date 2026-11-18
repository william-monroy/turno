import { type ChildProcess, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Manifest, parseManifest } from "../src/core/manifest.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector } from "../src/mcpd/connectors.js";
import type { CallEvent } from "../src/mcpd/calllog.js";
import { Gateway, type GatewayOptions } from "../src/mcpd/gateway.js";
import { InstanceManager } from "../src/mcpd/instances.js";
import { ErrorCode } from "../src/mcpd/jsonrpc.js";
import { type CallStage, SESSION_META } from "../src/mcpd/middleware.js";
import {
  MODERN_PROTOCOL_VERSION,
  StatelessClient,
  decodeHeaderValue,
  modernErrorCode,
  paramHeaderProblem,
  readJsonBody,
} from "../src/mcpd/modern.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));
const TOKEN = "test-token";
const V = MODERN_PROTOCOL_VERSION;
const META = "io.modelcontextprotocol/";

let sb: Sandbox;
let gw: Gateway | undefined;
let manager: InstanceManager | undefined;
let port: number;
let manifest: Manifest;
let eventsLog: string;
let toolsFile: string;
let children: ChildProcess[] = [];
let legacy: Client[] = [];
let skew = 0;

function fixtureToml(name: string, extra = ""): string {
  const env = `{ FIXTURE_EVENTS = ${JSON.stringify(eventsLog)}, FIXTURE_TOOLS_FILE = ${JSON.stringify(toolsFile)}, FIXTURE_ACCOUNT = "plain" }`;
  return `[server.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\nenv = ${env}\n${extra}\n`;
}

async function boot(toml: string, extra: Partial<GatewayOptions> = {}): Promise<void> {
  manifest = parseManifest(toml);
  skew = 0;
  manager = new InstanceManager({
    now: () => Date.now() + skew,
    cache: new DescriptionCache(join(sb.home, "cache")),
    connector: new DefaultConnector({
      resolve: async (v) => v,
      serversDir: join(sb.home, "servers"),
      logsDir: join(sb.home, "logs"),
      baseEnv: { PATH: process.env.PATH ?? "" },
    }),
    home: sb.home,
  });
  gw = new Gateway({
    manager,
    manifest: () => manifest,
    token: TOKEN,
    clientRequestTimeoutMs: 5000,
    processCwd: async () => undefined,
    ...extra,
  });
  port = await gw.listen(0);
}

async function shutdown(): Promise<void> {
  for (const c of legacy) await c.close().catch(() => {});
  legacy = [];
  await manager?.stopAll();
  await gw?.close();
  gw = undefined;
  manager = undefined;
}

interface PostOpts {
  profile?: string;
  version?: string;
  headers?: Record<string, string>;
  /** Headers to leave out of the defaults. */
  omit?: string[];
  meta?: Record<string, unknown>;
  /** Replace the whole _meta (to test missing fields). */
  rawMeta?: Record<string, unknown>;
  signal?: AbortSignal;
}

function defaultHeaders(
  msg: { method: string; params?: Record<string, unknown> },
  o: PostOpts,
): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${profileToken(TOKEN, o.profile ?? "default")}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": o.version ?? V,
    "Mcp-Method": msg.method,
  };
  const name = msg.params?.name ?? msg.params?.uri;
  if (typeof name === "string" && ["tools/call", "prompts/get", "resources/read"].includes(msg.method))
    h["Mcp-Name"] = name;
  for (const k of o.omit ?? []) delete h[k];
  return { ...h, ...(o.headers ?? {}) };
}

/** POST one modern (2026-07-28) request, with the headers and _meta a conforming client sends. */
function post(
  server: string,
  method: string,
  params: Record<string, unknown> = {},
  o: PostOpts = {},
  id: number | string = 1,
): Promise<Response> {
  const meta = o.rawMeta ?? {
    [`${META}protocolVersion`]: o.version ?? V,
    [`${META}clientInfo`]: { name: "modern-test", version: "1" },
    [`${META}clientCapabilities`]: {},
    ...(o.meta ?? {}),
  };
  const msg = { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } };
  return fetch(`http://127.0.0.1:${port}/mcp/${server}`, {
    method: "POST",
    headers: defaultHeaders(msg, o),
    body: JSON.stringify(msg),
    ...(o.signal ? { signal: o.signal } : {}),
  });
}

/** Every JSON-RPC message of a response: one for JSON, each data line for SSE. */
async function messages(res: Response): Promise<Record<string, any>[]> {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return text ? [JSON.parse(text)] : [];
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)));
}

async function rpc(server: string, method: string, params: Record<string, unknown> = {}, o: PostOpts = {}) {
  const res = await post(server, method, params, o);
  const all = await messages(res);
  return { status: res.status, res, all, last: all[all.length - 1] ?? {} };
}

/** Open a subscriptions/listen stream and collect what arrives on it. */
async function listen(id: string | number, notifications: Record<string, unknown>) {
  const abort = new AbortController();
  const res = await post("fx", "subscriptions/listen", { notifications }, { signal: abort.signal }, id);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const got: Record<string, any>[] = [];
  const done = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (end) return;
      buf += dec.decode(value, { stream: true });
      let i = buf.indexOf("\n\n");
      while (i >= 0) {
        const data = buf
          .slice(0, i)
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (data) got.push(JSON.parse(data.slice(5)));
        buf = buf.slice(i + 2);
        i = buf.indexOf("\n\n");
      }
    }
  })();
  return {
    got,
    done,
    async close() {
      abort.abort();
      await done;
    },
  };
}

async function connectLegacy(server: string): Promise<Client> {
  const client = new Client({ name: "legacy", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${server}`), {
      requestInit: { headers: { Authorization: `Bearer ${profileToken(TOKEN, "default")}` } },
    }),
  );
  legacy.push(client);
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what = "condition", ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const events = () => {
  try {
    return readFileSync(eventsLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const inflight = () => (manager?.list() ?? []).reduce((n, i) => n + i.upstream.inflight, 0);

beforeEach(() => {
  sb = sandbox();
  eventsLog = join(sb.home, "events.log");
  toolsFile = join(sb.home, "tools.txt");
  children = [];
});

afterEach(async () => {
  for (const ch of children) ch.kill("SIGKILL");
  await shutdown();
  sb.cleanup();
});

describe("MCP 2026-07-28 (stateless) requests", () => {
  it("answers server/discover with both protocol eras, identity and caching hints", async () => {
    await boot(fixtureToml("fx"));
    const r = await rpc("fx", "server/discover");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("mcp-session-id")).toBeNull();
    const result = r.last.result;
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toEqual(expect.arrayContaining([V, "2025-11-25"]));
    expect(result.supportedVersions[0]).toBe(V);
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toBe("fixture instructions");
    expect(result._meta[`${META}serverInfo`]).toEqual({ name: "fixture", version: "1.0.0" });
    expect(result.cacheScope).toBe("private");
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(gw?.sessionCount()).toBe(0);
  });

  it("serves tools/list from the cache with ttlMs and cacheScope, and only trusts it after a relist", async () => {
    await boot(fixtureToml("fx"));
    const first = await rpc("fx", "tools/list");
    expect(first.last.result.tools.map((t: { name: string }) => t.name)).toContain("echo");
    expect(first.last.result.resultType).toBe("complete");
    expect(first.last.result.cacheScope).toBe("private");
    expect(first.last.result.ttlMs).toBe(300_000); // learned from a running server just now

    // A new mcpd that only has the description on disk: the list may be stale until the server starts.
    await shutdown();
    await boot(fixtureToml("fx"));
    const cold = await rpc("fx", "tools/list");
    expect(cold.last.result.tools.length).toBeGreaterThan(0);
    expect(manager?.list()).toHaveLength(0); // answered without starting the server
    expect(cold.last.result.ttlMs).toBe(0);

    await rpc("fx", "tools/call", { name: "echo", arguments: { text: "x" } });
    await manager?.list()[0]?.described;
    const warm = await rpc("fx", "tools/list");
    expect(warm.last.result.ttlMs).toBe(300_000);
  });

  it("applies the profile's tool filter to tools/list and tools/call", async () => {
    await boot(fixtureToml("fx", '[server.fx.tools]\ndeny = ["counter"]'));
    const list = await rpc("fx", "tools/list");
    expect(list.last.result.tools.map((t: { name: string }) => t.name)).not.toContain("counter");
    const call = await rpc("fx", "tools/call", { name: "counter", arguments: {} });
    expect(call.last.error.code).toBe(-32602);
  });

  it("relays tools/call without a session, next to a 2025-11-25 session on the same server", async () => {
    await boot(fixtureToml("fx"));
    const old = await connectLegacy("fx");
    const r = await rpc(
      "fx",
      "tools/call",
      { name: "counter", arguments: {} },
      { headers: { "X-Turno-Pid": String(process.pid) } },
    );
    expect(r.status).toBe(200);
    expect(r.res.headers.get("mcp-session-id")).toBeNull();
    expect(r.last.result.resultType).toBe("complete");
    expect(r.last.result.content[0].text).toBe("1");
    expect(r.last.result._meta[`${META}serverInfo`]).toEqual({ name: "fixture", version: "1.0.0" });
    const again = (await old.callTool({ name: "counter", arguments: {} })) as { content: { text: string }[] };
    expect(again.content[0]?.text).toBe("2"); // the same shared process
    expect(gw?.sessionCount()).toBe(1);
    // The stateless agent shows up in /status like a session does.
    const status = gw?.status() as { agents: { pid: number | null; agent: string | null }[] };
    expect(status.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ pid: process.pid, agent: "modern-test" })]),
    );
  });

  it("still serves initialize as a 2025-11-25 session when a client sends a newer version header", async () => {
    await boot(fixtureToml("fx"));
    const msg = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dual", version: "1" } },
    };
    const res = await fetch(`http://127.0.0.1:${port}/mcp/fx`, {
      method: "POST",
      headers: defaultHeaders(msg, {}),
      body: JSON.stringify(msg),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toMatch(/^[0-9a-f-]{36}$/);
    const [m] = await messages(res);
    expect(m?.result.protocolVersion).toBe("2025-11-25");
  });

  it("ignores an Mcp-Session-Id on a 2026-07-28 request", async () => {
    await boot(fixtureToml("fx"));
    const r = await rpc(
      "fx",
      "tools/list",
      {},
      { headers: { "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000" } },
    );
    expect(r.status).toBe(200);
    expect(r.last.result.tools.length).toBeGreaterThan(0);
    expect(gw?.sessionCount()).toBe(0);
  });

  it("rejects headers that disagree with the body (HeaderMismatch, 400)", async () => {
    await boot(fixtureToml("fx"));
    const noMethod = await rpc("fx", "tools/list", {}, { omit: ["Mcp-Method"] });
    expect(noMethod.status).toBe(400);
    expect(noMethod.last.error.code).toBe(-32020);

    const wrongMethod = await rpc("fx", "tools/list", {}, { headers: { "Mcp-Method": "prompts/list" } });
    expect(wrongMethod.status).toBe(400);
    expect(wrongMethod.last.error.code).toBe(-32020);

    const noName = await rpc("fx", "tools/call", { name: "echo", arguments: { text: "a" } }, { omit: ["Mcp-Name"] });
    expect(noName.status).toBe(400);
    expect(noName.last.error.code).toBe(-32020);

    const wrongName = await rpc(
      "fx",
      "tools/call",
      { name: "echo", arguments: { text: "a" } },
      { headers: { "Mcp-Name": "counter" } },
    );
    expect(wrongName.status).toBe(400);
    expect(wrongName.last.error.message).toMatch(/Mcp-Name/);

    const metaVersion = await rpc("fx", "tools/list", {}, { meta: { [`${META}protocolVersion`]: "2025-11-25" } });
    expect(metaVersion.status).toBe(400);
    expect(metaVersion.last.error.code).toBe(-32020);
    expect(manager?.list()).toHaveLength(0); // nothing was started for a refused request
  });

  it("accepts a Base64-encoded Mcp-Name", async () => {
    await boot(fixtureToml("fx"));
    const encoded = `=?base64?${Buffer.from("echo").toString("base64")}?=`;
    const r = await rpc(
      "fx",
      "tools/call",
      { name: "echo", arguments: { text: "b64" } },
      { headers: { "Mcp-Name": encoded } },
    );
    expect(r.status).toBe(200);
    expect(r.last.result.content[0].text).toBe("b64");
  });

  it("rejects a request without the required _meta fields (-32602, 400)", async () => {
    await boot(fixtureToml("fx"));
    const r = await rpc("fx", "tools/list", {}, { rawMeta: { [`${META}protocolVersion`]: V } });
    expect(r.status).toBe(400);
    expect(r.last.error.code).toBe(-32602);
    expect(r.last.error.message).toMatch(/clientCapabilities/);
  });

  it("answers an unknown protocol version with UnsupportedProtocolVersion listing both eras", async () => {
    await boot(fixtureToml("fx"));
    const r = await rpc("fx", "tools/list", {}, { version: "2099-01-01" });
    expect(r.status).toBe(400);
    expect(r.last.error.code).toBe(-32022);
    expect(r.last.error.data.supported).toEqual(expect.arrayContaining([V, "2025-11-25"]));
    expect(r.last.error.data.requested).toBe("2099-01-01");
  });

  it("answers unknown and removed methods with 404 and -32601", async () => {
    await boot(fixtureToml("fx"));
    for (const method of ["nope/nothing", "logging/setLevel", "resources/subscribe"]) {
      const r = await rpc("fx", method, method === "logging/setLevel" ? { level: "info" } : { uri: "file:///x" });
      expect(r.status, method).toBe(404);
      expect(r.last.error.code, method).toBe(-32601);
    }
  });

  it("accepts a notification with 202 and no body", async () => {
    await boot(fixtureToml("fx"));
    const msg = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } };
    const res = await fetch(`http://127.0.0.1:${port}/mcp/fx`, {
      method: "POST",
      headers: defaultHeaders(msg, {}),
      body: JSON.stringify(msg),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("streams progress on the request's own SSE response", async () => {
    await boot(fixtureToml("fx"));
    const r = await rpc(
      "fx",
      "tools/call",
      { name: "slow", arguments: { steps: 3 } },
      { meta: { progressToken: "tok-1" } },
    );
    expect(r.res.headers.get("content-type")).toContain("text/event-stream");
    const progress = r.all.filter((m) => m.method === "notifications/progress");
    expect(progress.map((m) => m.params.progress)).toEqual([1, 2, 3]);
    expect(progress.every((m) => m.params.progressToken === "tok-1")).toBe(true);
    expect(r.last.id).toBe(1);
    expect(r.last.result.resultType).toBe("complete");
  });

  it("cancels the upstream call when the client closes the response", async () => {
    await boot(fixtureToml("fx"));
    await rpc("fx", "tools/call", { name: "echo", arguments: { text: "warm" } });
    const abort = new AbortController();
    const pending = post(
      "fx",
      "tools/call",
      { name: "hang", arguments: { ms: 10_000 } },
      { signal: abort.signal },
    ).catch(() => undefined);
    await waitFor(() => inflight() === 1, "the call to reach the server");
    abort.abort();
    await pending;
    await waitFor(() => events().some((e) => e.startsWith("cancelled")), "the server to see the cancellation");
    await waitFor(() => inflight() === 0, "the call to settle");
  });

  it("refuses server-to-client requests for a stateless client instead of hanging", async () => {
    await boot(fixtureToml("fx"));
    const started = Date.now();
    // Even a client that declares sampling cannot be asked mid-call: mcpd does not bridge to MRTR yet.
    const r = await rpc(
      "fx",
      "tools/call",
      { name: "sample", arguments: {} },
      { meta: { [`${META}clientCapabilities`]: { sampling: {} } } },
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.last.result.content[0].text).toMatch(/error/);
  });

  it("answers roots/list itself for a project server, from the folder headers", async () => {
    await boot(fixtureToml("fx", 'scope = "project"'));
    const dir = join(sb.home, "proj");
    mkdirSync(dir, { recursive: true });
    const r = await rpc(
      "fx",
      "tools/call",
      { name: "roots", arguments: {} },
      { headers: { "X-Turno-Cwd-B64": Buffer.from(dir).toString("base64url") } },
    );
    expect(r.last.result.content[0].text).toContain("proj");
  });

  it("delivers resource updates on subscriptions/listen and unsubscribes when the stream closes", async () => {
    await boot(fixtureToml("fx"));
    await rpc("fx", "tools/call", { name: "echo", arguments: { text: "start" } });
    await manager?.list()[0]?.described;

    const sub = await listen("sub-1", {
      toolsListChanged: true,
      resourceSubscriptions: ["file:///watched"],
      unknownThing: true,
    });
    await waitFor(() => sub.got.length >= 1, "the acknowledgment");
    expect(sub.got[0]?.method).toBe("notifications/subscriptions/acknowledged");
    expect(sub.got[0]?.params._meta[`${META}subscriptionId`]).toBe("sub-1");
    expect(sub.got[0]?.params.notifications).toEqual({
      toolsListChanged: true,
      resourceSubscriptions: ["file:///watched"],
    });
    await waitFor(() => events().includes("subscribe file:///watched"), "the upstream subscription");

    await rpc("fx", "tools/call", { name: "touch", arguments: { uri: "file:///watched" } });
    await rpc("fx", "tools/call", { name: "touch", arguments: { uri: "file:///other" } });
    await waitFor(() => sub.got.some((m) => m.method === "notifications/resources/updated"), "the resource update");
    const updates = sub.got.filter((m) => m.method === "notifications/resources/updated");
    expect(updates.map((m) => m.params.uri)).toEqual(["file:///watched"]);
    expect(updates[0]?.params._meta[`${META}subscriptionId`]).toBe("sub-1");

    await sub.close();
    await waitFor(() => events().includes("unsubscribe file:///watched"), "the upstream unsubscribe");
  });

  it("tells a listen stream when the tool list changes", async () => {
    await boot(fixtureToml("fx"));
    await rpc("fx", "tools/call", { name: "echo", arguments: { text: "start" } });
    await manager?.list()[0]?.described;
    const sub = await listen(7, { toolsListChanged: true, promptsListChanged: true });
    await waitFor(() => sub.got.length >= 1, "the acknowledgment");
    expect(sub.got[0]?.params.notifications).toEqual({ toolsListChanged: true }); // the fixture has no prompts

    // The fixture reads its extra tools at start: change them and restart it.
    writeFileSync(toolsFile, "brand_new\n");
    await manager?.stopAll();
    await rpc("fx", "tools/call", { name: "echo", arguments: { text: "restart" } });
    await waitFor(() => sub.got.some((m) => m.method === "notifications/tools/list_changed"), "the list change");
    expect(
      sub.got.find((m) => m.method === "notifications/tools/list_changed")?.params._meta[`${META}subscriptionId`],
    ).toBe(7);
    await sub.close();
  });

  it("ends listen streams with a final result when mcpd stops", async () => {
    await boot(fixtureToml("fx"));
    const sub = await listen("bye", { toolsListChanged: true });
    await waitFor(() => sub.got.length >= 1, "the acknowledgment");
    await gw?.close();
    await sub.done;
    const last = sub.got[sub.got.length - 1];
    expect(last?.id).toBe("bye");
    expect(last?.result).toEqual({ resultType: "complete", _meta: { [`${META}subscriptionId`]: "bye" } });
  });

  it("keeps one client per agent process, so an exclusive lease holds across its requests", async () => {
    await boot(fixtureToml("fx", "exclusive = true"));
    const other = spawn("sleep", ["30"]);
    children.push(other);
    const mine = { headers: { "X-Turno-Pid": String(process.pid) } };
    expect((await rpc("fx", "tools/call", { name: "counter", arguments: {} }, mine)).last.result.content[0].text).toBe(
      "1",
    );
    expect((await rpc("fx", "tools/call", { name: "counter", arguments: {} }, mine)).last.result.content[0].text).toBe(
      "2",
    );
    const theirs = await rpc(
      "fx",
      "tools/call",
      { name: "counter", arguments: {} },
      { headers: { "X-Turno-Pid": String(other.pid) } },
    );
    expect(theirs.last.error.message).toMatch(/in use by another session/);

    // The holder's process exits: pruning drops its client and the lease with it.
    gw?.pruneSessions((pid) => pid !== process.pid);
    const after = await rpc(
      "fx",
      "tools/call",
      { name: "counter", arguments: {} },
      { headers: { "X-Turno-Pid": String(other.pid) } },
    );
    expect(after.last.result.content[0].text).toBe("3");
  });
});

describe("the call middleware on both protocol paths (ADR 0047)", () => {
  /** A test-only stage: records the tool of every call that reaches it. */
  const probe = (seen: string[]): CallStage => ({
    name: "test-probe",
    run: (call, next) => (seen.push(call.tool), next(call)),
  });
  const metaOf = (text: string) => JSON.parse(text) as Record<string, unknown> | null;

  it("sends every tools/call through one pipeline: filter first, then the opt-in stages, the call log and the session id", async () => {
    const seen: string[] = [];
    const logged: CallEvent[] = [];
    await boot(fixtureToml("fx", 'tools = { deny = ["hang"] }'), {
      callStages: [probe(seen)],
      callLog: () => (e) => logged.push(e),
    });
    expect(gw?.calls.names()).toEqual(["filter", "test-probe", "calllog", "session"]);

    const old = await connectLegacy("fx");
    await old.callTool({ name: "echo", arguments: { text: "a" } });
    await expect(old.callTool({ name: "hang", arguments: {} })).rejects.toThrow(
      /tool hang of fx is not available to profile default \(tools.allow \/ tools.deny in mcp.toml\)/,
    );
    expect(
      (await rpc("fx", "tools/call", { name: "echo", arguments: { text: "b" } })).last.result.content[0].text,
    ).toBe("b");
    const refused = await rpc("fx", "tools/call", { name: "hang", arguments: {} });
    expect(refused.last.error).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringMatching(/not available to profile default/),
    });

    expect(seen).toEqual(["echo", "echo"]);
    expect(logged.map((e) => [e.method, e.params?.name, e.variant])).toEqual([
      ["tools/call", "echo", "default"],
      ["tools/call", "echo", "default"],
    ]);
    // The call log keeps the arguments as the client sent them, without the session id.
    expect(logged.every((e) => !JSON.stringify(e.params).includes(SESSION_META))).toBe(true);
    // Other methods do not go through it.
    await old.listTools();
    await rpc("fx", "tools/list");
    expect(seen).toHaveLength(2);
  });

  it("puts one stable id per client session in _meta for the server, on both paths", async () => {
    await boot(fixtureToml("fx"));
    const a = await connectLegacy("fx");
    const b = await connectLegacy("fx");
    const callMeta = async (c: Client, meta?: Record<string, unknown>) =>
      metaOf(
        (
          (await c.callTool({ name: "meta", arguments: {}, ...(meta ? { _meta: meta } : {}) })) as {
            content: { text: string }[];
          }
        ).content[0]!.text,
      );
    const a1 = await callMeta(a);
    const a2 = await callMeta(a, { [SESSION_META]: "forged", progressToken: "p1" });
    const b1 = await callMeta(b);
    const id = a1?.[SESSION_META];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a2?.[SESSION_META]).toBe(id);
    expect(a2).toHaveProperty("progressToken");
    expect(b1?.[SESSION_META]).not.toBe(id);
    // Not the Mcp-Session-Id of either session.
    const sessionIds = [
      (a as unknown as { transport: { sessionId?: string } }).transport.sessionId,
      (b as unknown as { transport: { sessionId?: string } }).transport.sessionId,
    ];
    expect(sessionIds).not.toContain(id);

    const modern = async (pid: number) =>
      metaOf(
        (await rpc("fx", "tools/call", { name: "meta", arguments: {} }, { headers: { "X-Turno-Pid": String(pid) } }))
          .last.result.content[0].text,
      );
    const m1 = await modern(process.pid);
    const m2 = await modern(process.pid);
    const other = spawn("sleep", ["30"]);
    children.push(other);
    const m3 = await modern(other.pid!);
    expect(m1?.[SESSION_META]).toMatch(/^[0-9a-f-]{36}$/);
    expect(m2?.[SESSION_META]).toBe(m1?.[SESSION_META]);
    expect(m3?.[SESSION_META]).not.toBe(m1?.[SESSION_META]);
    expect([id, b1?.[SESSION_META]]).not.toContain(m1?.[SESSION_META]);
    // The protocol fields of 2026-07-28 stay in mcpd; only turno's key reaches the server.
    expect(Object.keys(m1 ?? {})).toEqual([SESSION_META]);
  });
});

describe("2026-07-28 helpers", () => {
  it("decodes the Base64 sentinel and leaves plain values alone", () => {
    expect(decodeHeaderValue("plain")).toBe("plain");
    expect(decodeHeaderValue(`=?base64?${Buffer.from("Hello, 世界").toString("base64")}?=`)).toBe("Hello, 世界");
    expect(decodeHeaderValue("=?base64?***?=")).toBeUndefined();
  });

  it("validates x-mcp-header parameters against the arguments", () => {
    const tool = {
      name: "sql",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          limit: { type: "integer", "x-mcp-header": "Limit" },
          opts: { type: "object", properties: { dry: { type: "boolean", "x-mcp-header": "Dry" } } },
          list: {
            type: "array",
            items: { type: "object", properties: { x: { type: "string", "x-mcp-header": "Ignored" } } },
          },
          query: { type: "string" },
        },
      },
    };
    const ok = { "mcp-param-region": "us-west1", "mcp-param-limit": "42", "mcp-param-dry": "true" };
    expect(
      paramHeaderProblem(tool, { region: "us-west1", limit: 42, opts: { dry: true }, query: "q" }, ok),
    ).toBeUndefined();
    expect(
      paramHeaderProblem(
        tool,
        { region: "us-west1", limit: 42, opts: { dry: true } },
        { ...ok, "mcp-param-limit": "42.0" },
      ),
    ).toBeUndefined();
    expect(paramHeaderProblem(tool, { region: "eu", limit: 42, opts: { dry: true } }, ok)).toMatch(/Mcp-Param-Region/);
    expect(
      paramHeaderProblem(
        tool,
        { region: "us-west1", opts: { dry: true } },
        { "mcp-param-region": "us-west1", "mcp-param-dry": "true" },
      ),
    ).toBeUndefined();
    expect(paramHeaderProblem(tool, { region: "us-west1", limit: 1 }, { "mcp-param-region": "us-west1" })).toMatch(
      /missing Mcp-Param-Limit/,
    );
    expect(
      paramHeaderProblem(
        tool,
        { region: "Hello, 世界" },
        { "mcp-param-region": `=?base64?${Buffer.from("Hello, 世界").toString("base64")}?=` },
      ),
    ).toBeUndefined();
    expect(paramHeaderProblem({ name: "plain", inputSchema: { type: "object" } }, { a: 1 }, {})).toBeUndefined();
  });

  it("sends log messages only to a request that asked for a level, at or above it", () => {
    const written: string[] = [];
    const res = {
      writableEnded: false,
      destroyed: false,
      write: (t: string) => written.push(t),
    } as unknown as ServerResponse;
    const c = new StatelessClient({ serverName: "fx", sessionId: "stateless-1" });
    c.calls.set("h1", { res, stream: true, logLevel: "warning" });
    c.calls.set("h2", { res, stream: true });
    c.notify("notifications/message", { level: "info", data: "quiet" }, "h1");
    c.notify("notifications/message", { level: "error", data: "loud" }, "h1");
    c.notify("notifications/message", { level: "error", data: "unasked" }, "h2");
    c.notify("notifications/progress", { progressToken: "t", progress: 1 }, "h2");
    expect(written.join("")).toContain("loud");
    expect(written.join("")).not.toContain("quiet");
    expect(written.join("")).not.toContain("unasked");
    expect(written.join("")).toContain("notifications/progress");
    expect(c.supports("elicitation")).toBe(false);
    expect(c.supports("tools")).toBe(true);
  });

  it("refuses a body over the limit and one that is not JSON", async () => {
    const body = (text: string, length?: number) => {
      const s = new PassThrough() as unknown as IncomingMessage & PassThrough;
      (s as unknown as { headers: Record<string, string> }).headers =
        length !== undefined ? { "content-length": String(length) } : {};
      queueMicrotask(() => s.end(text));
      return s;
    };
    expect(await readJsonBody(body("{}", 10_000), 1024)).toMatchObject({ status: 413 });
    expect(await readJsonBody(body("x".repeat(2048)), 1024)).toMatchObject({ status: 413 });
    expect(await readJsonBody(body("{nope"), 1024)).toMatchObject({ status: 400, code: -32700 });
    expect(await readJsonBody(body('{"a":1}'), 1024)).toEqual({ value: { a: 1 } });
  });

  it("maps error codes the 2026-07-28 revision forbids", () => {
    expect(modernErrorCode(-32002, "resources/read")).toBe(-32602);
    expect(modernErrorCode(-32002, "tools/call")).toBe(-32603);
    expect(modernErrorCode(-32042, "tools/call")).toBe(-32603);
    expect(modernErrorCode(-32603, "tools/call")).toBe(-32603);
    expect(modernErrorCode(-32003, "tools/call")).toBe(-32003);
  });
});
