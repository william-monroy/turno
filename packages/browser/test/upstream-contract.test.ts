import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildArgv } from "../src/argv.js";
import { mcpEntryPath } from "../src/patchright.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * What turno-browser relies on in the Playwright MCP program bundled in patchright-core
 * (ADR 0003, ADR 0042). An upgrade that changes any of it fails here, not in a user's session:
 * the tool names agents see, the config keys and precedence of the generated `--config`, the
 * idle timer that honors `timeouts.idle` even when headed, and the exit watchdog.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const bundlePath = join(dirname(mcpEntryPath()), "..", "coreBundle.js");

interface McpTools {
  resolveCLIConfigForMCP(options: Record<string, unknown>, env?: NodeJS.ProcessEnv): Promise<{ timeouts: { idle?: number }; configFile?: string }>;
  createBrowserWithInfo: (...args: unknown[]) => unknown;
  setupExitWatchdog: () => void;
}
const tools = (createRequire(import.meta.url)(bundlePath) as { tools: McpTools }).tools;

/** The tools a default `turno-browser-mcp` serves, in the order it lists them. */
const TOOL_NAMES = [
  "browser_close",
  "browser_resize",
  "browser_console_messages",
  "browser_handle_dialog",
  "browser_emulate_media",
  "browser_evaluate",
  "browser_file_upload",
  "browser_drop",
  "browser_find",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_navigate",
  "browser_navigate_back",
  "browser_network_requests",
  "browser_network_request",
  "browser_run_code_unsafe",
  "browser_take_screenshot",
  "browser_snapshot",
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
  "browser_wait_for",
];

beforeAll(() => {
  execFileSync(join(pkg, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], { cwd: pkg, stdio: "inherit" });
}, 120_000);

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("upstream contract (patchright-core 1.64.3)", () => {
  it("pins the version this contract was written against", () => {
    const version = JSON.parse(readFileSync(join(dirname(bundlePath), "..", "package.json"), "utf8")).version;
    expect(version).toBe("1.64.3");
  });

  it("serves exactly these tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--identity", "contract"],
      env: sb.env as Record<string, string>,
      cwd: sb.home,
      stderr: "pipe",
    });
    const client = new Client({ name: "contract", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools: listed } = await client.listTools();
      expect(listed.map((t) => t.name)).toEqual(TOOL_NAMES);
    } finally {
      await client.close();
    }
  });

  it("reads timeouts.idle from the generated config, and lets --idle-timeout and the env win", async () => {
    const built = buildArgv(["--identity", "contract"], { env: { ...sb.env, TURNO_BROWSER_IDLE: "2s" } });
    const file = sb.write("cfg/mcp-config.json", JSON.stringify(built.config?.data));
    const fromFile = await tools.resolveCLIConfigForMCP({ config: file }, {});
    expect(fromFile.timeouts.idle).toBe(2000);
    expect(fromFile.configFile).toBe(file);
    expect((await tools.resolveCLIConfigForMCP({ config: file, idleTimeout: 0 }, {})).timeouts.idle).toBe(0);
    expect((await tools.resolveCLIConfigForMCP({ config: file }, { PLAYWRIGHT_MCP_IDLE_TIMEOUT: "5000" })).timeouts.idle).toBe(5000);
  });

  it("starts the idle timer from timeouts.idle whatever the headless setting", () => {
    // Headless gets a one hour default; headed gets none unless the config sets one.
    const src = tools.createBrowserWithInfo.toString();
    expect(src).toMatch(/const idleTimeout = config\.timeouts\?\.idle \?\? \(/);
    expect(src).toMatch(/new IdleTimer\(idleTimeout, \(\) => info\.browser\.close\(\)/);
  });

  it("closes the browser when stdin closes or on SIGINT and SIGTERM, within 15 seconds", () => {
    const src = tools.setupExitWatchdog.toString();
    expect(src).toMatch(/process\.stdin\.on\("close"/);
    expect(src).toMatch(/process\.on\("SIGTERM"/);
    expect(src).toMatch(/setTimeout\(\(\) => \(0, import_bootstrap\d*\.processExit\)\(0\), 15e3\)/);
  });

  it("still accepts the flags turno passes or documents", () => {
    const help = execFileSync(process.execPath, [bin, "--help"], { env: sb.env, encoding: "utf8" });
    for (const flag of ["--browser <browser>", "--user-data-dir <path>", "--config <path>", "--idle-timeout <timeout>", "--isolated", "--headless"]) {
      expect(help).toContain(flag);
    }
  });
});
