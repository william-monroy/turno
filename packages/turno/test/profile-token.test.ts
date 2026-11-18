import { existsSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherText } from "../src/cli/launchers.js";
import { type Manifest, parseManifest, toolAllowed, toolFilterFor } from "../src/core/manifest.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector } from "../src/mcpd/connectors.js";
import { masterToken, readToken } from "../src/mcpd/daemon.js";
import { Gateway } from "../src/mcpd/gateway.js";
import { tokenSyncCheck } from "../src/mcpd/health.js";
import { InstanceManager } from "../src/mcpd/instances.js";
import { profileToken, profileTokenFile, tokenProfile } from "../src/mcpd/tokens.js";
import { fakeIo } from "./helpers/cli.js";
import { freePort } from "./helpers/net.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));

let sb: Sandbox;
let gw: Gateway | undefined;
let manager: InstanceManager | undefined;
let clients: Client[] = [];
let held: Server[] = [];

beforeEach(() => {
  sb = sandbox();
  clients = [];
  held = [];
});

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await manager?.stopAll();
  await gw?.close();
  for (const s of held) await new Promise<void>((r) => s.close(() => r()));
  gw = undefined;
  manager = undefined;
  sb.cleanup();
});

async function run(args: string[]) {
  const { main } = await import("../src/cli/main.js");
  const io = fakeIo(sb.env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

function fixture(name: string, extra = ""): string {
  return `[server.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\n${extra}\n`;
}

/** A real gateway in this process, with the sandbox's master token. */
async function boot(toml: string, master: string): Promise<number> {
  const manifest: Manifest = parseManifest(toml);
  manager = new InstanceManager({
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
    token: master,
    clientRequestTimeoutMs: 5000,
    processCwd: async () => undefined,
  });
  return gw.listen(0);
}

async function connect(port: number, server: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${server}`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

function post(port: number, path: string, headers: Record<string, string>, body = INIT): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  });
}

describe("profile tokens", () => {
  it("derive from the master token, name their profile and die with a rotation", () => {
    const master = "m".repeat(64);
    const t = profileToken(master, "work");
    expect(t).toMatch(/^tp1\.work\.[A-Za-z0-9_-]{43}$/);
    expect(t).not.toContain(master);
    expect(tokenProfile(master, t)).toBe("work");
    expect(profileToken(master, "work")).toBe(t);
    expect(profileToken(master, "personal")).not.toBe(t);
    // Renaming the profile inside the token breaks its MAC.
    expect(tokenProfile(master, t.replace("tp1.work.", "tp1.personal."))).toBeUndefined();
    expect(tokenProfile("n".repeat(64), t)).toBeUndefined();
    expect(tokenProfile(master, master)).toBeUndefined();
    expect(tokenProfile(master, "")).toBeUndefined();
  });
});

describe("gateway authentication (ADR 0023)", () => {
  const MASTER = "k".repeat(64);
  const bearer = (profile: string) => ({ Authorization: `Bearer ${profileToken(MASTER, profile)}` });

  it("takes the profile from the token, never from X-Turno-Profile", async () => {
    const port = await boot(fixture("fx") + fixture("bonly", 'profiles = ["b"]'), MASTER);
    // Profile a cannot open a server limited to b, even when it claims to be b.
    expect((await post(port, "/mcp/bonly", bearer("a"))).status).toBe(403);
    const forged = await post(port, "/mcp/bonly", { ...bearer("a"), "X-Turno-Profile": "b" });
    expect(forged.status).toBe(403);
    // A header that disagrees with the token is refused even where the token alone would pass.
    const mismatch = await post(port, "/mcp/fx", { ...bearer("a"), "X-Turno-Profile": "b" });
    expect(mismatch.status).toBe(403);
    expect(((await mismatch.json()) as { error: string }).error).toContain("belongs to profile a");
    // b's own token opens it; the matching header is fine.
    const b = await connect(port, "bonly", { ...bearer("b"), "X-Turno-Profile": "b" });
    expect(
      ((await b.callTool({ name: "echo", arguments: { text: "hi" } })) as { content: { text: string }[] }).content[0]!
        .text,
    ).toBe("hi");
    const a = await connect(port, "fx", bearer("a"));
    expect((await a.listTools()).tools.length).toBeGreaterThan(0);
    expect(gw!.status()).toMatchObject({ sessions: 2 });
  });

  it("refuses the master token for MCP sessions with a message that says to sync", async () => {
    const logs: string[] = [];
    const port = await boot(fixture("fx"), MASTER);
    (gw as unknown as { opts: { log: (l: string) => void } }).opts.log = (l) => logs.push(l);
    const res = await post(port, "/mcp/fx", { Authorization: `Bearer ${MASTER}`, "X-Turno-Profile": "a" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("turno mcp sync");
    expect(logs.join("\n")).toContain("master token");
    expect(logs.join("\n")).not.toContain(MASTER);
  });

  it("keeps the admin endpoints for the master token only", async () => {
    const port = await boot(fixture("fx"), MASTER);
    const status = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/status`, { headers });
    expect((await status({ Authorization: `Bearer ${MASTER}` })).status).toBe(200);
    expect((await status(bearer("a"))).status).toBe(403);
    expect((await post(port, "/refresh/fx", bearer("a"), "")).status).toBe(403);
    // A token derived from another master is just a bad token.
    const stale = await post(port, "/mcp/fx", { Authorization: `Bearer ${profileToken("z".repeat(64), "a")}` });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: string }).error).toContain("turno mcp sync");
  });

  it("does not let one profile's token drive another profile's session", async () => {
    const port = await boot(fixture("fx"), MASTER);
    const init = await post(port, "/mcp/fx", bearer("a"));
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const hijack = await post(port, "/mcp/fx", { ...bearer("b"), "mcp-session-id": sid }, ping);
    expect(hijack.status).toBe(403);
    const own = await post(
      port,
      "/mcp/fx",
      { ...bearer("a"), "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" },
      ping,
    );
    expect(own.status).toBe(200);
  });
});

