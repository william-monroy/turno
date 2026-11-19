import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Page } from "patchright-core";
import type { SecretStore } from "turno-core/secrets";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { explainFailure } from "./diagnose.js";
import { type Engine, type EngineFlags, type IdentityRef, type LaunchedBrowser, createEngine } from "./engine.js";
import { TabGovernor, type TabView } from "./governor.js";
import {
  type HealthContext,
  NEEDS_AUTH_HOLD_MS,
  healthDue,
  needsAuthMessage,
  readHealth,
  runHealthCheck,
  writeHealth,
} from "./health.js";
import { HumanInput, adaptiveSites, humanizeTools } from "./human-input.js";
import { identityStateDir } from "./ids.js";
import { idleMs } from "./idle-timer.js";
import { FlowRecorder, type PendingStep, secretValues } from "./recorder.js";
import { Recording, tracesTmpDir } from "./recordings.js";
import { Redactor, SCRIPT_TOOLS, VaultGuard } from "./redact.js";
import { type ChallengeEvent, recordChallenge, watchChallenges } from "./reputation.js";
import { installResources } from "./resources.js";
import { SESSION_CAPABILITY, SESSION_ENDED_METHOD, SESSION_META_KEY, sessionFromMeta } from "./session.js";
import { type SessionView, TabSharing, viewConfig } from "./sharing.js";
import { DEFAULT_TAB_LOCKS, DIRECT_SESSION, type TabLockPolicy } from "./tab-locks.js";
import { type RecordSettings, readIdentitySettings } from "./settings.js";
import { type StockAccess, TURNO_TOOLS, type TurnoTool, checkTurnoTools, parseArguments } from "./tools.js";
import { type Tuning, type TuningFlags, resolveTuning } from "./tuning.js";
import { vaultHasSites } from "./vault.js";
import {
  type BrowserBackendInstance,
  type ClientInfo,
  type IdleTimerLike,
  type McpConfig,
  type ServerBackend,
  type ServerBackendFactory,
  type ToolResult,
  type ToolSchemaJson,
  type UpstreamTool,
  type ZodObject,
  backendContext,
  toMcpTool,
  upstream,
} from "./upstream.js";

/**
 * turno-browser as the MCP server host.
 *
 * The command line is parsed by upstream's own option definitions (`decorateMCPCommand`), so
 * every Playwright MCP flag, its help text and its errors stay as they were; only the action
 * is turno's. The config is resolved by upstream (`resolveCLIConfigForMCP`: file, environment,
 * flags). Then, per MCP session, a `SessionBackend`:
 *
 * - lists the stock tools (upstream's `filteredTools`, rendered like upstream renders them),
 *   then the turno tools, then the tools a page registers through WebMCP;
 * - launches the browser on the first call that needs it, through the engine module, and
 *   wraps the context in upstream's `BrowserBackend`, which runs every stock tool;
 * - after the browser closes (idle limit, `browser_close`, a crash) launches it again on the
 *   next call, with the same profile;
 * - runs the tab governor on that browser and wraps each stock call with it: a parked
 *   tab loads again before a call uses it, and what the governor did since the last call is
 *   added to the result; a click or type that fails because of the element gets an error that
 *   says what is in the way (`diagnose.ts`);
 * - gives each browser its own copy of the config, so the identity's `settle` and a batch's
 *   snapshot-free steps change only that session;
 * - with `"sharing": "tabs"`, serves several agent sessions (mcpd's `_meta["io.turno/session"]`)
 *   in that one browser, each with its own backend, current tab and tab locks (`sharing.ts`).
 *
 * stdio, the transport mcpd and every agent use, is served by turno with the MCP SDK.
 * `--port` keeps upstream's HTTP server (Host check, streamable HTTP and SSE) serving the
 * same session backends.
 */

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

/** The name and version the server reports in `initialize`. */
export const SERVER_INFO = { name: "turno-browser", version: PACKAGE_VERSION };

export interface HostOptions {
  config: McpConfig;
  cliOptions: Record<string, unknown>;
  /** Turno tools of this host (default: `TURNO_TOOLS`). */
  turnoTools?: readonly TurnoTool[];
  /** The engine for every launch, instead of the one the config selects (tests inject a fake). */
  engine?: Engine;
  /** The identity served (`--identity`): its runtime lock, settings, session health and reputation log. */
  identity?: IdentityRef;
  /** The `turno-browser-mcp` tab governor and throttling flags; they win over identity.json. */
  tuning?: TuningFlags;
  /** The secret store the vault reads (tests inject a fake); default: this machine's. */
  vaultStore?: SecretStore;
  /** With `"sharing": "tabs"`: how long a call waits for a held tab, and when an idle session lets go. */
  tabLocks?: Partial<TabLockPolicy>;
  /** `--engine` and `--attach`; they win over identity.json. */
  engineFlags?: EngineFlags;
}

