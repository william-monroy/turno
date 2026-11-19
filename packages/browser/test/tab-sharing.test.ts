import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHost, serve } from "../src/host.js";
import { SESSION_CAPABILITY, SESSION_ENDED_METHOD, SESSION_META_KEY } from "../src/session.js";
import { upstream } from "../src/upstream.js";
import { chromeUnavailable, killSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `"sharing": "tabs"` against a real Google Chrome: two agent sessions (two values of
 * `_meta["io.turno/session"]`, as mcpd relays them over one connection) in one browser. This is
 * also the check that upstream's `BrowserBackend` runs one per session on one shared browser
 * context. The host runs in process with a short lock wait; Chrome runs headless on a profile in
 * the sandbox HOME, and cleanup only signals processes whose command line names it.
 *
 * Skipped, with the reason in the suite name, when Chrome is missing or cannot start (or with
 * TURNO_SKIP_CHROME=1).
 */

const reason = chromeUnavailable();

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";

let sb: Sandbox;
let web: { url: string; server: Server };
const clients: Client[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;

beforeAll(async () => {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const name = path.slice(1) || "home";
    const body =
      path === "/opener"
        ? `<title>opener</title><a href="/popup" target="_blank">Open popup</a>`
        : `<title>${name}</title><h1>Page ${name}</h1>`;
    // A slow page, so two navigations overlap.
    setTimeout(
      () => {
        res.setHeader("content-type", "text/html");
        res.end(body);
      },
      path === "/slow" ? 1_500 : 0,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  web = { url: `http://127.0.0.1:${port}`, server };
});

afterAll(async () => {
  await new Promise((resolve) => web.server.close(resolve));
});

beforeEach(() => {
  sb = sandbox();
  // Chrome started in process inherits this process's env (crash reports, upstream's registry of
  // bound browsers): keep all of it in the sandbox.
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = sb.home;
  process.env.XDG_CONFIG_HOME = join(sb.home, ".config");
  process.env.XDG_CACHE_HOME = join(sb.home, ".cache");
  process.env.XDG_DATA_HOME = join(sb.home, ".local", "share");
  process.env.XDG_STATE_HOME = join(sb.home, ".local", "state");
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  killSandboxProcesses(sb.home);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  sb.cleanup();
});

async function start(tabLocks = { waitMs: 400, releaseMs: 60_000 }, maxTabs?: number): Promise<Client> {
  const config = await upstream().tools.resolveCLIConfigForMCP(
    { browser: "chrome", userDataDir: join(sb.home, "profile"), headless: true, outputDir: join(sb.home, "output") },
    {},
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await serve(
    createHost({
      config,
      cliOptions: {},
      tuning: { sharing: "tabs", ...(maxTabs !== undefined ? { maxTabs } : {}) },
      tabLocks,
    }),
    serverSide,
  );
  const client = new Client({ name: "mcpd-like", version: "0.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

/** A call as mcpd relays it for one client session. */
async function as(
  client: Client,
  session: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args, _meta: { [SESSION_META_KEY]: session } });
  return { text: textOf(res), isError: Boolean(res.isError) };
}

async function ok(client: Client, session: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await as(client, session, name, args);
  expect(r.isError, r.text).toBe(false);
  return r.text;
}

describe.skipIf(reason !== undefined)(reason ? `tab sharing (skipped: ${reason})` : "tab sharing", () => {
  it("declares that it wants to hear when a session ends", async () => {
    const client = await start();
    expect(client.getServerCapabilities()?.experimental).toEqual({ [SESSION_CAPABILITY]: {} });
  }, 30_000);

  it("runs two sessions at once, each in its own tab with its own current tab", async () => {
    const client = await start();
    // The first call opens the browser; then both sessions navigate at the same time.
    await ok(client, A, "browser_navigate", { url: `${web.url}/a` });
    const started = Date.now();
    const [slow, fast] = await Promise.all([
      ok(client, A, "browser_navigate", { url: `${web.url}/slow` }),
      ok(client, B, "browser_navigate", { url: `${web.url}/b` }),
    ]);
    expect(slow).toContain(`Page URL: ${web.url}/slow`);
    expect(fast).toContain(`Page URL: ${web.url}/b`);
    expect(Date.now() - started).toBeLessThan(10_000);

    const snapA = await ok(client, A, "browser_snapshot");
    const snapB = await ok(client, B, "browser_snapshot");
    expect(snapA).toContain('heading "Page slow"');
    expect(snapB).toContain('heading "Page b"');

    const listA = await ok(client, A, "browser_tabs", { action: "list" });
    expect(listA).toMatch(/- 0: \(current\) \[slow\]/);
    expect(listA).toMatch(/- 1: \[b\].*\(in use by session bbbbbbbb\)/);
    const listB = await ok(client, B, "browser_tabs", { action: "list" });
    expect(listB).toMatch(/- 0: \[slow\].*\(in use by session aaaaaaaa\)/);
    expect(listB).toMatch(/- 1: \(current\) \[b\]/);
  }, 60_000);

  it("refuses another session's tab after the wait, naming the holder, until that session ends", async () => {
    const client = await start();
    await ok(client, A, "browser_navigate", { url: `${web.url}/a` });
    await ok(client, B, "browser_navigate", { url: `${web.url}/b` });

    const refused = await as(client, B, "browser_tabs", { action: "select", index: 0 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`tab 0 (${web.url}/a) is in use by another agent session`);
    expect(refused.text).toContain("session aaaaaaaa (last call browser_navigate");
    expect(refused.text).toContain('browser_tabs with action "new"');
    // A was not disturbed, and B still works in its own tab.
    expect(await ok(client, A, "browser_snapshot")).toContain('heading "Page a"');
    expect(await ok(client, B, "browser_snapshot")).toContain('heading "Page b"');

    // mcpd says A ended: its tab is free for B.
    await client.notification({ method: SESSION_ENDED_METHOD, params: { session: A } } as never);
    await new Promise((r) => setTimeout(r, 100));
    const taken = await ok(client, B, "browser_tabs", { action: "select", index: 0 });
    expect(taken).toMatch(/- 0: \(current\) \[a\]/);
    expect(await ok(client, B, "browser_snapshot")).toContain('heading "Page a"');
  }, 60_000);

  it("gives a popup to the session whose page opened it", async () => {
    const client = await start();
    await ok(client, A, "browser_navigate", { url: `${web.url}/opener` });
    await ok(client, B, "browser_navigate", { url: `${web.url}/b` });
    await ok(client, A, "browser_click", { target: "a", element: "Open popup link" });
    const list = await ok(client, B, "browser_tabs", { action: "list" });
    const popupLine = list.split("\n").find((l) => l.includes("[popup]"));
    expect(popupLine, list).toContain("(in use by session aaaaaaaa)");
  }, 60_000);

  it("closes only the calling session's tabs on browser_close; the browser stays for the other", async () => {
    const client = await start();
    await ok(client, A, "browser_navigate", { url: `${web.url}/a` });
    await ok(client, B, "browser_navigate", { url: `${web.url}/b` });
    await ok(client, A, "browser_tabs", { action: "new", url: `${web.url}/a2` });
    const closed = await ok(client, A, "browser_close");
    expect(closed).toContain("Closed 2 tabs of this session. The browser stays open");
    const list = await ok(client, B, "browser_tabs", { action: "list" });
    expect(list).toMatch(/- 0: \(current\) \[b\]/);
    expect(list).not.toContain("[a]");
    // A comes back with a fresh tab of its own.
    expect(await ok(client, A, "browser_navigate", { url: `${web.url}/again` })).toContain(`${web.url}/again`);
    expect(await ok(client, B, "browser_snapshot")).toContain('heading "Page b"');
  }, 60_000);

  it("caps open tabs per session: one session's new tabs never close another's", async () => {
    const client = await start(undefined, 2);
    await ok(client, B, "browser_navigate", { url: `${web.url}/b` });
    await ok(client, A, "browser_navigate", { url: `${web.url}/a1` });
    await ok(client, A, "browser_tabs", { action: "new", url: `${web.url}/a2` });
    const third = await ok(client, A, "browser_tabs", { action: "new", url: `${web.url}/a3` });
    expect(third).toContain("closed the least recently used tab");
    const list = await ok(client, B, "browser_tabs", { action: "list" });
    expect(list).toContain("[b]");
    expect(list).not.toContain("[a1]");
    expect(list).toContain("[a2]");
    expect(list).toContain("[a3]");
  }, 60_000);
});
