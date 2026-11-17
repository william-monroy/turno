import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProjectRule, parseConfig } from "../src/core/config.js";
import { type Manifest, parseManifest } from "../src/core/manifest.js";
import { folderMcpSet, mcpSetAllows } from "../src/core/resolve.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector } from "../src/mcpd/connectors.js";
import { Gateway } from "../src/mcpd/gateway.js";
import { InstanceManager } from "../src/mcpd/instances.js";
import { MODERN_PROTOCOL_VERSION } from "../src/mcpd/modern.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { waitFor } from "./helpers/wait.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));
const MASTER = "f".repeat(64);
const b64 = (path: string) => Buffer.from(path, "utf8").toString("base64url");

let sb: Sandbox;
let gw: Gateway | undefined;
let manager: InstanceManager | undefined;
let clients: Client[] = [];
let spawnLog: string;

beforeEach(() => {
  sb = sandbox();
  clients = [];
  spawnLog = join(sb.home, "spawns.log");
});

afterEach(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await manager?.stopAll();
  await gw?.close();
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
  return `[server.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\nenv = { FIXTURE_LOG = ${JSON.stringify(spawnLog)} }\n${extra}\n`;
}

const spawned = () => {
  try {
    return readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

/** A gateway in this process whose folder rules come from `rules()`. */
async function boot(toml: string, rules: () => ProjectRule[]): Promise<number> {
  const manifest: Manifest = parseManifest(toml);
  manager = new InstanceManager({
    cache: new DescriptionCache(join(sb.home, "cache")),
    connector: new DefaultConnector({ resolve: async (v) => v, serversDir: join(sb.home, "servers"), logsDir: join(sb.home, "logs"), baseEnv: { PATH: process.env.PATH ?? "" } }),
    home: sb.home,
  });
  gw = new Gateway({ manager, manifest: () => manifest, token: MASTER, clientRequestTimeoutMs: 5000, processCwd: async () => undefined, folderRules: rules });
  return gw.listen(0);
}

async function connect(port: number, server: string, folder?: string, profile = "work"): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  const headers: Record<string, string> = { Authorization: `Bearer ${profileToken(MASTER, profile)}` };
  if (folder) headers["X-Turno-Cwd-B64"] = b64(folder);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${server}`), { requestInit: { headers } }));
  clients.push(client);
  return client;
}

function folder(rel: string): string {
  const dir = join(sb.home, rel);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

describe("[[projects]] mcp in config.toml", () => {
  it("parses mcp and mcp_deny, with or without a profile", () => {
    const c = parseConfig(
      `[[projects]]\npath = "~/code/app"\nprofile = "work"\nmcp = ["issues", "docs"]\n[[projects]]\npath = "~/code/oss"\nmcp_deny = ["mail"]\n`,
      "x",
      sb.env,
    );
    expect(c.projects).toEqual([
      { path: join(sb.home, "code/app"), profile: "work", mcp: ["issues", "docs"] },
      { path: join(sb.home, "code/oss"), mcpDeny: ["mail"] },
    ]);
    expect(c.warnings).toEqual([]);
  });

  it("refuses a rule with neither a profile nor a server set, and sets that are not lists of names", () => {
    expect(() => parseConfig(`[[projects]]\npath = "~/a"\n`, "x", sb.env)).toThrow(/needs path and profile, mcp or mcp_deny/);
    expect(() => parseConfig(`[[projects]]\npath = "~/a"\nmcp = "docs"\n`, "x", sb.env)).toThrow(/projects\[0\]\.mcp must be an array of server names/);
    expect(() => parseConfig(`[[projects]]\npath = "~/a"\nmcp_deny = [1]\n`, "x", sb.env)).toThrow(/mcp_deny must be an array/);
  });
});

describe("which set applies to a folder", () => {
  const home = "/h";
  const rules: ProjectRule[] = [
    { path: "/h/code", mcp: ["docs"] },
    { path: "/h/code/app", profile: "work", mcp: ["issues", "docs"], mcpDeny: ["docs"] },
    { path: "/h/code/app", profile: "personal", mcp: ["docs"] },
    { path: "/h/code/app/sub", profile: "work" },
    { path: "/h/oss", mcpDeny: ["mail"] },
  ];

  it("takes the longest rule that has a set, preferring the session's profile on a tie", () => {
    expect(folderMcpSet([`${home}/code/lib`], rules, "work")?.path).toBe("/h/code");
    expect(folderMcpSet([`${home}/code/app/sub`], rules, "work")).toMatchObject({ path: "/h/code/app", profile: "work" });
    expect(folderMcpSet([`${home}/code/app`], rules, "personal")).toMatchObject({ path: "/h/code/app", profile: "personal" });
    // No rule for this profile at that depth: the first one in the file.
    expect(folderMcpSet([`${home}/code/app`], rules, "other")).toMatchObject({ profile: "work" });
    expect(folderMcpSet([`${home}/codex`], rules, "work")).toBeUndefined();
    expect(folderMcpSet([], rules, "work")).toBeUndefined();
  });

  it("matches the main repository of a worktree too", () => {
    expect(folderMcpSet(["/tmp/wt", "/h/oss/repo"], rules, "work")?.path).toBe("/h/oss");
  });

  it("allows what mcp lists, minus mcp_deny; mcp_deny alone removes from everything", () => {
    const app = folderMcpSet(["/h/code/app"], rules, "work")!;
    expect(mcpSetAllows(app, "issues")).toBe(true);
    expect(mcpSetAllows(app, "docs")).toBe(false);
    expect(mcpSetAllows(app, "mail")).toBe(false);
    const oss = folderMcpSet(["/h/oss"], rules, "work")!;
    expect(mcpSetAllows(oss, "docs")).toBe(true);
    expect(mcpSetAllows(oss, "mail")).toBe(false);
    expect(mcpSetAllows(undefined, "mail")).toBe(true);
  });
});

describe("mcpd enforces folder sets", () => {
  it("lists no tools and starts nothing for a server outside the folder's set", async () => {
    const app = folder("code/app");
    let rules: ProjectRule[] = [{ path: app, mcp: ["docs"] }];
    const port = await boot(fixture("docs") + fixture("issues"), () => rules);

    const hidden = await connect(port, "issues", app);
    expect(hidden.getServerCapabilities()?.tools).toBeUndefined();
    expect(hidden.getInstructions()).toMatch(/issues is not in the MCP set of .*code\/app/);
    expect((await hidden.listTools()).tools).toEqual([]);
    await expect(hidden.callTool({ name: "echo", arguments: { text: "x" } })).rejects.toThrow(/not in the MCP set/);
    expect(spawned()).toBe(0);

    const shown = await connect(port, "docs", app);
    expect((await shown.listTools()).tools.length).toBeGreaterThan(0);
    // Another folder and a session without a folder are not covered by the rule.
    const elsewhere = await connect(port, "issues", folder("other"));
    expect((await elsewhere.listTools()).tools.length).toBeGreaterThan(0);
    const unknown = await connect(port, "issues");
    expect((await unknown.listTools()).tools.length).toBeGreaterThan(0);

    // A changed rule applies to open sessions on their next list or call.
    rules = [{ path: app, mcpDeny: ["docs"] }];
    expect((await shown.listTools()).tools).toEqual([]);
    await expect(shown.callTool({ name: "echo", arguments: { text: "x" } })).rejects.toThrow(/not in the MCP set/);
  });

  it("hides the server from MCP 2026-07-28 (stateless) requests too", async () => {
    const app = folder("code/app");
    const rules: ProjectRule[] = [{ path: app, mcp: ["docs"] }];
    const port = await boot(fixture("docs") + fixture("issues"), () => rules);
    const meta = { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION, "io.modelcontextprotocol/clientInfo": { name: "modern", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
    const modern = async (server: string, method: string, params: Record<string, unknown> = {}, where?: string) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${profileToken(MASTER, "work")}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "Mcp-Method": method,
      };
      if (method === "tools/call") headers["Mcp-Name"] = String(params.name);
      if (where) headers["X-Turno-Cwd-B64"] = b64(where);
      const res = await fetch(`http://127.0.0.1:${port}/mcp/${server}`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }) });
      return (await res.json()) as { result?: Record<string, any>; error?: { message: string } };
    };

    const discover = await modern("issues", "server/discover", {}, app);
    expect(discover.result?.capabilities).toEqual({});
    expect(discover.result?.instructions).toMatch(/issues is not in the MCP set of .*code\/app/);
    expect((await modern("issues", "tools/list", {}, app)).result?.tools).toEqual([]);
    expect((await modern("issues", "tools/call", { name: "echo", arguments: { text: "x" } }, app)).error?.message).toMatch(/not in the MCP set/);
    expect(spawned()).toBe(0);

    expect(((await modern("docs", "tools/list", {}, app)).result?.tools ?? []).length).toBeGreaterThan(0);
    expect(((await modern("issues", "tools/list", {}, folder("other"))).result?.tools ?? []).length).toBeGreaterThan(0);
  });

  it("applies the set to a subfolder and to resources and prompts", async () => {
    const app = folder("code/app");
    const sub = folder("code/app/src");
    const port = await boot(fixture("issues"), () => [{ path: app, mcpDeny: ["issues"] }]);
    const c = await connect(port, "issues", sub);
    expect((await c.listResources().catch(() => ({ resources: [] }))).resources).toEqual([]);
    await expect(c.readResource({ uri: "test://one" })).rejects.toThrow(/not in the MCP set/);
    expect(spawned()).toBe(0);
  });
});