export interface Host {
  config: McpConfig;
  /** Stock tools first, in upstream's order, then turno's. */
  listTools(): ToolSchemaJson[];
  factory: ServerBackendFactory;
  /** Hides vault values in a text this server is about to send. */
  redact(text: string): string;
}

/** Upstream joins the text parts of a result into one (`mergeTextParts`). */
export function mergeTextParts(result: ToolResult): ToolResult {
  const content: ToolResult["content"] = [];
  const texts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text") {
      texts.push((part as { text: string }).text);
      continue;
    }
    if (texts.length) {
      content.push({ type: "text", text: texts.join("\n") });
      texts.length = 0;
    }
    content.push(part);
  }
  if (texts.length) content.push({ type: "text", text: texts.join("\n") });
  return { ...result, content };
}

/**
 * Adds what the tab governor did to a stock tool's result: parked tabs are marked in a tab list,
 * and closed or parked tabs are listed in a last section (under `turno.tabs` in JSON).
 */
function withGovernor(
  result: ToolResult,
  governor: TabGovernor,
  json: boolean,
  owner?: string,
  view?: TabView,
): ToolResult {
  const notes = governor.takeNotes(owner);
  const first = result.content[0];
  if (!first || first.type !== "text") return result;
  let text = governor.annotateTabs((first as { text: string }).text, view);
  if (notes.length) {
    if (json) {
      try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        text = JSON.stringify({ ...payload, turno: { tabs: notes } }, null, 2);
      } catch {
        /* not JSON after all: leave it */
      }
    } else text += `\n### Tab governor\n${notes.map((n) => `- ${n}`).join("\n")}`;
  }
  return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
}

