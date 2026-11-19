import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findLightpanda, lightpandaCookieJar } from "../src/engine-lightpanda.js";
import { writeIdentitySettings } from "../src/settings.js";
import { waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Read mode against a real Lightpanda, through the built server and a local fixture server.
 * Skipped when no Lightpanda is installed (`lightpanda` on PATH or `TURNO_LIGHTPANDA_PATH`), or
 * with `TURNO_SKIP_LIGHTPANDA=1`; CI does not install it. Every Lightpanda runs with a TMPDIR of
 * the test's own, so cleanup finds it by that path.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const found = process.env.TURNO_SKIP_LIGHTPANDA === "1" ? undefined : findLightpanda(process.env);
const reason =
  process.env.TURNO_SKIP_LIGHTPANDA === "1"
    ? "TURNO_SKIP_LIGHTPANDA=1"
    : found
      ? undefined
      : "Lightpanda is not installed (lightpanda on PATH or TURNO_LIGHTPANDA_PATH)";

const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/set") {
      res.setHeader("set-cookie", "reader=kept; Path=/; Max-Age=3600");
      res.end(html("Set", "<p>cookie set</p>"));
    } else if (req.url === "/two") res.end(html("Two", "<h1>Second page</h1>"));
    else res.end(html("One", '<h1>First page</h1><p>Some text</p><a href="/two">to two</a>'));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let sb: Sandbox;
let tmp: string;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
  // Short, so the socket path fits (a long TMPDIR would fall back to /tmp).
  tmp = mkdtempSync("/tmp/tlp-");
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  for (const pid of lightpandas()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  sb.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

/** Lightpanda processes this test started (their socket is under the sandbox's TMPDIR). */
function lightpandas(): number[] {
  const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter((l) => l.includes(tmp) && l.includes("serve"))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

async function start(args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, ...args],
    env: {
      ...(sb.env as Record<string, string>),
      TMPDIR: tmp,
      TURNO_LIGHTPANDA_PATH: found!.path,
    },
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "lightpanda-test", version: "0.0.0" });
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

describe.skipIf(reason)(`read mode with a real Lightpanda${reason ? ` (skipped: ${reason})` : ""}`, () => {
  it("reads and follows links, refuses a screenshot, and stops Lightpanda on browser_close", async () => {
    const client = await start(["--engine", "lightpanda"]);
    await call(client, "browser_navigate", { url: `${base}/` });
    const snapshot = await call(client, "browser_snapshot");
    expect(snapshot).toContain('heading "First page"');
    const ref = /link "to two" \[ref=([^\]]+)\]/.exec(snapshot)![1]!;
    await call(client, "browser_click", { element: "to two", target: ref });
    expect(await call(client, "browser_evaluate", { function: "() => document.title" })).toContain('"Two"');
    expect(lightpandas()).toHaveLength(1);

    const shot = await client.callTool({ name: "browser_take_screenshot", arguments: {} });
    expect(shot.isError).toBe(true);
    expect(textOf(shot)).toMatch(/not available in read mode.*browser_snapshot/);

    await call(client, "browser_close");
    expect(await waitFor(() => lightpandas().length === 0, 10_000)).toBe(true);
    // The next call starts it again.
    await call(client, "browser_navigate", { url: `${base}/two` });
    expect(lightpandas()).toHaveLength(1);
  }, 60_000);

  it("keeps an identity's cookies in its own jar between runs, mode private", async () => {
    sb.write(".local/share/turno/browser/identities/reader/.keep", "");
    writeIdentitySettings("reader", { engine: "lightpanda" }, sb.env);
    let client = await start(["--identity", "reader"]);
    await call(client, "browser_navigate", { url: `${base}/set` });
    await running.pop()!.close();
    const jar = lightpandaCookieJar("reader", sb.env);
    expect(await waitFor(() => existsSync(jar), 10_000)).toBe(true);
    expect(readFileSync(jar, "utf8")).toContain("reader");
    expect(statSync(join(jar, "..")).mode & 0o077).toBe(0);

    client = await start(["--identity", "reader"]);
    await call(client, "browser_navigate", { url: `${base}/` });
    expect(await call(client, "browser_evaluate", { function: "() => document.cookie" })).toContain("reader=kept");
  }, 60_000);
});
