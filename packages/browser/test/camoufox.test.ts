import { existsSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { camoufoxProfileDir, findPlaywrightCore } from "../src/engine-camoufox.js";
import { addIdentity } from "../src/identities.js";
import { listRecordings } from "../src/recordings.js";
import { writeIdentitySettings } from "../src/settings.js";
import { killSandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type FakeSecretStore, fakeSecretStore } from "./helpers/fake-secret-store.js";
import { localProxy } from "./helpers/local-proxy.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The camoufox engine against a real Firefox build, through the built server: every stock tool
 * once, on a page the test serves on 127.0.0.1. It runs only when TURNO_CAMOUFOX_PATH names a
 * Camoufox (or another Playwright-compatible Firefox build) and TURNO_PLAYWRIGHT_CORE a stock
 * playwright-core of patchright-core's minor version; turno never downloads either, and neither
 * does this test. The browser runs headless on a throwaway profile in the sandbox HOME.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const exe = process.env.TURNO_CAMOUFOX_PATH;
const core = process.env.TURNO_PLAYWRIGHT_CORE;
const reason = !exe
  ? "TURNO_CAMOUFOX_PATH is not set"
  : !isAbsolute(exe) || !existsSync(exe)
    ? `TURNO_CAMOUFOX_PATH (${exe}) is not a file`
    : !core || !findPlaywrightCore({ TURNO_PLAYWRIGHT_CORE: core })?.ok
      ? "TURNO_PLAYWRIGHT_CORE does not name a playwright-core of patchright-core's minor version"
      : undefined;

const PAGE = `<title>fox</title>
<h1>Camoufox page</h1>
<a href="/second">Second page</a>
<form><label>Name <input name="name"></label>
<label>Agree <input type="checkbox" name="agree"></label>
<label>Color <select name="color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
<label>File <input type="file" name="file"></label></form>
<button onclick="document.getElementById('out').textContent='clicked'">Press</button>
<button onclick="setTimeout(() => alert('hello'), 0)">Alert</button>
<div id="src" draggable="true">Drag me</div>
<div id="dst" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.getElementById('out').textContent='dropped'">Drop here</div>
<p id="out">idle</p>
<script>console.log('fox-console')</script>`;

let web: Server;
let base = "";
beforeAll(async () => {
  web = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/second" ? "<title>second</title><p>Second page</p>" : PAGE);
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((r) => web.close(() => r(undefined)));
});

let sb: Sandbox;
let store: FakeSecretStore;
const proxies: Server[] = [];
/** The server's stderr, shown when a call fails. */
let serverLog = "";
const running: StdioClientTransport[] = [];
beforeEach(() => {
  serverLog = "";
  sb = sandbox();
  store = fakeSecretStore(sb);
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  killSandboxProcesses(sb.home);
  for (const p of proxies.splice(0)) {
    p.closeAllConnections();
    await new Promise((r) => p.close(() => r(undefined)));
  }
  sb.cleanup();
});

async function start(args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--headless", ...args],
    env: { ...sb.env, TURNO_CAMOUFOX_PATH: exe!, TURNO_PLAYWRIGHT_CORE: core! } as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d: Buffer) => {
    serverLog += d.toString();
  });
  running.push(transport);
  const client = new Client({ name: "camoufox", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args }).catch((error: Error) => {
    throw new Error(`${name}: ${error.message}\nserver stderr:\n${serverLog}`);
  });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

function ref(snapshot: string, role: string, name: string): string {
  const line = snapshot.split("\n").find((l) => l.includes(`${role} "${name}"`) && /\[ref=/.test(l));
  const m = line && /\[ref=([^\]]+)\]/.exec(line);
  if (!m) throw new Error(`no ${role} "${name}" in ${snapshot}`);
  return m[1]!;
}