function errorResult(message: string, json: boolean): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}`,
      },
    ],
    isError: true,
  };
}

/**
 * One MCP session. Implements upstream's server backend contract, so upstream's HTTP server
 * can serve it as well as turno's stdio server.
 */
/** A session's running browser, as the host drives it. */
/**
 * The idle limit as a session sees it: it counts from the end of the last tool call and never
 * while one runs. Upstream's `BrowserBackend` pokes the timer at the start of a call only, so a
 * call that took longer than the limit (a slow page, a busy machine, a short `TURNO_BROWSER_IDLE`)
 * had Chrome closed under it and failed with "Target page, context or browser has been closed".
 */
export class CallIdleTimer implements IdleTimerLike {
  private calls = 0;
  constructor(
    private readonly inner: IdleTimerLike,
    /** False once the browser closed: counting again would only close it a second time. */
    private readonly open: () => boolean,
  ) {}

  /** Upstream's poke at the start of a call: ignored while a call holds the timer. */
  poke(): void {
    if (this.calls === 0 && this.open()) this.inner.poke();
  }

  /** Stops the countdown until the returned function runs (once) at the end of the call. */
  begin(): () => void {
    this.calls++;
    this.inner.dispose();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.calls--;
      this.poke();
    };
  }

  dispose(): void {
    this.inner.dispose();
  }
}

interface Running {
  backend: BrowserBackendInstance;
  /** The config this browser's `BrowserBackend` reads on every call (a copy per launch). */
  config: McpConfig;
  launched: LaunchedBrowser;
  governor: TabGovernor;
  tuning: Tuning;
  /** The idle limit, held by every call in flight. */
  idle?: CallIdleTimer;
  /** `"sharing": "tabs"`: each session's backend and its tab locks. */
  sharing?: TabSharing;
  /** Traces and screenshots of this browser, when identity.json `record` asks for them. */
  recording?: Recording;
}

class SessionBackend extends EventEmitter implements ServerBackend {
  private clientInfo: ClientInfo | undefined;
  private current: Promise<Running> | undefined;
  /** The backend of the running browser, for the WebMCP tools a page registers. */
  private live: BrowserBackendInstance | undefined;
  private launched: LaunchedBrowser | undefined;
  private disposed = false;
  /** identity.json `record` as of the last launch. */
  private recordSettings: RecordSettings | undefined;
  /** Each client session's flow recorder: a recording belongs to the session that started it. */
  private readonly recorders = new Map<string, FlowRecorder>();

  constructor(
    private readonly host: {
      config: McpConfig;
      cliOptions: Record<string, unknown>;
      stock: UpstreamTool[];
      stockSchemas: ReadonlyMap<string, ZodObject>;
      turno: Map<string, TurnoTool>;
      engine: Engine;
      identity?: IdentityRef;
      tuning: TuningFlags;
      redactor: Redactor;
      guard: VaultGuard;
      vaultStore?: SecretStore;
      tabLocks: TabLockPolicy;
      stockTypes: ReadonlyMap<string, string>;
    },
    private readonly title: (clientInfo: ClientInfo) => string,
  ) {
    super();
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this.clientInfo = clientInfo;
  }

  /** The flow recorder of a client session (identities only). */
  private recorderFor(session: string | undefined): FlowRecorder | undefined {
    const identity = this.host.identity;
    if (!identity) return undefined;
    const key = session ?? DIRECT_SESSION;
    let recorder = this.recorders.get(key);
    if (!recorder) {
      recorder = new FlowRecorder(identity, this.host.redactor, () => this.recordSettings?.flows === true);
      this.recorders.set(key, recorder);
    }
    return recorder;
  }

  dynamicTools(): ToolSchemaJson[] {
    return this.live?.dynamicTools() ?? [];
  }

  /** Before `initialize` (a call that skipped it), the process cwd, as upstream falls back to. */
  private info(): ClientInfo {
    return this.clientInfo ?? { cwd: process.cwd(), clientName: "Playwright MCP" };
  }

  /** The browser of this session, launched on first use and again after it closed. */
  private browser(): Promise<Running> {
    if (this.disposed) return Promise.reject(new Error("the session is closed"));
    if (this.current && this.launched && !this.launched.isOpen()) {
      // Closed (idle limit, crash) before Playwright reported it: let it go and launch again.
      const stale = this.current;
      this.current = undefined;
      this.live = undefined;
      this.launched = undefined;
      void stale.then(({ backend }) => backend.dispose()).catch(() => {});
    }
    if (this.current) return this.current;
    const clientInfo = this.info();
    const { config, cliOptions, stock, engine, identity } = this.host;
    const promise = (async (): Promise<Running> => {
      if (identity) refuseWhileNeedsAuth(identity);
      const settings = identity ? readIdentitySettings(identity.id, identity.env) : undefined;
      const tuning = resolveTuning(settings, this.host.tuning);
      this.recordSettings = settings?.record;
      const noTraces = config.capabilities?.includes("devtools")
        ? "the devtools capability records traces of its own"
        : undefined;
      const traces = identity && settings?.record?.traces && !noTraces;
      const title = this.title(clientInfo);
      const launched = await engine.launch({
        // Playwright writes a trace's raw files to tracesDir as it records: an identity's
        // recording keeps them in its own folder instead of the workspace (`recordings.ts`).
        config: traces
          ? {
              ...config,
              browser: {
                ...config.browser,
                launchOptions: { ...config.browser.launchOptions, tracesDir: tracesTmpDir(identity.id, identity.env) },
              },
            }
          : config,
        clientInfo,
        cliOptions,
        title,
        tuning,
        ...(identity ? { identity } : {}),
      });
      // Human-like input (off by default): the input tools of this browser run on humanized tabs.
      const input =
        tuning.humanize.level === "off"
          ? undefined
          : new HumanInput(tuning.humanize, {
              ...(identity ? { persona: identity.id, challenged: adaptiveSites(identity.id, identity.env) } : {}),
            });
      // Read mode and attach mode never use the identity's Chrome profile, so the profile's
      // health check, challenge log and resource rules do not apply to them.
      const profile = launched.engine !== "lightpanda" && launched.engine !== "attach";
      if (identity && profile) {
        try {
          await afterIdentityLaunch(identity, launched, (event) => input?.noteChallenge(event.site));
        } catch (error) {
          await launched.close().catch(() => {});
          throw error;
        }
      }
      const { BrowserBackend } = upstream().tools;
      const isCurrent = () => this.current === promise;
      let governor: TabGovernor | undefined;
      let sharing: TabSharing | undefined;
      let recording: Recording | undefined;
      const gone = () => {
        governor?.dispose();
        sharing?.dispose();
        if (isCurrent()) {
          this.current = undefined;
          this.live = undefined;
          this.launched = undefined;
        }
      };
      const sessionConfig = configForSession(config, cliOptions, tuning);
      const idle = launched.idleTimer ? new CallIdleTimer(launched.idleTimer, () => launched.isOpen()) : undefined;
      // Every backend of this browser (each session's too, with "sharing": "tabs") runs these tools.
      const tools = input ? humanizeTools(stock, input) : stock;
      const backend = new BrowserBackend(sessionConfig, launched.context, tools, {
        ...(idle ? { idleTimer: idle } : {}),
        dispose: async () => {
          gone();
          await recording?.close().catch(() => {});
          await launched.close();
        },
      });
      try {
        await backend.initialize(clientInfo);
        // After upstream's own routes (--allowed-origins, --blocked-origins), so this one runs
        // first and hands every request it does not block or serve on to them.
        if (identity && profile)
          await installResources(
            launched.context,
            tuning.resources,
            join(identityStateDir(identity.id, identity.env), "resource-cache"),
          );
        // Never in read or attach mode: the engine refuses traces and screenshots there first.
        const idleLimit = idleMs(sessionConfig);
        if (identity && profile && settings?.record)
          recording = await Recording.open({
            identity,
            settings: settings.record,
            context: launched.context,
            redactor: this.host.redactor,
            guard: this.host.guard,
            title,
            ...(noTraces ? { noTraces } : {}),
            ...(idleLimit ? { idleMs: idleLimit } : {}),
          });
      } catch (error) {
        await launched.close();
        throw error;
      }
      if (tuning.sharing === "tabs") {
        const forViews = viewConfig(sessionConfig);
        sharing = new TabSharing({
          context: launched.context,
          root: { backend, config: sessionConfig },
          policy: this.host.tabLocks,
          createView: async () => {
            const config = viewConfig(forViews);
            const view = new BrowserBackend(config, launched.context, tools, {});
            await view.initialize(clientInfo);
            return { backend: view, config };
          },
        });
      }
      const shared = sharing;
      governor = new TabGovernor(launched.context, tuning.tabs, {
        current: () => backendContext(backend)?.currentTab()?.page,
        tabs: () =>
          backendContext(backend)
            ?.tabs()
            .map((t) => t.page) ?? [],
        ...(shared
          ? {
              protected: () => shared.protectedPages(),
              owner: (page) => shared.owner(page),
              adopt: (page) => shared.adopt(page),
            }
          : {}),
        ...(launched.userBrowser ? { ownedOnly: true, onOwn: (page) => launched.own?.(page) } : {}),
      });
      governor.start();
      if (launched.userBrowser) {
        // The user's browser: the agent starts in a tab of its own, so its first navigation
        // never replaces one of the user's pages (upstream would pick the first open tab).
        try {
          const tab = await backendContext(backend)?.newTab();
          if (tab) governor.own(tab.page);
        } catch (error) {
          governor.dispose();
          await launched.close();
          throw error;
        }
      }
      backend.on("dynamictoolschange", () => this.emit("dynamictoolschange"));
      backend.once("disconnected", () => {
        recording?.abandon();
        gone();
        void backend.dispose().catch(() => {});
      });
      if (isCurrent()) {
        this.live = backend;
        this.launched = launched;
      }
      return {
        backend,
        config: sessionConfig,
        launched,
        governor,
        tuning,
        ...(idle ? { idle } : {}),
        ...(sharing ? { sharing } : {}),
        ...(recording ? { recording } : {}),
      };
    })();
    promise.catch(() => {
      if (this.current === promise) this.current = undefined;
    });
    this.current = promise;
    return promise;
  }

  /**
   * `session` is the client session mcpd put in the call's `_meta`. Only turno tools
   * see it; stock tools run exactly as before. Upstream's HTTP server (`--port`) never passes it.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    session?: string,
  ): Promise<ToolResult> {
    // Every result and error of this server leaves through the redactor.
    return this.host.redactor.result(await this.callAny(name, args, signal, session));
  }

  private async callAny(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    session?: string,
  ): Promise<ToolResult> {
    const tool = this.host.turno.get(name);
    if (!tool) return await this.callStock(name, args, signal, {}, session);
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    // A batch is refused up front when one of its steps would be, before the browser launches.
    const steps = name === "browser_batch" && Array.isArray(args.actions) ? (args.actions as { tool?: unknown }[]) : [];
    for (const tool of [name, ...steps.map((s) => s?.tool).filter((t): t is string => typeof t === "string")]) {
      const refusal = this.host.engine.refuse?.(tool, this.host.identity);
      if (refusal) return errorResult(refusal, json);
    }
    const parsed = parseArguments(tool, args);
    if ("error" in parsed) return errorResult(parsed.error, json);
    const clientInfo = this.info();
    let browserContext: LaunchedBrowser["context"] | undefined;
    let stock: StockAccess | undefined;
    let endCall: (() => void) | undefined;
    let shared: { sharing: TabSharing; view: SessionView; key: string } | undefined;
    let recording: Recording | undefined;
    if (tool.browser !== false) {
      const running = await this.browser();
      endCall = running.idle?.begin();
      browserContext = running.launched.context;
      let view: SessionView = { backend: running.backend, config: running.config };
      if (running.sharing) {
        // The tool works in the session's own tab, locked like a stock call's.
        const key = session ?? DIRECT_SESSION;
        running.sharing.locks.begin(key, name);
        try {
          view = await running.sharing.view(key);
          const refused = await running.sharing.before(key, name, {}, view, signal);
          if (refused) {
            running.sharing.locks.end(key);
            endCall?.();
            return errorResult(refused, json);
          }
        } catch (error) {
          running.sharing.locks.end(key);
          endCall?.();
          throw error;
        }
        shared = { sharing: running.sharing, view, key };
      }
      stock = this.stockAccess(view, signal, session);
      recording = running.recording;
    }
    const recorder = this.recorderFor(session);
    try {
      await recording?.beforeCall();
      const context = {
        config: this.host.config,
        clientInfo,
        ...(browserContext ? { browserContext } : {}),
        ...(stock ? { stock } : {}),
        ...(signal ? { signal } : {}),
        ...(session ? { session } : {}),
        ...(recorder ? { recorder } : {}),
        ...(recording ? { recording } : {}),
        ...(this.host.identity
          ? {
              vault: {
                identity: this.host.identity,
                redactor: this.host.redactor,
                guard: this.host.guard,
                ...(this.host.vaultStore ? { store: this.host.vaultStore } : {}),
                ...(recording ? { beforeFill: (page: Page) => recording.pauseForSecret(page) } : {}),
              },
            }
          : {}),
      };
      const result = await tool.handle(context, parsed.params);
      if (name === "browser_login") {
        if (!result.isError) recorder?.record("browser_login", { site: parsed.params.site });
        await recording?.afterStep({ tool: name, ok: !result.isError, screenshot: false });
      }
      return result;
    } catch (error) {
      return errorResult(String(error), json);
    } finally {
      recording?.callEnded();
      if (shared) {
        shared.sharing.after(shared.key, shared.view);
        shared.sharing.locks.end(shared.key);
      }
      endCall?.();
    }
  }

  /**
   * A stock tool through upstream's `BrowserBackend`, wrapped by the tab governor: a parked tab
   * the call is about to use loads again first, and with `backgroundThrottling` the current tab
   * comes to the front (a tab in the background would not render, and an action on it would
   * wait for its timeout).
   */
  private async callStock(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options: { snapshot?: boolean } = {},
    session?: string,
  ): Promise<ToolResult> {
    const refusal = this.host.engine.refuse?.(name, this.host.identity);
    if (refusal) return errorResult(refusal, !!(args._meta as { json?: boolean } | undefined)?.json);
    const running = await this.browser();
    const { governor, tuning, idle, sharing, launched } = running;
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    if (sharing) return await this.callShared(running, sharing, session ?? DIRECT_SESSION, name, args, signal, options);
    const endCall = idle?.begin();
    const { backend, config } = running;
    const refused = this.refuseScript(name, backend);
    if (refused) {
      endCall?.();
      return errorResult(refused, json);
    }
    const snapshot = config.snapshot ?? {};
    const mode = snapshot.mode;
    if (options.snapshot === false) config.snapshot = { ...snapshot, mode: "none" };
    governor.beginCall();
    let result: ToolResult;
    try {
      const pending = await this.beforeStock(running, session, name, args, backendContext(backend)?.currentTab()?.page);
      await governor.prepare(name, args);
      if (tuning.backgroundThrottling && !launched.userBrowser && name !== "browser_tabs")
        await backendContext(backend)
          ?.currentTab()
          ?.page.bringToFront()
          .catch(() => {});
      result = await backend.callTool(name, args, signal);
      if (result.isError)
        result = await explainFailure(backendContext(backend)?.currentTab()?.page, name, args, result, json);
      await this.afterStock(running, session, name, args, pending, result, backendContext(backend)?.currentTab()?.page);
      await governor.afterCall();
    } finally {
      running.recording?.callEnded();
      endCall?.();
      governor.endCall();
      if (options.snapshot === false) config.snapshot = { ...snapshot, ...(mode === undefined ? {} : { mode }) };
    }
    return withGovernor(result, governor, json);
  }

  /**
   * A stock call with `"sharing": "tabs"`: the same steps as `callStock`, on the session's own
   * backend, after its tab is locked (`sharing.ts`). `browser_close` closes only its tabs.
   */
  private async callShared(
    running: Running,
    sharing: TabSharing,
    key: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    options: { snapshot?: boolean },
  ): Promise<ToolResult> {
    const { governor, tuning, idle } = running;
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    // Counted first, so the session is active (and its backend kept) from the first await on.
    sharing.locks.begin(key, name);
    const endCall = idle?.begin();
    governor.beginCall();
    let view: SessionView | undefined;
    let result: ToolResult;
    let restore: (() => void) | undefined;
    try {
      view = await sharing.view(key);
      const { backend, config } = view;
      const refused = name === "browser_close" ? undefined : await sharing.before(key, name, args, view, signal);
      if (refused) result = errorResult(refused, json);
      else if (name === "browser_close") result = await sharing.close(key);
      else {
        const why = this.refuseScript(name, backend);
        if (why) result = errorResult(why, json);
        else {
          const snapshot = config.snapshot ?? {};
          const mode = snapshot.mode;
          if (options.snapshot === false) {
            config.snapshot = { ...snapshot, mode: "none" };
            restore = () => {
              config.snapshot = { ...snapshot, ...(mode === undefined ? {} : { mode }) };
            };
          }
          const tabs = sharing.tabView(view);
          const pending = await this.beforeStock(running, key, name, args, tabs.current());
          await governor.prepare(name, args, tabs);
          if (tuning.backgroundThrottling && name !== "browser_tabs")
            await tabs
              .current()
              ?.bringToFront()
              .catch(() => {});
          result = await backend.callTool(name, args, signal);
          if (result.isError) result = await explainFailure(tabs.current(), name, args, result, json);
          await this.afterStock(running, key, name, args, pending, result, tabs.current());
          // The tab the call left current is the session's before the cap counts its tabs.
          sharing.after(key, view);
          await governor.afterCall();
        }
      }
    } finally {
      running.recording?.callEnded();
      if (view && name !== "browser_close") sharing.after(key, view);
      sharing.locks.end(key);
      endCall?.();
      governor.endCall(view ? sharing.tabView(view) : undefined);
      restore?.();
    }
    if (!view || name === "browser_close") return result;
    const tabs = sharing.tabView(view);
    const annotated = withGovernor(result, governor, json, key, tabs);
    const first = annotated.content[0];
    if (!first || first.type !== "text") return annotated;
    const text = sharing.annotate((first as { text: string }).text, key, view);
    return { ...annotated, content: [{ ...first, text }, ...annotated.content.slice(1)] };
  }

  /**
   * Before a stock call: the flow step it may become (`recorder.ts`), and a trace stopped and
   * saved before a value goes into a secret field, as before a vault fill (`recordings.ts`).
   */
  private async beforeStock(
    running: Running,
    session: string | undefined,
    name: string,
    args: Record<string, unknown>,
    page: Page | undefined,
  ): Promise<PendingStep | undefined> {
    const { recording } = running;
    await recording?.beforeCall();
    const recorder = this.recorderFor(session);
    const pending = recorder?.active ? await recorder.capture(name, args, page).catch(() => undefined) : undefined;
    if (recording && page && (name === "browser_type" || name === "browser_fill_form")) {
      const secrets = await secretValues(page, name, args);
      if (secrets.length) {
        for (const v of secrets) this.host.redactor.add(v, "sensitive value");
        await recording.pauseForSecret(page);
      }
    }
    return pending;
  }

  /** After a stock call: keep the flow step when it worked, and the recording's screenshot. */
  private async afterStock(
    running: Running,
    session: string | undefined,
    name: string,
    args: Record<string, unknown>,
    pending: PendingStep | undefined,
    result: ToolResult,
    page: Page | undefined,
  ): Promise<void> {
    if (pending && !result.isError) this.recorderFor(session)?.commit(pending);
    const type = this.host.stockTypes.get(name);
    if (running.recording && type !== "readOnly" && type !== "assertion")
      await running.recording.afterStep({
        tool: name,
        element: args.element ?? args.startElement,
        ok: !result.isError,
        ...(page ? { page } : {}),
        screenshot: true,
      });
  }

  /**
   * The script tools near the vault: `browser_evaluate` and `browser_run_code_unsafe`
   * are refused on a page browser_login filled, until it navigates; `browser_run_code_unsafe`
   * runs code in this process, which can read the secret store, so it is refused for an
   * identity that has vault credentials at all.
   */
  private refuseScript(name: string, backend: BrowserBackendInstance): string | undefined {
    if (!SCRIPT_TOOLS.has(name)) return undefined;
    const identity = this.host.identity;
    if (name === "browser_run_code_unsafe" && identity && vaultHasSites(identity.id, identity.env)) {
      return `${name} is refused for browser identity "${identity.id}" because it has vault credentials: it runs code in the server process, which can read the secret store. Use the other browser tools, or an identity without a vault.`;
    }
    if (this.host.guard.holds(backendContext(backend)?.currentTab()?.page)) {
      return `${name} is refused on this page: it holds values browser_login filled from the vault (or a password typed while recording). Submit the form or navigate away first.`;
    }
    return undefined;
  }

  /** The stock tools of this session, for a turno tool that runs them (`browser_batch`). */
  private stockAccess(view: SessionView, signal?: AbortSignal, session?: string): StockAccess {
    return {
      schemas: this.host.stockSchemas,
      formatError: (error) => upstream().utils.z.prettifyError(error),
      call: (name, args, options) => this.callStock(name, args, signal, options, session),
      page: async () => {
        const page = backendContext(view.backend)?.currentTab()?.page;
        if (!page) return undefined;
        return { url: page.url(), title: await page.title().catch(() => "") };
      },
      currentPage: () => backendContext(view.backend)?.currentTab()?.page,
    };
  }

  /** mcpd said a client session ended: with `"sharing": "tabs"` its tabs are free at once. */
  async endSession(session: string): Promise<void> {
    // A flow the session was recording and never stopped is dropped with it.
    this.recorders.get(session)?.cancel();
    this.recorders.delete(session);
    const current = this.current;
    if (!current) return;
    const running = await current.catch(() => undefined);
    await running?.sharing?.endSession(session);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.current;
    this.current = undefined;
    this.live = undefined;
    this.launched = undefined;
    if (current) await current.then(({ backend }) => backend.dispose()).catch(() => {});
  }
}

/**
 * The config of one launch: a copy, so a change for this session (a batch's snapshot-free
 * steps) does not reach another, with the identity's `settle` unless the user set
 * Playwright's own `--timeout-settle`, `PLAYWRIGHT_MCP_TIMEOUT_SETTLE` or `timeouts.settle` in a
 * config file, which win.
 */
export function configForSession(config: McpConfig, cliOptions: Record<string, unknown>, tuning: Tuning): McpConfig {
  const timeouts = { ...config.timeouts };
  if (tuning.settleMs !== undefined && !userSetSettle(config, cliOptions)) timeouts.settle = tuning.settleMs;
  return { ...config, timeouts, snapshot: { ...config.snapshot } };
}

function userSetSettle(config: McpConfig, cliOptions: Record<string, unknown>): boolean {
  if (cliOptions.timeoutSettle !== undefined) return true;
  if (!config.configFile) return false;
  try {
    const file = JSON.parse(readFileSync(resolve(config.configFile), "utf8")) as { timeouts?: { settle?: unknown } };
    return file.timeouts?.settle !== undefined;
  } catch {
    return false;
  }
}

/** After NEEDS_AUTH, fail at once for a short while instead of opening Chrome on every call. */
function refuseWhileNeedsAuth(identity: IdentityRef): void {
  const health = readIdentitySettings(identity.id, identity.env)?.health;
  const last = readHealth(identity.id, identity.env);
  if (
    health &&
    last?.status === "needs_auth" &&
    last.url === health.url &&
    Date.now() - Date.parse(last.checkedAt) < NEEDS_AUTH_HOLD_MS
  ) {
    throw new Error(needsAuthMessage(identity.id, last));
  }
}

/**
 * Once an identity's Chrome runs: watch its pages for challenges (the reputation
 * log) and, when identity.json has a health check that is due, run it; a page without the
 * proof of a signed-in session throws NEEDS_AUTH, and the call fails with that message.
 */
async function afterIdentityLaunch(
  identity: IdentityRef,
  launched: LaunchedBrowser,
  onChallenge?: (event: Omit<ChallengeEvent, "ts">) => void,
): Promise<void> {
  const { id, env } = identity;
  watchChallenges(launched.context, (event) => {
    onChallenge?.(event);
    try {
      recordChallenge(id, env, event);
    } catch {
      /* the log is best effort; a full disk must not break a tool call */
    }
  });
  const check = readIdentitySettings(id, env)?.health;
  if (!check || !healthDue(readHealth(id, env), check)) return;
  const record = await runHealthCheck(launched.context as unknown as HealthContext, check);
  writeHealth(id, env, record);
  if (record.status === "needs_auth") {
    process.stderr.write(`turno-browser-mcp: ${id} needs a new sign-in (${record.detail} at ${record.url})\n`);
    throw new Error(needsAuthMessage(id, record));
  }
}

/** Builds the host for a resolved config: tool list, engine and session factory. */
export function createHost(options: HostOptions): Host {
  const { tools } = upstream();
  const { config, cliOptions } = options;
  const stock = tools.filteredTools(config);
  const stockSchemas = new Map(stock.map((t) => [t.schema.name, t.schema.inputSchema]));
  const stockTypes = new Map(stock.map((t) => [t.schema.name, t.schema.type]));
  const turnoTools = options.turnoTools ?? TURNO_TOOLS;
  checkTurnoTools(turnoTools, tools.browserTools);
  const turno = new Map(turnoTools.map((t) => [t.schema.name, t]));
  const engine = options.engine ?? createEngine(config, options.engineFlags);
  const schemas = [...stock.map((t) => t.schema), ...turnoTools.map((t) => t.schema)];
  const sessionsByName = new Map<string, number>();
  const title = (clientInfo: ClientInfo) => {
    const count = (sessionsByName.get(clientInfo.clientName) ?? 0) + 1;
    sessionsByName.set(clientInfo.clientName, count);
    return count > 1 ? `${clientInfo.clientName} (${count})` : clientInfo.clientName;
  };
  const redactor = new Redactor();
  const shared = {
    config,
    cliOptions,
    stock,
    stockSchemas,
    stockTypes,
    turno,
    engine,
    tuning: options.tuning ?? {},
    redactor,
    guard: new VaultGuard(),
    tabLocks: { ...DEFAULT_TAB_LOCKS, ...options.tabLocks },
    ...(options.identity ? { identity: options.identity } : {}),
    ...(options.vaultStore ? { vaultStore: options.vaultStore } : {}),
  };
  return {
    config,
    redact: (text) => redactor.text(text),
    listTools: () => schemas.map(toMcpTool),
    factory: {
      name: SERVER_INFO.name,
      nameInConfig: "playwright",
      version: SERVER_INFO.version,
      toolSchemas: schemas,
      create: async () => new SessionBackend(shared, title),
    },
  };
}

/** The workspace roots the client offers, as upstream reads them (first root, or cwd). */
async function clientInfoOf(server: Server): Promise<ClientInfo> {
  let cwd = process.cwd();
  if (server.getClientCapabilities()?.roots) {
    const { roots } = await server.listRoots().catch(() => ({ roots: [] as { uri: string }[] }));
    for (const root of roots) {
      try {
        cwd = fileURLToPath(new URL(root.uri));
        break;
      } catch {
        /* not a file URL: try the next root */
      }
    }
  }
  return { cwd, clientName: server.getClientVersion()?.name ?? "Playwright MCP" };
}

/** An MCP server for one session of this host, on any transport. */
function createServer(host: Host): Server {
  // The experimental capability asks mcpd to say when a client session ends (`session.ts`).
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: true }, experimental: { [SESSION_CAPABILITY]: {} } },
  });
  let backend: Promise<SessionBackend> | undefined;
  const session = () => {
    backend ??= (async () => {
      const clientInfo = await clientInfoOf(server);
      const b = (await host.factory.create(clientInfo)) as SessionBackend;
      await b.initialize(clientInfo);
      b.on("dynamictoolschange", () => void server.sendToolListChanged().catch(() => {}));
      return b;
    })();
    backend.catch(() => {
      backend = undefined;
    });
    return backend;
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const live = await backend?.catch(() => undefined);
    return { tools: [...host.listTools(), ...(live?.dynamicTools() ?? [])] as ToolSchemaJson[] as never };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    try {
      const b = await session();
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await b.callTool(request.params.name, args, extra.signal, sessionFromMeta(request.params._meta));
      return mergeTextParts(result) as CallToolResult;
    } catch (error) {
      return { content: [{ type: "text", text: `### Error\n${host.redact(String(error))}` }], isError: true };
    }
  });
  server.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== SESSION_ENDED_METHOD) return;
    const session = sessionFromMeta({ [SESSION_META_KEY]: notification.params?.session });
    if (session !== undefined) await (await backend?.catch(() => undefined))?.endSession(session);
  };
  const previous = server.onclose;
  server.onclose = () => {
    previous?.();
    void backend?.then((b) => b.dispose()).catch(() => {});
  };
  return server;
}

