import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The agent cursor on a real Google Chrome, through the built server: with `--cursor on` the
 * page gets the overlay, the model's snapshot and read text never hold it, a click under it
 * still lands, and the model's screenshot is taken with it hidden; with `--cursor off`, and
 * with `auto` on a headless Chrome, the page gets nothing at all. Every Chrome runs headless on
 * a profile in the test's sandbox HOME.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

let sb: Sandbox;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

async function start(id: string, args: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless", ...args],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "Cursor Test Agent", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type Part = { type: string; text?: string; data?: string };

function textOf(res: unknown): string {
  return ((res as { content: Part[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return textOf(res);
}

/** The value a browser_evaluate returned. */
async function evaluate<T>(client: Client, fn: string): Promise<T> {
  const text = await call(client, "browser_evaluate", { function: fn });
  const m = /### Result\n([\s\S]*?)(?:\n###|$)/.exec(text);
  if (!m) throw new Error(`no result in ${text}`);
  return JSON.parse(m[1]!.trim()) as T;
}

/** The ref of the element whose snapshot line holds `label`. */
function refOf(snapshot: string, label: string): string {
  const line = snapshot.split("\n").find((l) => l.includes(label));
  const m = line && /\[ref=(e\d+)\]/.exec(line);
  if (!m) throw new Error(`no ref for ${label} in\n${snapshot}`);
  return m[1]!;
}

// The page's own script (the main world) logs what it sees of the overlay: the host element as
// it is added, and every change of its style, so the test knows it was hidden for the screenshot.
const PAGE = `<title>cursor</title>
<style>body { margin: 0; font: 16px sans-serif } #go { position: absolute; left: 300px; top: 200px; width: 160px; height: 44px }
#name { position: absolute; left: 300px; top: 120px }</style>
<input id="name" aria-label="Your name"><button id="go">Sign in</button>
<script>
  const log = { clicks: 0, hosts: 0, visibility: [] };
  // Kept in a data attribute: the observer below watches only children and style.
  const save = () => { document.body.dataset.log = JSON.stringify(log); };
  document.getElementById("go").addEventListener("click", () => { log.clicks++; save(); });
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeName === "TURNO-AGENT-CURSOR") log.hosts++;
      if (r.type === "attributes" && r.target.nodeName === "TURNO-AGENT-CURSOR") log.visibility.push(r.target.style.visibility);
    }
    save();
  }).observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ["style"], subtree: true });
  save();
</script>`;

async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) };
}

interface PageLog {
  clicks: number;
  hosts: number;
  visibility: string[];
}

const pageLog = (client: Client) => evaluate<PageLog>(client, "() => JSON.parse(document.body.dataset.log)");

/** What the overlay shows, read from the utility world where browser_evaluate runs too. */
interface OverlayState {
  connected: boolean;
  cursors: string[];
}
const overlayState = (client: Client) =>
  evaluate<OverlayState | null>(
    client,
    "() => { const p = window.__turnoAgentCursor; return p ? { connected: p.host.isConnected, cursors: [...p.cursors.values()].map((c) => c.label) } : null; }",
  );

describe.skipIf(reason !== undefined)(
  reason ? `the agent cursor on real Chrome (skipped: ${reason})` : "the agent cursor on real Chrome",
  () => {
    it("draws the cursor with --cursor on, out of the snapshot and the text, without blocking a click", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("drawn", ["--cursor", "on"]);
      await call(client, "browser_navigate", { url: web.url });
      const snapshot = await call(client, "browser_snapshot");
      await call(client, "browser_type", { element: "Your name", target: refOf(snapshot, "Your name"), text: "Ada" });
      await call(client, "browser_click", { element: "Sign in", target: refOf(snapshot, "Sign in") });

      const log = await pageLog(client);
      expect(log.clicks).toBe(1);
      expect(log.hosts).toBe(1);
      const state = await overlayState(client);
      expect(state?.connected).toBe(true);
      expect(state?.cursors).toEqual(["Cursor Test Agent · drawn"]);

      const after = await call(client, "browser_snapshot");
      expect(after).not.toMatch(/turno|at work|Cursor Test Agent/);
      const text = await evaluate<string>(client, "() => document.body.innerText");
      expect(text).not.toMatch(/turno|at work|Cursor Test Agent/);
    });

    it("hides the overlay while the model's screenshot is taken, then shows it again", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("shot", ["--cursor", "on"]);
      await call(client, "browser_navigate", { url: web.url });
      const res = await client.callTool({ name: "browser_take_screenshot", arguments: {} });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      expect((res.content as Part[]).some((c) => c.type === "image")).toBe(true);
      const log = await pageLog(client);
      // Each change of the host's style after it was built: hidden for the shot, then visible.
      expect(log.visibility).toEqual(["hidden", "visible"]);
    });

    it("leaves the page alone with --cursor off, and with auto on a headless Chrome", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      for (const [id, args] of [
        ["off", ["--cursor", "off"]],
        ["auto", []],
      ] as const) {
        const client = await start(id, [...args]);
        await call(client, "browser_navigate", { url: web.url });
        const snapshot = await call(client, "browser_snapshot");
        await call(client, "browser_click", { element: "Sign in", target: refOf(snapshot, "Sign in") });
        const log = await pageLog(client);
        expect(log).toEqual({ clicks: 1, hosts: 0, visibility: [] });
        expect(await overlayState(client)).toBeNull();
        expect(await evaluate<boolean>(client, "() => document.querySelector('turno-agent-cursor') === null")).toBe(
          true,
        );
      }
    });
  },
);