describe("tool filters", () => {
  it("parse allow and deny globs, per server and per profile variant", () => {
    const m = parseManifest(
      `${fixture("fx", 'tools = { deny = ["ask*", "hang"] }')}[server.fx.variant.work]\ntools = { allow = ["echo", "who?mi"] }\n`,
    );
    const fx = m.servers.fx!;
    const base = toolFilterFor(fx, "personal");
    expect(base).toEqual({ deny: ["ask*", "hang"] });
    expect(toolAllowed(base, "echo")).toBe(true);
    expect(toolAllowed(base, "askLater")).toBe(false);
    expect(toolAllowed(base, "hang")).toBe(false);
    expect(toolAllowed(base, "hangs")).toBe(true);
    // The variant replaces allow and keeps the server's deny.
    const work = toolFilterFor(fx, "work");
    expect(work).toEqual({ deny: ["ask*", "hang"], allow: ["echo", "who?mi"] });
    expect(toolAllowed(work, "whoami")).toBe(true);
    expect(toolAllowed(work, "counter")).toBe(false);
    expect(toolAllowed({ allow: ["a.b"] }, "aXb")).toBe(false);
  });

  it("are validated, and refused where mcpd never sees the calls", () => {
    expect(() => parseManifest(fixture("fx", 'tools = ["echo"]'))).toThrow(/tools must be a table/);
    expect(() => parseManifest(fixture("fx", 'tools = { allow = "echo" }'))).toThrow(/tools.allow must be an array/);
    expect(() => parseManifest(fixture("fx", 'tools = { only = ["echo"] }'))).toThrow(/not a tool filter key/);
    expect(() => parseManifest(fixture("fx", 'tools = { deny = ["two words"] }'))).toThrow(/invalid tool pattern/);
    expect(() =>
      parseManifest('[server.docs]\nurl = "https://docs.example.com/mcp"\ntools = { deny = ["x"] }\n'),
    ).toThrow(/go through mcpd/);
    const proxied = parseManifest(
      '[server.vault]\nurl = "https://vault.example.com/mcp"\nheaders = { Authorization = "keychain:v" }\ntools = { deny = ["x"] }\n',
    );
    expect(proxied.servers.vault!.tools).toEqual({ deny: ["x"] });
    // The filter is mcpd's business: it is not copied into the remote entry.
    expect((proxied.servers.vault as { entry: Record<string, unknown> }).entry.tools).toBeUndefined();
  });

  it("hide filtered tools from tools/list and refuse calls to them", async () => {
    const master = "k".repeat(64);
    const port = await boot(
      `${fixture("fx", 'tools = { deny = ["ask*", "hang"] }')}[server.fx.variant.work]\ntools = { allow = ["echo"] }\n`,
      master,
    );
    const personal = await connect(port, "fx", { Authorization: `Bearer ${profileToken(master, "personal")}` });
    const names = (await personal.listTools()).tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("counter");
    expect(names).not.toContain("ask");
    expect(names).not.toContain("askLater");
    expect(names).not.toContain("hang");
    await expect(personal.callTool({ name: "hang", arguments: { ms: 1 } })).rejects.toThrow(
      /not available to profile personal/,
    );
    const work = await connect(port, "fx", { Authorization: `Bearer ${profileToken(master, "work")}` });
    expect((await work.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    await expect(work.callTool({ name: "counter", arguments: {} })).rejects.toThrow(/tools.allow/);
  });

  it("turno config check fails on a broken filter", async () => {
    sb.write(".config/turno/mcp.toml", fixture("fx", 'tools = { allow = "echo" }'));
    const r = await run(["config", "check"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("tools.allow must be an array");
  });
});

describe("turno mcp sync writes each profile its own token", () => {
  const CONFIG = (port: number) =>
    `default = "a"\nsystem = "a"\n\n[profiles.a]\n[profiles.b]\n[profiles.cx]\nagent = "codex"\n[profiles.cur]\nagent = "cursor"\n\n[mcpd]\nport = ${port}\n`;

  beforeEach(async () => {
    sb.write(".config/turno/config.toml", CONFIG(await freePort()));
    sb.write(".config/turno/mcp.toml", fixture("fx") + fixture("bonly", 'profiles = ["b"]'));
    sb.write(".claude.json", "{}\n");
  });

  const claudeEntry = (rel: string, server: string) =>
    (
      JSON.parse(readFileSync(join(sb.home, rel), "utf8")) as {
        mcpServers: Record<string, { headers: Record<string, string> }>;
      }
    ).mcpServers[server];

  it("and a session with profile a's token cannot open b's server, end to end", async () => {
    const r = await run(["mcp", "sync"]);
    expect(r.code).toBe(0);
    const master = readToken(sb.env)!;
    const a = claudeEntry(".claude-a/.claude.json", "fx")!;
    expect(a.headers.Authorization).toBe(`Bearer ${profileToken(master, "a")}`);
    expect(claudeEntry(".claude-a/.claude.json", "bonly")).toBeUndefined();
    expect(claudeEntry(".claude-b/.claude.json", "bonly")!.headers.Authorization).toBe(
      `Bearer ${profileToken(master, "b")}`,
    );
    // Plain claude gets the system profile's token.
    expect(claudeEntry(".claude.json", "fx")!.headers.Authorization).toBe(`Bearer ${profileToken(master, "a")}`);
    for (const f of [".claude-a/.claude.json", ".claude-b/.claude.json", ".claude.json"])
      expect(readFileSync(join(sb.home, f), "utf8")).not.toContain(master);

    // Agents that read the token from the environment get a private token file their launcher reads.
    for (const p of ["cx", "cur"]) {
      const file = profileTokenFile(p, sb.env);
      expect(readFileSync(file, "utf8").trim()).toBe(profileToken(master, p));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(profileTokenFile("a", sb.env))).toBe(false);
    const launcher = launcherText("cx", sb.env, "codex");
    expect(launcher).toContain('"$HOME/.local/state/turno/mcpd-tokens/cx.token"');
    expect(launcher).not.toContain("mcpd.token");

    const port = await boot(readFileSync(join(sb.home, ".config/turno/mcp.toml"), "utf8"), master);
    const forged = await post(port, "/mcp/bonly", { Authorization: a.headers.Authorization!, "X-Turno-Profile": "b" });
    expect(forged.status).toBe(403);
    const ok = await connect(port, "fx", {
      Authorization: a.headers.Authorization!,
      "X-Turno-Profile": a.headers["X-Turno-Profile"]!,
    });
    expect((await ok.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("after a rotation every derived token is dead until the next sync", async () => {
    expect((await run(["mcp", "sync"])).code).toBe(0);
    const before = claudeEntry(".claude-a/.claude.json", "fx")!.headers.Authorization!.slice(7);
    const rotate = await run(["mcp", "token", "rotate"]);
    expect(rotate.code).toBe(0);
    expect(rotate.out).toContain("profile token");
    expect(rotate.out).toContain("turno mcp sync");
    const master = readToken(sb.env)!;
    expect(tokenProfile(master, before)).toBeUndefined();
    expect(tokenSyncCheck(sb.env)?.level).toBe("warn");
    expect((await run(["mcp", "sync"])).code).toBe(0);
    expect(tokenProfile(master, claudeEntry(".claude-a/.claude.json", "fx")!.headers.Authorization!.slice(7))).toBe(
      "a",
    );
    expect(readFileSync(profileTokenFile("cx", sb.env), "utf8").trim()).toBe(profileToken(master, "cx"));
    expect(tokenSyncCheck(sb.env)).toBeUndefined();
  });

  it("doctor flags configs that still send the master token (an upgrade from before ADR 0023)", async () => {
    const master = masterToken(sb.env, "ensure")!;
    const file = sb.write(
      ".claude-a/.claude.json",
      JSON.stringify({
        mcpServers: {
          fx: {
            type: "http",
            url: "http://127.0.0.1:1/mcp/fx",
            headers: { Authorization: `Bearer ${master}`, "X-Turno-Profile": "a" },
          },
        },
      }),
    );
    sb.write(".local/state/turno/mcp-managed.json", JSON.stringify({ [file]: ["fx"] }));
    const c = tokenSyncCheck(sb.env);
    expect(c?.level).toBe("warn");
    expect(c?.text).toContain("master token");
    expect(c?.text).not.toContain(master);
    expect(c?.fix?.label).toBe("turno mcp sync");
  });

  it("a dry run writes no token file", async () => {
    expect((await run(["mcp", "sync", "--dry-run"])).code).toBe(0);
    expect(existsSync(profileTokenFile("cx", sb.env))).toBe(false);
  });

  it("turno mcp config gives other agents a profile token file, never the master", async () => {
    masterToken(sb.env, "ensure");
    const r = await run(["mcp", "config", "--agent", "opencode", "--profile", "b"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("mcpd-tokens/b.token");
    expect(r.out).not.toContain("mcpd.token");
    expect(readFileSync(profileTokenFile("b", sb.env), "utf8").trim()).toBe(profileToken(readToken(sb.env)!, "b"));
  });
});
