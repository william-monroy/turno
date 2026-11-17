import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSavings, top } from "../src/cli/commands/mcp-observe.js";
import { main } from "../src/cli/main.js";
import { parseConfig } from "../src/core/config.js";
import { parseManifest } from "../src/core/manifest.js";
import { type CallEvent, type CallRecord, createCallLog, followCalls, readCalls, redact, toRecord } from "../src/mcpd/calllog.js";
import { type RunningDaemon, readToken, startDaemon } from "../src/mcpd/daemon.js";
import { ErrorCode } from "../src/mcpd/jsonrpc.js";
import { RssSampler, parsePs, procfsTable, processTable, treeRss } from "../src/mcpd/rss.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { waitFor } from "./helpers/wait.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));

let sb: Sandbox;
let daemons: RunningDaemon[] = [];
let clients: Client[] = [];

beforeEach(() => {
  sb = sandbox();
  daemons = [];
  clients = [];
});

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const d of daemons) await d.stop().catch(() => {});
  sb.cleanup();
});

const callsFile = () => join(sb.home, ".local/state/turno/logs/calls.jsonl");

function event(over: Partial<CallEvent> = {}): CallEvent {
  return {
    ctx: { serverName: "fx", sessionId: "s1", profile: "work", pid: 4242, clientName: "claude-code" },
    method: "tools/call",
    params: { name: "echo", arguments: { text: "top secret argument" } },
    variant: "default",
    outcome: { result: { content: [{ type: "text", text: "top secret result" }] } },
    startedAt: Date.parse("2026-11-16T10:00:00.000Z"),
    durationMs: 12.4,
    ...over,
  };
}

async function run(args: string[], env = sb.env) {
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n"), io };
}

/** A real mcpd in this process, on a free port, with the fixture server in mcp.toml. */
async function daemon(config = ""): Promise<RunningDaemon> {
  sb.write(".config/turno/config.toml", config);
  sb.write(".config/turno/mcp.toml", `[server.fx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\ncall_timeout = "0.5s"\n`);
  const d = await startDaemon({ env: sb.env, port: 0 });
  daemons.push(d);
  return d;
}