describe.skipIf(reason)("the camoufox engine with a real Firefox build", () => {
  it("runs every stock tool but browser_run_code_unsafe", async () => {
    const client = await start(["--engine", "camoufox"]);
    const ok = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(client, name, args);
      expect(r.error, `${name}: ${r.text}`).toBe(false);
      return r.text;
    };
    await ok("browser_navigate", { url: base });
    const snap = await ok("browser_snapshot");
    expect(snap).toContain("Camoufox page");
    expect(await ok("browser_find", { text: "Drop here" })).toContain("Drop here");
    expect(await ok("browser_evaluate", { function: "() => navigator.userAgent" })).toMatch(/Firefox\//);
    await ok("browser_type", { target: ref(snap, "textbox", "Name"), text: "Ada" });
    await ok("browser_fill_form", {
      fields: [{ name: "Agree", type: "checkbox", target: ref(snap, "checkbox", "Agree"), value: "true" }],
    });
    await ok("browser_select_option", { target: ref(snap, "combobox", "Color"), values: ["blue"] });
    await ok("browser_hover", { target: ref(snap, "button", "Press") });
    await ok("browser_click", { target: ref(snap, "button", "Press") });
    await ok("browser_wait_for", { text: "clicked" });
    await ok("browser_press_key", { key: "Tab" });
    await ok("browser_drag", { startTarget: "#src", endTarget: "#dst" });
    await ok("browser_drop", { target: "#dst", data: { "text/plain": "hello" } });
    const file = join(sb.home, "upload.txt");
    writeFileSync(file, "upload");
    await ok("browser_click", { target: 'input[type="file"]' });
    await ok("browser_file_upload", { paths: [file] });
    await ok("browser_click", { target: ref(snap, "button", "Alert") });
    await ok("browser_handle_dialog", { accept: true });
    expect(await ok("browser_console_messages")).toContain("fox-console");
    expect(await ok("browser_network_requests", { static: true })).toContain(base);
    await ok("browser_network_request", { index: 1 });
    await ok("browser_emulate_media", { colorScheme: "dark" });
    await ok("browser_take_screenshot");
    await ok("browser_resize", { width: 900, height: 700 });
    await ok("browser_navigate", { url: `${base}/second` });
    await ok("browser_navigate_back");
    await ok("browser_tabs", { action: "new", url: `${base}/second` });
    expect(await ok("browser_tabs", { action: "list" })).toContain("second");
    await ok("browser_tabs", { action: "close" });
    await ok("browser_batch", {
      actions: [{ tool: "browser_navigate", arguments: { url: base } }, { tool: "browser_snapshot" }],
    });
    const refused = await call(client, "browser_run_code_unsafe", { code: "async (page) => 1" });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/not available with the Camoufox engine/);
    await ok("browser_close");
  }, 180_000);

  it("keeps an identity's Firefox profile apart from its Chrome profile", async () => {
    addIdentity("fox", sb.env);
    writeIdentitySettings("fox", { engine: "camoufox", languages: ["de-DE", "de"] }, sb.env);
    const client = await start(["--identity", "fox"]);
    expect((await call(client, "browser_navigate", { url: base })).error).toBe(false);
    const langs = await call(client, "browser_evaluate", { function: "() => navigator.languages.join(',')" });
    expect(langs.text).toContain("de-DE,de");
    expect(existsSync(camoufoxProfileDir("fox", sb.env))).toBe(true);
    await call(client, "browser_close");
  }, 90_000);

  it("sends an identity's traffic through its proxy, with the password from the secret store", async () => {
    const password = "F0x proxy&<pass>";
    const proxy = await localProxy("alice", password, async (server) => {
      proxies.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return (server.address() as { port: number }).port;
    });
    store.write("fox-proxy", password);
    addIdentity("fox", sb.env);
    writeIdentitySettings(
      "fox",
      { engine: "camoufox", proxy: { server: proxy.server, username: "alice", password: "keychain:fox-proxy" } },
      sb.env,
    );
    const client = await start(["--identity", "fox"]);
    const nav = await call(client, "browser_navigate", { url: base });
    expect(nav.error, nav.text).toBe(false);
    expect(proxy.seen.relayed).toContain("/");
    const listed = await call(client, "browser_network_requests", { static: true });
    const detail = await call(client, "browser_network_request", { index: 1 });
    for (const r of [nav, listed, detail]) {
      expect(r.text.includes(password)).toBe(false);
      expect(r.text.includes(Buffer.from(`alice:${password}`).toString("base64"))).toBe(false);
    }
    await call(client, "browser_close");
  }, 90_000);

  it("works with humanize and recordings, and with tab sharing", async () => {
    addIdentity("fox", sb.env);
    writeIdentitySettings(
      "fox",
      {
        engine: "camoufox",
        humanize: { level: "light", seed: 1 },
        record: { flows: true, traces: true, screenshots: true },
      },
      sb.env,
    );
    const client = await start(["--identity", "fox"]);
    const nav = await call(client, "browser_navigate", { url: base });
    expect(nav.error, nav.text).toBe(false);
    const snap = (await call(client, "browser_snapshot")).text;
    for (const [name, args] of [
      ["browser_type", { target: ref(snap, "textbox", "Name"), text: "Ada" }],
      ["browser_click", { target: ref(snap, "button", "Press") }],
      ["browser_wait_for", { text: "clicked" }],
    ] as const) {
      const r = await call(client, name, args);
      expect(r.error, `${name}: ${r.text}`).toBe(false);
    }
    await call(client, "browser_close");
    const ended = await waitFor(() => listRecordings("fox", sb.env)[0]?.ended !== undefined, 15_000);
    expect(ended, `${JSON.stringify(listRecordings("fox", sb.env))}\n${serverLog}`).toBe(true);
    const [rec] = listRecordings("fox", sb.env);
    expect(rec!.traces.length, JSON.stringify(rec)).toBeGreaterThanOrEqual(1);
    expect(rec!.screenshots).toBeGreaterThan(0);

    addIdentity("shared", sb.env);
    writeIdentitySettings("shared", { engine: "camoufox", sharing: "tabs" }, sb.env);
    const tabs = await start(["--identity", "shared"]);
    const opened = await call(tabs, "browser_navigate", { url: base });
    expect(opened.error, opened.text).toBe(false);
    expect((await call(tabs, "browser_snapshot")).text).toContain("Camoufox page");
  }, 90_000);
});
