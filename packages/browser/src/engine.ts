import { resolve } from "node:path";
import type { Browser, BrowserContext } from "patchright-core";
import { readLockPid } from "./lifecycle.js";
import { type ClientInfo, type IdleTimerLike, type McpConfig, playwright, upstream } from "./upstream.js";

/**
 * Where the browser context behind an MCP session comes from (ADR 0043). The host asks an
 * engine for a context when a session first needs the browser, and again after the browser
 * closed (idle limit, `browser_close`); it never launches a browser any other way.
 *
 * - `chrome`: the default. turno launches the installed Chrome itself, as a Patchright
 *   persistent context on the profile it chose (the identity's, or a temporary one), with the
 *   launch options upstream would use, so the profile and the tools see the same browser.
 * - `upstream`: every other mode (`--isolated`, `--cdp-endpoint`, `--endpoint`, `--extension`,
 *   `--shared-browser-context`, another browser than Chromium), handed to upstream's
 *   `createBrowserWithInfo` exactly as the stock program does.
 *
 * Another engine (another browser, an attach mode) is one more `Engine` here; the host only
 * sees `LaunchedBrowser`.
 */

type EngineId = "chrome" | "upstream";

export interface LaunchedBrowser {
  engine: EngineId;
  /** The context the tools drive. */
  context: BrowserContext;
  /** The browser process, when turno started it and can name it. */
  pid?: number;
  /** Closes the session's browser (or leaves a shared one to the last session). */
  close(): Promise<void>;
  /** Closes the browser after the configured time without a tool call. */
  idleTimer?: IdleTimerLike;
}

export interface LaunchRequest {
  config: McpConfig;
  clientInfo: ClientInfo;
  /** The parsed command line options (upstream reads `--extension` details from them). */
  cliOptions: Record<string, unknown>;
  /** The session title the browser is bound under (`browser.bind`), "<client> (2)" for a second one. */
  title: string;
}

export interface Engine {
  id: EngineId;
  launch(request: LaunchRequest): Promise<LaunchedBrowser>;
}

/** Upstream's default idle limit for a headless browser it owns (`defaultIdleTimeout`). */
const HEADLESS_IDLE_MS = 60 * 60 * 1000;