async function connect(d: RunningDaemon, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "observer-test", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${d.port}/mcp/fx`), {
    // Sessions authenticate with a profile token (ADR 0023); the master token only opens /status.
    requestInit: { headers: { Authorization: `Bearer ${profileToken(readToken(sb.env)!, headers["X-Turno-Profile"] ?? "default")}`, ...headers } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("call records (ADR 0026)", () => {
  it("keeps who, what, how long and how big, never the arguments or the result", () => {
    const r = toRecord(event())!;
    expect(r).toEqual({
      time: "2026-11-16T10:00:00.000Z",
      agent: "claude-code",
      profile: "work",
      pid: 4242,
      server: "fx",
      variant: "default",
      tool: "echo",
      durationMs: 12,
      outcome: "ok",
      requestBytes: expect.any(Number),
      responseBytes: expect.any(Number),
    });
    expect(r.requestBytes).toBeGreaterThan(20);
    expect(r.responseBytes).toBeGreaterThan(20);
    expect(JSON.stringify(r)).not.toContain("top secret");
  });

  it("tells ok, error, cancelled and timeout apart and redacts error texts", () => {
    const err = (code: number, message: string) => toRecord(event({ outcome: { error: { code, message } } }))!;
    expect(err(ErrorCode.RequestCancelled, "cancelled by the client").outcome).toBe("cancelled");
    expect(err(ErrorCode.RequestTimeout, "fx: tools/call timed out after 1s").outcome).toBe("timeout");
    const failed = err(ErrorCode.Unavailable, "upstream said: Authorization: Bearer abcdefghijklmnop0123 api_key=hunter2hunter2");
    expect(failed.outcome).toBe("error");
    expect(failed.error).not.toContain("abcdefghijklmnop0123");
    expect(failed.error).not.toContain("hunter2");
    expect(err(ErrorCode.Internal, "x".repeat(1000)).error).toHaveLength(300);
    const toolError = toRecord(event({ outcome: { result: { isError: true, content: [{ type: "text", text: "secret detail" }] } } }))!;
    expect(toolError.outcome).toBe("error");
    expect(JSON.stringify(toolError)).not.toContain("secret detail");
    expect(toRecord(event({ method: "resources/read" }))).toBeUndefined();
  });

  it("redacts tokens but keeps ordinary words and paths", () => {
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123")).not.toContain("ghp_");
    expect(redact("key sk-live-0123456789abcdef")).toBe("key [redacted]");
    expect(redact("cannot open /Users/someone/projects/a_really_long_folder_name/file.txt")).toContain("a_really_long_folder_name");
    expect(redact("hash 3f2a9c8e7d6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f")).toBe("hash [redacted]");
  });

  it("appends JSON lines with mode 600, rotates by size and reads the last records across files", () => {
    const file = join(sb.home, "state", "calls.jsonl");
    const log = createCallLog(file, { maxBytes: 1200, keep: 2 });
    for (let i = 0; i < 12; i++) log.record(event({ ctx: { serverName: i % 2 ? "a" : "b", sessionId: "s", profile: i % 3 ? "work" : "personal" }, params: { name: `t${i}` } }));
    log.record(event({ method: "ping" }));
    log.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    const last = readCalls(file, 4);
    expect(last.map((r) => r.tool)).toEqual(["t8", "t9", "t10", "t11"]);
    expect(readCalls(file, 3, { server: "a" }).map((r) => r.tool)).toEqual(["t7", "t9", "t11"]);
    expect(readCalls(file, 2, { server: "a", profile: "personal" }).map((r) => r.tool)).toEqual(["t3", "t9"]);
  });

  it("never throws when the disk refuses, and says so once", () => {
    const blocked = join(sb.home, "file-not-dir");
    writeFileSync(blocked, "");
    const errors: string[] = [];
    const log = createCallLog(join(blocked, "calls.jsonl"), { onError: (m) => errors.push(m) });
    log.record(event());
    log.record(event());
    expect(errors).toHaveLength(1);
  });

  it("follows new records, also after a rotation, until stopped", async () => {
    const file = join(sb.home, "calls.jsonl");
    const log = createCallLog(file);
    log.record(event({ params: { name: "old" } }));
    const seen: CallRecord[] = [];
    const ac = new AbortController();
    const done = followCalls(file, (r) => seen.push(r), ac.signal, { server: "fx" }, 10);
    log.record(event({ params: { name: "new" } }));
    log.record(event({ ctx: { serverName: "other", sessionId: "s" }, params: { name: "filtered" } }));
    await waitFor(() => seen.length === 1, "the new record");
    log.close();
    renameSync(file, `${file}.1`);
    const next = createCallLog(file);
    next.record(event({ params: { name: "after-rotation" } }));
    await waitFor(() => seen.length === 2, "the record after rotation");
    ac.abort();
    await done;
    next.close();
    expect(seen.map((r) => r.tool)).toEqual(["new", "after-rotation"]);
  });
});

describe("process memory", () => {
  it("parses ps and sums a process with all its descendants", () => {
    const t = parsePs("  1 0 100\n 10 1 1000\n 11 10 200\n 12 11 50\n 20 1 300\n 30 30 5\nbad line\n");
    expect(treeRss(t, 10)).toBe(1250 * 1024);
    expect(treeRss(t, 20)).toBe(300 * 1024);
    expect(treeRss(t, 30)).toBe(5 * 1024);
    expect(treeRss(t, 99)).toBeUndefined();
  });

  it("reads procfs when ps is missing, and reports unknown when neither exists", async () => {
    const proc = join(sb.home, "proc");
    sb.write("proc/7/status", "Name:\tnode\nPPid:\t1\nVmRSS:\t   2048 kB\n");
    sb.write("proc/8/status", "Name:\tkthread\nPPid:\t7\n");
    sb.write("proc/self/status", "ignored");
    expect(procfsTable(proc)).toEqual(
      new Map([
        [7, { ppid: 1, rss: 2048 * 1024 }],
        [8, { ppid: 7, rss: 0 }],
      ]),
    );
    const empty = join(sb.home, "empty-bin");
    mkdirSync(empty);
    expect(await processTable({ env: { PATH: empty }, procRoot: proc })).toEqual(procfsTable(proc));
    expect(await processTable({ env: { PATH: empty }, procRoot: join(sb.home, "no-proc") })).toBeUndefined();
  });

  it("uses ps from PATH", async () => {
    fakeCommand(sb, "ps", 'echo "  5 1 64"; echo "  6 5 36"');
    const t = await processTable({ env: sb.env, procRoot: join(sb.home, "no-proc") });
    expect(treeRss(t!, 5)).toBe(100 * 1024);
  });

  it("remembers the RSS of each server variant across restarts", async () => {
    fakeCommand(sb, "ps", 'echo "  5 1 64"; echo "  6 5 36"; echo "  9 1 10"');
    const file = join(sb.home, "state", "mcpd-rss.json");
    const s = new RssSampler(file, { env: sb.env, procRoot: join(sb.home, "no-proc") });
    await s.sample([
      { descKey: "fx@default", pid: 5 },
      { descKey: "fx@default", pid: 9 },
      { descKey: "remote@default", pid: undefined },
    ]);
    expect(s.samples()["fx@default"]?.bytes).toBe(55 * 1024);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new RssSampler(file).samples()["fx@default"]?.bytes).toBe(55 * 1024);
  });
});

describe("savings estimate", () => {
  const manifest = parseManifest(
    [
      '[server.big]\ncommand = "big"\n[server.big.variant.work]\nenv = { A = "1" }',
      '[server.small]\ncommand = "small"\nprofiles = ["work"]',
      '[server.never]\ncommand = "never"',
      '[server.web]\nurl = "https://example.com/mcp"\nproxy = true',
    ].join("\n"),
  );
  const procs = parsePs(["100 1 100000", "200 100 200000", "201 200 100000", "300 100 50000"].join("\n"));
  const status = {
    pid: 100,
    sessions: 7,
    agents: [
      { pid: 11, profile: "work", agent: "claude-code", servers: ["big", "small"] },
      { pid: 12, profile: "personal", agent: "codex-mcp-client", servers: ["big"] },
      { pid: null, profile: "work", agent: null, servers: ["big"] },
    ],
    instances: [
      { key: "k1", server: "big", variant: "work", scope: "shared", pid: 200, clients: 1, inflight: 0, idleSeconds: 1, startedAt: 0, holder: null },
      { key: "k2", server: "small", variant: "default", scope: "shared", pid: 300, clients: 1, inflight: 0, idleSeconds: 1, startedAt: 0, holder: null },
    ],
    serverRss: { "big@default": { bytes: 250_000 * 1024, at: "2026-11-15T10:00:00.000Z" } },
  };

  it("multiplies sessions by per-server RSS, live first, then the last sample", async () => {
    const s = await computeSavings(status, procs, manifest);
    expect(s.agentSessions).toBe(2);
    expect(s.unidentifiedSessions).toBe(1);
    expect(s.withTurno.totalBytes).toBe(450_000 * 1024);
    expect(s.withTurno.mcpdBytes).toBe(100_000 * 1024);
    // work: big@work live 300000 + small live 50000; personal: big@default sampled 250000.
    expect(s.withoutTurnoBytes).toBe(600_000 * 1024);
    expect(s.savedBytes).toBe(150_000 * 1024);
    expect(s.savedPercent).toBe(25);
    expect(s.unmeasured).toEqual(["never"]);
    expect(s.servers.find((r) => r.server === "big" && r.variant === "default")?.source).toBe("sample");
    expect(s.estimate).toContain("every live agent session (2 now)");
  });
});

describe("turno mcp log, top and savings", () => {
  it("logs every tool call mcpd relays and shows them with filters", async () => {
    const d = await daemon();
    const c = await connect(d, { "X-Turno-Pid": String(process.pid) });
    await c.callTool({ name: "echo", arguments: { text: "private words" } });
    await c.callTool({ name: "counter", arguments: {} });
    await expect(c.callTool({ name: "hang", arguments: { ms: 10_000 } })).rejects.toThrow(/timed out/);
    const ac = new AbortController();
    const cancelled = c.callTool({ name: "hang", arguments: { ms: 10_000 } }, undefined, { signal: ac.signal }).catch(() => "cancelled");
    await waitFor(() => d.manager.list().some((i) => i.upstream.inflight > 0), "the call in flight");
    ac.abort();
    await cancelled;
    await waitFor(() => readCalls(callsFile(), 10).length === 4, "four records");
    expect(readCalls(callsFile(), 2).map((r) => [r.tool, r.outcome])).toEqual([
      ["hang", "timeout"],
      ["hang", "cancelled"],
    ]);
    expect(statSync(callsFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(callsFile(), "utf8")).not.toContain("private words");

    const json = await run(["mcp", "log", "--json", "-n", "2"]);
    expect(json.code).toBe(0);
    const records = json.out.split("\n").map((l) => JSON.parse(l) as CallRecord);
    expect(records.map((r) => [r.tool, r.outcome, r.agent, r.pid])).toEqual([
      ["hang", "timeout", "observer-test", process.pid],
      ["hang", "cancelled", "observer-test", process.pid],
    ]);
    expect(readCalls(callsFile(), 4).map((r) => r.tool)).toEqual(["echo", "counter", "hang", "hang"]);

    const text = await run(["mcp", "log", "-n", "1"]);
    expect(text.out.split("\n")).toHaveLength(1);
    expect(text.out).toMatch(/cancelled .* hang .*observer-test/);
    expect((await run(["mcp", "log", "--server", "nope"])).out).toBe("no tool calls logged yet (mcpd adds one line per tool call it relays)");
    expect((await run(["mcp", "log", "--profile", "work", "--json"])).out).toBe("");
  });

  it("writes no call log when call_log = false, and log says it is off", async () => {
    const d = await daemon("[mcpd]\ncall_log = false\n");
    const c = await connect(d);
    await c.callTool({ name: "echo", arguments: { text: "x" } });
    expect(existsSync(callsFile())).toBe(false);
    const r = await run(["mcp", "log"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("the call log is off");
  });

  it("top shows each running server with memory, sessions, calls in flight and restarts", async () => {
    const d = await daemon();
    const c = await connect(d, { "X-Turno-Pid": String(process.pid) });
    await c.callTool({ name: "echo", arguments: { text: "x" } });
    const r = await run(["mcp", "top", "--json"]);
    expect(r.code).toBe(0);
    const t = JSON.parse(r.out);
    expect(t.mcpd.pid).toBe(process.pid);
    expect(t.mcpd.agents).toBe(1);
    expect(t.instances).toHaveLength(1);
    expect(t.instances[0]).toMatchObject({ server: "fx", variant: "default", sessions: 1, inflight: 0, restarts: 0 });
    if (t.memoryKnown) expect(t.instances[0].rssBytes).toBeGreaterThan(1024 * 1024);

    const text = await run(["mcp", "top", "--once"]);
    expect(text.out).toContain("SERVER");
    expect(text.out).toMatch(/fx\s+default\s+shared/);

    await d.manager.stopAll();
    await c.callTool({ name: "echo", arguments: { text: "again" } });
    const again = JSON.parse((await run(["mcp", "top", "--json"])).out);
    expect(again.instances[0].restarts).toBe(1);
  });

  it("mcp list marks the servers mcpd runs now", async () => {
    const d = await daemon('[profiles.work]\n');
    sb.write(".config/turno/mcp.toml", `${readFileSync(join(sb.home, ".config/turno/mcp.toml"), "utf8")}[server.idle]\ncommand = "idle-mcp"\n`);
    await (await connect(d)).callTool({ name: "echo", arguments: { text: "x" } });
    const r = await run(["mcp", "list"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").find((l) => l.startsWith("  fx "))).toMatch(/ running /);
    expect(r.out.split("\n").find((l) => l.startsWith("  idle "))).toMatch(/ stopped /);
    expect(r.out).not.toContain("mcpd is not running");
  });

  it("top says when memory cannot be measured instead of failing", async () => {
    const d = await daemon();
    await (await connect(d)).callTool({ name: "echo", arguments: { text: "x" } });
    const empty = join(sb.home, "empty-bin");
    mkdirSync(empty);
    const r = await run(["mcp", "top", "--once"], { ...sb.env, PATH: empty });
    expect(r.code).toBe(0);
    if (!existsSync("/proc")) {
      expect(r.out).toContain("memory is unknown");
      expect(r.out).toMatch(/fx\s+default\s+shared\s+\d+\s+\?/);
      const s = await run(["mcp", "savings"], { ...sb.env, PATH: empty });
      expect(s.code).toBe(1);
      expect(s.err).toContain("memory is unknown");
    }
  });

  it("top refreshes in a terminal until stopped", async () => {
    await daemon();
    const io = { ...fakeIo(sb.env), isTty: true };
    const ac = new AbortController();
    const done = top([], io, ac.signal, 20);
    await waitFor(() => io.lines.filter((l) => l.includes("mcpd pid")).length >= 2, "two refreshes");
    ac.abort();
    expect(await done).toBe(0);
    expect(io.lines.join("\n")).toContain("\x1b[2J");
  });

  it("savings compares mcpd with one copy of each server per agent session", async () => {
    const d = await daemon();
    const a = await connect(d, { "X-Turno-Pid": String(process.pid) });
    await a.callTool({ name: "echo", arguments: { text: "x" } });
    const r = await run(["mcp", "savings", "--json"]);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.agentSessions).toBe(1);
    expect(s.withTurno.runningServers).toBe(1);
    expect(s.withoutTurnoBytes).toBeGreaterThan(0);
    expect(s.servers[0]).toMatchObject({ server: "fx", variant: "default", source: "live", sessions: 1 });
    const text = await run(["mcp", "savings"]);
    expect(text.out).toContain("Without turno:");
    expect(text.out).toContain("starts its own copy of each stdio server");
  });

  it("explains when mcpd is down, and every subcommand checks its flags", async () => {
    sb.write(".config/turno/config.toml", "[mcpd]\nport = 47999\n");
    for (const sub of ["top", "savings"]) {
      const r = await run(["mcp", sub, "--json"]);
      expect(r.code, sub).toBe(1);
      expect(JSON.parse(r.out)).toEqual({ running: false });
      expect((await run(["mcp", sub])).out).toContain("mcpd is not running");
    }
    for (const sub of ["log", "top", "savings"]) {
      const help = await run(["mcp", sub, "--help"]);
      expect(help.code, sub).toBe(0);
      expect(help.out).toContain(`turno mcp ${sub}`);
      const bad = await run(["mcp", sub, "--folow"]);
      expect(bad.code, sub).toBe(2);
      expect(bad.err).toContain("unknown option --folow");
    }
    expect((await run(["mcp", "log", "-n", "zero"])).code).toBe(2);
  });
});

describe("config", () => {
  it("accepts [mcpd] call_log as a known boolean key", () => {
    const c = parseConfig("[mcpd]\ncall_log = false\n");
    expect(c.mcpd.callLog).toBe(false);
    expect(c.warnings).toEqual([]);
    expect(parseConfig("").mcpd.callLog).toBe(true);
    expect(() => parseConfig('[mcpd]\ncall_log = "no"\n')).toThrow(/call_log must be true or false/);
  });
});