describe("config check and profile commands", () => {
  it("warns about set names missing from mcp.toml and direct remotes a set cannot hide", async () => {
    sb.write(".config/turno/mcp.toml", `${fixture("docs")}${fixture("issues")}[server.web]\nurl = "https://example.com/mcp"\n`);
    sb.write(".config/turno/config.toml", `[[projects]]\npath = "~/code"\nmcp = ["docs", "isues"]\n`);
    const r = await run(["config", "check"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('the rule for ~/code lists "isues" in mcp, which is not in mcp.toml (did you mean issues?)');
    expect(r.out).toContain("the rule for ~/code cannot hide web: it is a remote server that does not pass through mcpd");
  });

  it("profile assign and unassign keep a folder's server set", async () => {
    folder("code/app");
    sb.write(".config/turno/config.toml", `[profiles.work]\n[profiles.home]\n\n[[projects]]\npath = "~/code/app"\nprofile = "work"\nmcp = ["docs"]\n`);
    expect((await run(["profile", "assign", join(sb.home, "code/app"), "home"])).code).toBe(0);
    const cfg = () => parseConfig(readFileSync(join(sb.home, ".config/turno/config.toml"), "utf8"), "x", sb.env).projects;
    expect(cfg()).toEqual([{ path: join(sb.home, "code/app"), profile: "home", mcp: ["docs"] }]);
    expect((await run(["profile", "unassign", join(sb.home, "code/app")])).code).toBe(0);
    expect(cfg()).toEqual([{ path: join(sb.home, "code/app"), mcp: ["docs"] }]);
    // A folder that only has a set has no profile rule to remove.
    expect((await run(["profile", "unassign", join(sb.home, "code/app")])).code).toBe(1);
    expect(cfg()).toHaveLength(1);
  });

  it("profile which shows the server set of the folder", async () => {
    const app = folder("code/app");
    sb.write(".config/turno/config.toml", `[profiles.work]\n\n[[projects]]\npath = "~/code"\nmcp = ["docs"]\nmcp_deny = ["mail"]\n`);
    const r = await run(["profile", "which", app]);
    expect(r.out).toContain("mcp: only docs, not mail (rule ~/code)");
    const j = JSON.parse((await run(["profile", "which", app, "--json"])).out);
    expect(j.mcp).toEqual({ rule: "~/code", allow: ["docs"], deny: ["mail"] });
  });
});

describe("mcpd reads folder sets from config.toml", () => {
  it("serves the sets of config.toml and reloads them on SIGHUP, keeping the last good ones", async () => {
    const { startDaemon } = await import("../src/mcpd/daemon.js");
    sb.write(".config/turno/config.toml", `[[projects]]\npath = "~/a"\nmcp = ["docs"]\n`);
    const d = await startDaemon({ env: sb.env, port: 0 });
    try {
      const token = readFileSync(join(sb.home, ".local/state/turno/mcpd.token"), "utf8").trim();
      const status = async () =>
        ((await (await fetch(`http://127.0.0.1:${d.port}/status`, { headers: { authorization: `Bearer ${token}` } })).json()) as { config: Record<string, unknown> }).config;
      expect(await status()).toEqual({ error: null, folderSets: 1 });
      sb.write(".config/turno/config.toml", `[[projects]]\npath = "~/a"\nmcp = ["docs"]\n[[projects]]\npath = "~/b"\nmcp_deny = ["mail"]\n`);
      process.emit("SIGHUP", "SIGHUP");
      await waitFor(async () => (await status()).folderSets === 2, "the reloaded sets");
      sb.write(".config/turno/config.toml", `[[projects]]\npath = 1\n`);
      process.emit("SIGHUP", "SIGHUP");
      await waitFor(async () => (await status()).error !== null, "the reload error");
      expect((await status()).folderSets).toBe(2);
    } finally {
      await d.stop();
    }
  });
});