/** Upstream's `IdleTimer`: every tool call restarts the countdown. */
class IdleTimer implements IdleTimerLike {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {}
  poke(): void {
    this.dispose();
    this.timer = setTimeout(this.onIdle, this.ms);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** True when the config asks for the browser the `chrome` engine launches. */
export function usesChromeEngine(config: McpConfig): boolean {
  const b = config.browser;
  return (
    b.browserName === "chromium" &&
    b.userDataDir !== undefined &&
    !b.isolated &&
    !b.cdpEndpoint &&
    !b.remoteEndpoint &&
    !config.extension &&
    !config.sharedBrowserContext
  );
}

async function profileLocked5Times(userDataDir: string): Promise<boolean> {
  const { tools } = upstream();
  for (let i = 0; i < 5; i++) {
    if (!tools.isProfileLocked(userDataDir)) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

/** Upstream's launch errors, word for word, so a user sees the same message as before. */
function launchError(error: Error, config: McpConfig, userDataDir: string, channel: string | undefined): Error {
  const message = error.message;
  if (message.includes("Executable doesn't exist")) {
    const target = message.includes("ffmpeg") ? "ffmpeg" : (config.browser.launchOptions.channel ?? config.browser.browserName);
    const label = target === "ffmpeg" ? "FFmpeg" : `Browser "${target}"`;
    const command = config.skillMode ? `playwright-cli install-browser ${target}` : `npx @playwright/mcp install-browser ${target}`;
    const match = message.match(/Executable doesn't exist at ([^\r\n]+)/);
    const location = match ? `; expected executable at ${match[1]!.trim()}` : "";
    return new Error(`${label} is not installed${location}. Run \`${command}\` to install`);
  }
  if (message.includes("cannot open shared object file: No such file or directory")) {
    const name = channel ?? config.browser.browserName;
    return new Error(`Missing system dependencies required to run browser ${name}. Install them with: sudo npx playwright install-deps ${name}`);
  }
  if (message.includes("ProcessSingleton") || message.includes("exitCode=21")) {
    return new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
  }
  return error;
}

/**
 * The installed Chrome on a persistent profile, launched by turno with the options upstream's
 * `createPersistentBrowser` uses: the resolved launch and context options, no signal handlers
 * of Playwright's own (the host's shutdown guard and upstream's exit watchdog close it), and
 * extensions allowed. It is bound like upstream's browser, so `playwright-cli` sees it too.
 */
const chromeEngine: Engine = {
  id: "chrome",
  async launch({ config, clientInfo, title }) {
    const userDataDir = config.browser.userDataDir;
    if (userDataDir === undefined) throw new Error("the chrome engine needs a profile directory");
    const { tools } = upstream();
    const tracesDir = resolve(tools.outputDir({ config, cwd: clientInfo.cwd }), "traces");
    if (await profileLocked5Times(userDataDir)) {
      throw new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
    }
    const ignore = config.browser.launchOptions.ignoreDefaultArgs;
    const launchOptions = {
      tracesDir,
      ...config.browser.launchOptions,
      ...config.browser.contextOptions,
      handleSIGINT: false,
      handleSIGTERM: false,
      ignoreDefaultArgs: ignore === true ? true : ["--disable-extensions", ...(Array.isArray(ignore) ? ignore : [])],
    };
    let context: BrowserContext;
    try {
      context = await playwright()[config.browser.browserName].launchPersistentContext(userDataDir, launchOptions);
    } catch (err) {
      throw launchError(err as Error, config, userDataDir, launchOptions.channel as string | undefined);
    }
    const browser = context.browser() as Browser;
    try {
      await browser.bind(title, { workspaceDir: clientInfo.cwd });
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
    const idleMs = config.timeouts?.idle ?? (config.browser.launchOptions.headless ? HEADLESS_IDLE_MS : undefined);
    let idleTimer: IdleTimer | undefined;
    if (idleMs) {
      const timer = new IdleTimer(idleMs, () => void browser.close().catch(() => {}));
      browser.once("disconnected", () => timer.dispose());
      idleTimer = timer;
    }
    const pid = readLockPid(userDataDir);
    return {
      engine: "chrome",
      context,
      ...(pid !== undefined ? { pid } : {}),
      ...(idleTimer ? { idleTimer } : {}),
      async close() {
        idleTimer?.dispose();
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  },
};

function remoteConnectOptions(config: McpConfig): Record<string, unknown> {
  const remote = config.browser.remoteEndpoint;
  const headers = config.browser.remoteHeaders;
  if (remote === undefined) return {};
  if (typeof remote === "string") return { headers };
  const { endpoint: _endpoint, ...options } = remote;
  return { ...options, headers: { ...headers, ...remote.headers } };
}

/**
 * Every mode turno does not launch itself goes through upstream's `createBrowserWithInfo`,
 * with the session handling of upstream's MCP program (`program.ts`): sessions share one
 * browser for `--shared-browser-context` and `--isolated`, and the last one to leave closes it.
 */
export function createUpstreamEngine(): Engine {
  let shared: Promise<Awaited<ReturnType<ReturnType<typeof upstream>["tools"]["createBrowserWithInfo"]>>> | undefined;
  let clients = 0;
  return {
    id: "upstream",
    async launch({ config, clientInfo, cliOptions, title }) {
      const { tools } = upstream();
      const useShared = config.sharedBrowserContext || config.browser.isolated;
      const bind = { title: clientInfo.clientName, workspaceDir: clientInfo.cwd };
      if (useShared && !shared) {
        const promise = tools.createBrowserWithInfo(config, clientInfo, cliOptions, bind).then(
          (info) => {
            info.browser.once("disconnected", () => {
              if (shared === promise) shared = undefined;
            });
            return info;
          },
          (error: unknown) => {
            if (shared === promise) shared = undefined;
            throw error;
          },
        );
        shared = promise;
      }
      clients++;
      const sharedPromise = shared;
      let sharedInfo: Awaited<NonNullable<typeof shared>> | undefined;
      let info: Awaited<NonNullable<typeof shared>>;
      let browser: Browser;
      try {
        sharedInfo = await sharedPromise;
        if (sharedInfo) {
          info = sharedInfo;
          browser = await sharedInfo.browser.browserType().connect(sharedInfo.endpoint, remoteConnectOptions(config));
        } else {
          info = await tools.createBrowserWithInfo(config, clientInfo, cliOptions, { ...bind, title });
          browser = info.browser;
        }
      } catch (error) {
        clients--;
        throw error;
      }
      let context: BrowserContext;
      try {
        context = config.browser.isolated
          ? await browser.newContext(config.browser.contextOptions)
          : (browser.contexts()[0] ?? (await browser.newContext(config.browser.contextOptions)));
      } catch (error) {
        clients--;
        await browser.close().catch(() => {});
        throw error;
      }
      return {
        engine: "upstream",
        context,
        ...(info.idleTimer ? { idleTimer: info.idleTimer } : {}),
        async close() {
          clients--;
          const last = !sharedInfo || !clients;
          if (last && shared === sharedPromise) shared = undefined;
          if (!last) {
            if (config.browser.isolated) await context.close().catch(() => {});
            await browser.close().catch(() => {});
            return;
          }
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
          await sharedInfo?.browser.close().catch(() => {});
        },
      };
    },
  };
}

/** The engine for this config. */
export function selectEngine(config: McpConfig, fallback: Engine): Engine {
  return usesChromeEngine(config) ? chromeEngine : fallback;
}