/** Serves the host: stdio by turno, `--port` by upstream's HTTP server. */
export async function serve(host: Host, transport?: Transport): Promise<Server | undefined> {
  if (host.config.server.port !== undefined && !transport) {
    await upstream().tools.start(host.factory, host.config.server);
    return undefined;
  }
  const server = createServer(host);
  await server.connect(transport ?? new StdioServerTransport());
  return server;
}

/**
 * Parses the Playwright MCP flags with upstream's definitions and serves them with turno's
 * host. Mirrors the action of upstream's program: exit watchdog, `--vision`, `tracing`, config.
 */
export async function runHost(
  args: string[],
  options: { identity?: IdentityRef; tuning?: TuningFlags; engineFlags?: EngineFlags } = {},
): Promise<void> {
  const { utils, core, version } = upstream();
  const { identity, tuning, engineFlags } = options;
  const Command = utils.program.constructor;
  const program = new Command().version(`Version ${version}`).name("Playwright MCP");
  upstream().tools.decorateMCPCommand(program);
  program.action(async (options) => {
    upstream().tools.setupExitWatchdog();
    if (options.vision) {
      console.error("The --vision option is deprecated, use --caps=vision instead");
      options.caps ??= [];
      (options.caps as string[]).push("vision");
    }
    if ((options.caps as string[] | undefined)?.includes("tracing")) (options.caps as string[]).push("devtools");
    const config = await upstream().tools.resolveCLIConfigForMCP(options);
    await serve(
      createHost({
        config,
        cliOptions: options,
        ...(identity ? { identity } : {}),
        ...(tuning ? { tuning } : {}),
        ...(engineFlags ? { engineFlags } : {}),
      }),
    );
  });
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    console.error((error as Error).message);
    core.utils.gracefullyProcessExitDoNotHang(1);
  }
}
