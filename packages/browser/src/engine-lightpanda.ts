import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Browser, BrowserContext } from "patchright-core";
import { findOnPath } from "turno-core/paths";
import { startCdpRelay } from "./cdp-relay.js";
import type { Engine, LaunchedBrowser } from "./engine.js";
import { IdleTimer, idleMs } from "./idle-timer.js";
import { identityStateDir } from "./ids.js";
import { playwright, upstream } from "./upstream.js";

/**
 * Read mode: the `lightpanda` engine. Lightpanda is a headless browser written from
 * scratch for automation (no rendering, a small fraction of Chrome's memory) that speaks CDP.
 * turno never downloads it: it runs the `lightpanda` found through `TURNO_LIGHTPANDA_PATH` or
 * on PATH, and `turno browser doctor` says how to install it.
 *
 * Per launch turno starts `lightpanda serve` on a Unix socket in a fresh private folder (no TCP
 * port), with Lightpanda's telemetry off, and connects Patchright to it through the CDP relay
 * (`cdp-relay.ts`), in a new browser context: Lightpanda's default context holds a startup
 * target that cannot navigate. Closing the session closes the context and stops the process.
 *
 * For an identity, Lightpanda keeps its own cookies in `<state>/browser/identities/<id>/
 * lightpanda-cookies.json` (loaded at start, saved when the context closes). It never reads or
 * writes the identity's Chrome profile, so read mode takes no runtime lock and runs no health
 * check, challenge log, resource blocking or cache: those belong to the Chrome profile.
 *
 * Only the tools in `READ_MODE_TOOLS` run (the docs list them). Every other tool is refused
 * before it reaches the browser, with the reason and a pointer to the Chrome engine.
 */

/**
 * The tools read mode runs: each was checked against Lightpanda 1.1 (nightly) through
 * Patchright with local pages. Clicks follow links, but a link that opens a new tab
 * (`target="_blank"`) does nothing there.
 */
export const READ_MODE_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_hover",
  "browser_type",
  "browser_press_key",
  "browser_select_option",
  "browser_fill_form",
  "browser_evaluate",
  "browser_wait_for",
  "browser_tabs",
  "browser_network_requests",
  "browser_network_request",
  "browser_console_messages",
  "browser_close",
  "browser_batch",
]);

/** Why read mode refuses a tool, for the tools that need more than a read. */
const NOT_IN_READ_MODE: Readonly<Record<string, string>> = {
  browser_take_screenshot:
    "Lightpanda does not lay pages out, so a screenshot shows only their text; use browser_snapshot",
  browser_resize: "Lightpanda does not lay pages out, so there is no window to resize",
  browser_emulate_media: "Lightpanda does not lay pages out, so media emulation changes nothing visible",
  browser_handle_dialog: "Lightpanda closes alert, confirm and prompt dialogs by itself",
  browser_drag: "dragging needs a laid out page",
  browser_drop: "dropping needs a laid out page",
  browser_file_upload: "read mode does not upload files",
  browser_run_code_unsafe: "read mode runs only the reading tools",
  browser_login: "read mode keeps no vault sign-ins; it is meant for public pages",
};

/** Why read mode refuses this tool, or undefined when it runs it. */
export function readModeRefusal(tool: string): string | undefined {
  if (READ_MODE_TOOLS.has(tool)) return undefined;
  const why = NOT_IN_READ_MODE[tool] ?? "it was not checked against Lightpanda";
  return (
    `${tool} is not available in read mode (the Lightpanda engine): ${why}. ` +
    "Use the Chrome engine for it (`turno browser set <id> --engine chrome`, or start the server without `--engine lightpanda`)."
  );
}

/** How to install Lightpanda on this platform, for errors and `turno browser doctor`. */
export function lightpandaInstallHint(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "darwin") return "brew install lightpanda-io/browser/lightpanda";
  if (platform === "linux") {
    const file = arch === "arm64" ? "lightpanda-aarch64-linux" : "lightpanda-x86_64-linux";
    return `download https://github.com/lightpanda-io/browser/releases/download/nightly/${file}, make it executable and put it on PATH (or set TURNO_LIGHTPANDA_PATH)`;
  }
  return "Lightpanda has no build for this platform (on Windows, use WSL)";
}

export interface LightpandaInfo {
  path: string;
  version?: string;
}

/** The Lightpanda binary turno would run: `TURNO_LIGHTPANDA_PATH`, else `lightpanda` on PATH. */
export function findLightpanda(env: NodeJS.ProcessEnv = process.env): LightpandaInfo | undefined {
  const configured = env.TURNO_LIGHTPANDA_PATH?.trim();
  const path = configured
    ? isAbsolute(configured) && findOnPath(configured, env) && statSync(configured).isFile()
      ? configured
      : undefined
    : findOnPath("lightpanda", env);
  if (!path) return undefined;
  try {
    const out = execFileSync(path, ["version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
    }).trim();
    return out ? { path, version: out.split("\n")[0]!.trim() } : { path };
  } catch {
    return { path };
  }
}

