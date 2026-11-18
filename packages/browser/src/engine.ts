import { resolve } from "node:path";
import type { Browser, BrowserContext } from "patchright-core";
import { findProfileChrome, readLockPid } from "./lifecycle.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { launchSettings, readIdentitySettings, systemTimezone } from "./settings.js";
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
  /**
   * False once the browser started closing (idle limit, a crash). Playwright may report the
   * close a moment after Chrome has exited, so the host asks before reusing a browser.
   */
  isOpen(): boolean;
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
  /** The identity whose profile this is (`--identity`), for its settings and runtime lock. */
  identity?: IdentityRef;
}

/** A browser identity as the host knows it: its id and the environment that locates its files. */
export interface IdentityRef {
  id: string;
  env: NodeJS.ProcessEnv;
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

/** For an identity, who holds the profile instead of upstream's generic "already in use". */
function profileInUse(identity: IdentityRef | undefined, userDataDir: string): Error {
  if (!identity) return new Error(`Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`);
  const chrome = findProfileChrome(userDataDir);
  const who = chrome ? `a Chrome that turno-browser-mcp did not start (pid ${chrome.pid})` : "another Chrome";
  return new Error(
    `browser identity "${identity.id}" is in use by ${who}: a Chrome opened by hand on this profile, or a login from an older turno. ` +
      `Close it, then try again; \`turno browser doctor\` shows who holds each identity.`,
  );
}

/**
 * The installed Chrome on a persistent profile, launched by turno with the options upstream's
 * `createPersistentBrowser` uses: the resolved launch and context options, no signal handlers
 * of Playwright's own (the host's shutdown guard and upstream's exit watchdog close it), and
 * extensions allowed. It is bound like upstream's browser, so `playwright-cli` sees it too.
 *
 * For an identity (ADR 0044) it also takes the identity's runtime lock before Chrome starts,
 * records Chrome's PID and process group in it, gives it back when Chrome closes, and applies
 * identity.json: languages and locale as Chrome flags, the time zone as `timezoneId`.
 */
const chromeEngine: Engine = {
  id: "chrome",
  async launch({ config, clientInfo, title, identity }) {
    const userDataDir = config.browser.userDataDir;
    if (userDataDir === undefined) throw new Error("the chrome engine needs a profile directory");
    const { tools } = upstream();
    const tracesDir = resolve(tools.outputDir({ config, cwd: clientInfo.cwd }), "traces");
    const settings = identity ? readIdentitySettings(identity.id, identity.env) : undefined;
    const held = identity ? acquireRuntimeLock(identity.id, identity.env, { holder: "mcp" }) : undefined;
    let context: BrowserContext;
    let browser: Browser;
    try {
      if (await profileLocked5Times(userDataDir)) throw profileInUse(identity, userDataDir);
      const ignore = config.browser.launchOptions.ignoreDefaultArgs;
      const userArgs = (config.browser.launchOptions.args as string[] | undefined) ?? [];
      const applied = launchSettings(settings, userArgs, systemTimezone(), config.browser.contextOptions);
      const launchOptions = {
        tracesDir,
        ...config.browser.launchOptions,
        ...config.browser.contextOptions,
        ...(applied.args.length ? { args: [...userArgs, ...applied.args] } : {}),
        ...(applied.timezoneId ? { timezoneId: applied.timezoneId } : {}),
        handleSIGINT: false,
        handleSIGTERM: false,
        ignoreDefaultArgs: ignore === true ? true : ["--disable-extensions", ...(Array.isArray(ignore) ? ignore : [])],
      };
      try {
        context = await playwright()[config.browser.browserName].launchPersistentContext(userDataDir, launchOptions);
      } catch (err) {
        throw launchError(err as Error, config, userDataDir, launchOptions.channel as string | undefined);
      }
      browser = context.browser() as Browser;
      try {
        await browser.bind(title, { workspaceDir: clientInfo.cwd });
      } catch (err) {
        await browser.close().catch(() => {});
        throw err;
      }
    } catch (err) {
      held?.release();
      throw err;
    }
    let closing = false;
    const idleMs = config.timeouts?.idle ?? (config.browser.launchOptions.headless ? HEADLESS_IDLE_MS : undefined);
    let idleTimer: IdleTimer | undefined;
    if (idleMs) {
      const timer = new IdleTimer(idleMs, () => {
        closing = true;
        void browser.close().catch(() => {});
      });
      browser.once("disconnected", () => timer.dispose());
      idleTimer = timer;
    }
    const pid = readLockPid(userDataDir);
    if (held) {
      // Playwright starts Chrome as the leader of its own process group; ps confirms it.
      const pgid = pid !== undefined ? (findProfileChrome(userDataDir)?.pgid ?? pid) : undefined;
      held.update({ ...(pid !== undefined ? { chromePid: pid } : {}), ...(pgid !== undefined ? { pgid } : {}) });
      browser.once("disconnected", () => held.release());
    }
    return {
      engine: "chrome",
      context,
      ...(pid !== undefined ? { pid } : {}),
      ...(idleTimer ? { idleTimer } : {}),
      isOpen: () => !closing && browser.isConnected(),
      async close() {
        closing = true;
        idleTimer?.dispose();
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        held?.release();
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
        isOpen: () => browser.isConnected(),
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
