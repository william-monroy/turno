import { execFileSync } from "node:child_process";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { POPUP_GRACE_MS } from "../src/governor.js";
import { writeIdentitySettings } from "../src/settings.js";
import { chromeUnavailable, killSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The browser tools of ADR 0048 against a real Google Chrome, through the built server: the tab
 * governor (popups, cap, parking) and background throttling. Every Chrome runs on a profile in
 * the test's sandbox HOME; cleanup only signals processes whose command line names it.
 *
 * Skipped, with the reason in the suite name, when Chrome is missing or cannot start (or with
 * TURNO_SKIP_CHROME=1).
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

beforeAll(() => {
  if (reason) return;
  execFileSync(join(pkg, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], { cwd: pkg, stdio: "inherit" });
}, 120_000);

let sb: Sandbox;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  killSandboxProcesses(sb.home);
  sb.cleanup();
});

async function start(id: string, args: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    // Headless: on CI runners a headed Chrome stalls on new windows (a click on a target=_blank
    // link waits out its timeout). ADR 0048 has the headed measurements.
    args: [bin, "--identity", id, "--headless", ...args],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "browser-tools", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return textOf(res);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pages for the tests, on 127.0.0.1. `requested` maps each path and query to when it was asked for. */
async function site(): Promise<{ url: string; requested: Map<string, number>; close(): Promise<void> }> {
  const requested = new Map<string, number>();
  const pages: Record<string, string> = {
    "/plain": "<title>plain</title><p>plain page</p>",
    "/a": "<title>page A</title><h1>Page A</h1>",
    "/b": "<title>page B</title><h1>Page B</h1>",
    // A click that opens a window 3.5 s later: Chrome's popup blocker lets it through (the
    // click's user activation lasts 5 s), and the tool call is usually over by then.
    "/delayed-popup": `<title>delayed</title><button onclick="setTimeout(() => window.open('/plain?ad'), 3500)">Download</button>`,
    "/link": `<title>link</title><a href="/b" target="_blank">Open B</a><button onclick="document.title='clicked'">Press</button>`,
    // Timer ticks in the last second, and whether the page was ever hidden, kept in the DOM (a
    // stock tool's evaluate runs in an isolated world).
    "/busy": `<title>busy</title><script>
      document.addEventListener("visibilitychange", () => { if (document.hidden) document.documentElement.dataset.hidden = "seen"; });
      const ticks = [];
      (function tick() {
        const now = performance.now(); ticks.push(now);
        while (ticks[0] < now - 1000) ticks.shift();
        document.documentElement.dataset.rate = String(ticks.length);
        setTimeout(tick, 4);
      })();
    </script>busy`,
  };
  const server: Server = createServer((req, res) => {
    requested.set(req.url ?? "/", Date.now());
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[new URL(req.url ?? "/", "http://x").pathname] ?? "<title>404</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, requested, close: () => new Promise((r) => server.close(() => r())) };
}

describe.skipIf(reason !== undefined)(reason ? `browser tools on real Chrome (skipped: ${reason})` : "browser tools on real Chrome", () => {
  it("closes a popup that opens after the tool call ended, and keeps the window a click opened", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    // New windows can take seconds on CI runners: give the clicks that open one time.
    const client = await start("popups", ["--timeout-action", "20000"]);
    await call(client, "browser_navigate", { url: `${web.url}/link` });
    const opened = await call(client, "browser_click", { target: "a", element: "Open B link" });
    expect(opened).toMatch(/^- 1: /m);

    await call(client, "browser_navigate", { url: `${web.url}/delayed-popup` });
    await call(client, "browser_click", { target: "button", element: "Download button" });
    const ended = Date.now();
    // Wait for the popup's request without a tool call (a call would make it the agent's).
    const deadline = ended + 30_000;
    while (!web.requested.has("/plain?ad") && Date.now() < deadline) await sleep(100);
    const at = web.requested.get("/plain?ad");
    expect(at, "the page opened its popup").toBeDefined();
    await sleep(1_000);
    const list = await call(client, "browser_tabs", { action: "list" });
    if (at! - ended > POPUP_GRACE_MS + 250) {
      expect(list).toContain(`closed a popup that ${web.url}/delayed-popup opened while no tool call was running`);
      expect(list).not.toContain("?ad");
      expect(list.match(/^- \d+:/gm)).toHaveLength(2);
    } else {
      // A slow runner ended the click late: the popup came within the grace period, so it is the
      // agent's and stays.
      expect(list).toContain("?ad");
    }
  }, 120_000);

  it("keeps at most --max-tabs pages, closing the least recently used", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    const client = await start("cap", ["--max-tabs", "2"]);
    await call(client, "browser_navigate", { url: `${web.url}/a` });
    await call(client, "browser_tabs", { action: "new", url: `${web.url}/b` });
    const third = await call(client, "browser_tabs", { action: "new", url: `${web.url}/plain` });
    expect(third).toContain(`closed the least recently used tab (${web.url}/a): more than 2 were open`);
    const list = await call(client, "browser_tabs", { action: "list" });
    expect(list.match(/^- \d+:/gm)).toHaveLength(2);
    expect(list).toContain("[page B]");
    expect(list).toContain("(current) [plain]");
  }, 60_000);

  it("parks an unused tab on about:blank, loads it again when selected, and closes a tab unused past close", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    writeIdentitySettings("parking", { tabs: { park: "2s", close: "8s" } }, sb.env);
    const client = await start("parking");
    await call(client, "browser_navigate", { url: `${web.url}/a` });
    await call(client, "browser_tabs", { action: "new", url: `${web.url}/b` });
    await sleep(4_000);
    const list = await call(client, "browser_tabs", { action: "list" });
    expect(list).toContain(`- 0: [](about:blank) (parked, was ${web.url}/a: selecting it loads that page again)`);
    expect(list).toContain(`parked a tab unused for`);

    const selected = await call(client, "browser_tabs", { action: "select", index: 0 });
    expect(selected).toContain(`loaded ${web.url}/a again in a tab that was parked`);
    expect(selected).toContain("- 0: (current) [page A]");
    const snap = await call(client, "browser_snapshot");
    expect(snap).toContain('heading "Page A"');

    // Tab 1 (page B) is not used from here on; tab 0 stays current.
    await sleep(9_000);
    const after = await call(client, "browser_tabs", { action: "list" });
    expect(after).toMatch(/closed a tab unused for \d+ seconds \(/);
    expect(after.match(/^- \d+:/gm)).toHaveLength(1);
  }, 90_000);

  it("keeps background tabs at full speed by default", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    const client = await start("fullspeed");
    await call(client, "browser_navigate", { url: `${web.url}/busy` });
    await call(client, "browser_tabs", { action: "new", url: `${web.url}/plain` });
    await sleep(4_000);
    await call(client, "browser_tabs", { action: "select", index: 0 });
    const state = await call(client, "browser_evaluate", { function: "() => JSON.stringify(document.documentElement.dataset)" });
    // Focus emulation keeps it visible, and its timers at full speed: about 200 ticks a second
    // locally, 18 and up on slow CI runners (throttled it is 1 or 2).
    expect(state).not.toContain("hidden");
    expect(Number(/rate\\":\\"(\d+)/.exec(state)?.[1])).toBeGreaterThan(10);
  }, 60_000);

  it("with --background-throttling, slows a tab in the background and still acts at once on the current tab", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    const client = await start("throttled", ["--background-throttling"]);
    await call(client, "browser_navigate", { url: `${web.url}/busy` });
    await call(client, "browser_tabs", { action: "new", url: `${web.url}/plain` });
    await sleep(4_000);
    await call(client, "browser_tabs", { action: "select", index: 0 });
    // Chrome saw it hidden, so it throttled it (1 to 10 timer ticks a second locally; how much is
    // Chrome's budget, which varies on CI runners).
    expect(await call(client, "browser_evaluate", { function: "() => document.documentElement.dataset.hidden" })).toContain('"seen"');

    // A click that opens a window puts that window in front while the agent stays on its tab;
    // the next action on the agent's tab must not wait for a frame that never comes.
    await call(client, "browser_navigate", { url: `${web.url}/link` });
    await call(client, "browser_click", { target: "a", element: "Open B link" });
    const t0 = Date.now();
    await call(client, "browser_click", { target: "button", element: "Press button" });
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(await call(client, "browser_evaluate", { function: "() => document.title" })).toContain('"clicked"');
  }, 60_000);
});