/** The error when Lightpanda is missing, with the install command. */
export function lightpandaMissing(env: NodeJS.ProcessEnv): Error {
  const configured = env.TURNO_LIGHTPANDA_PATH?.trim();
  const where = configured
    ? `TURNO_LIGHTPANDA_PATH (${configured}) is not an executable file with an absolute path`
    : "lightpanda is not on PATH";
  return new Error(
    `read mode needs Lightpanda, and ${where}. Install it: ${lightpandaInstallHint()}. turno never downloads it for you; \`turno browser doctor\` checks it.`,
  );
}

/** Where an identity's read mode keeps its cookies. */
export function lightpandaCookieJar(id: string, env: NodeJS.ProcessEnv): string {
  return join(identityStateDir(id, env), "lightpanda-cookies.json");
}

async function waitForSocket(path: string, child: ChildProcess, stderr: () => string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`lightpanda serve exited before it was ready: ${stderr().trim().split("\n").pop() ?? ""}`);
    if (Date.now() > end) throw new Error(`lightpanda serve did not start within ${ms / 1000}s`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * A fresh private folder for the two sockets. A Unix socket path has a short limit (104 bytes
 * on macOS), so a long TMPDIR falls back to /tmp; the folder is mode 700 either way.
 */
function socketDir(env: NodeJS.ProcessEnv): string {
  const base = env.TMPDIR || tmpdir();
  const fits = join(base, "turno-lightpanda-XXXXXX", "relay.sock").length <= 100;
  return mkdtempSync(join(fits || process.platform === "win32" ? base : "/tmp", "turno-lightpanda-"));
}

/** Every Lightpanda this process started, stopped when it exits (an exit handler is sync). */
const children = new Set<ChildProcess>();
let exitHook = false;

export function createLightpandaEngine(): Engine {
  return {
    id: "lightpanda",
    refuse: readModeRefusal,
    async launch({ config, identity }): Promise<LaunchedBrowser> {
      const env = identity?.env ?? process.env;
      const found = findLightpanda(env);
      if (!found) throw lightpandaMissing(env);
      const dir = socketDir(env);
      chmodSync(dir, 0o700);
      const socket = join(dir, "cdp.sock");
      const args = ["serve", "--unix-socket", socket, "--log-level", "warn", "--cdp-max-message-size", "67108864"];
      if (identity) {
        mkdirSync(identityStateDir(identity.id, identity.env), { recursive: true, mode: 0o700 });
        const jar = lightpandaCookieJar(identity.id, identity.env);
        if (existsSync(jar)) args.push("--cookie", jar);
        args.push("--cookie-jar", jar);
      }
      let output = "";
      const child = spawn(found.path, args, {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      });
      child.stderr?.on("data", (d: Buffer) => {
        output = (output + d.toString()).slice(-4000);
      });
      children.add(child);
      if (!exitHook) {
        exitHook = true;
        process.on("exit", () => {
          for (const c of children) c.kill("SIGKILL");
        });
      }
      const stop = () => {
        child.kill("SIGTERM");
        children.delete(child);
        rmSync(dir, { recursive: true, force: true });
      };
      let browser: Browser;
      let context: BrowserContext;
      let relay: Awaited<ReturnType<typeof startCdpRelay>> | undefined;
      try {
        await waitForSocket(socket, child, () => output, 10_000);
        relay = await startCdpRelay(join(dir, "relay.sock"), socket);
        browser = await playwright().chromium.connectOverCDP(relay.endpoint, { timeout: 15_000 });
        context = await browser.newContext(config.browser.contextOptions);
      } catch (error) {
        await relay?.close().catch(() => {});
        stop();
        throw new Error(`could not start read mode: ${(error as Error).message.split("\n")[0]}`);
      }
      let closing = false;
      child.once("exit", () => {
        closing = true;
      });
      let idleTimer: IdleTimer | undefined;
      const close = async () => {
        upstream().core.utils.gracefullyCloseSet.delete(close);
        idleTimer?.dispose();
        if (!closing || browser.isConnected()) {
          closing = true;
          // Closing the context is what makes Lightpanda write the cookie jar.
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        }
        await relay?.close().catch(() => {});
        stop();
      };
      // The exit watchdog awaits this before the process exits: the jar is written, Lightpanda stops.
      upstream().core.utils.gracefullyCloseSet.add(close);
      const ms = idleMs(config);
      if (ms) idleTimer = new IdleTimer(ms, () => void close());
      return {
        engine: "lightpanda",
        context,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...(idleTimer ? { idleTimer } : {}),
        isOpen: () => !closing && browser.isConnected(),
        close,
      };
    },
  };
}
