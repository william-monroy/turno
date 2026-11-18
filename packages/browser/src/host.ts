import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Engine, type IdentityRef, type LaunchedBrowser, createUpstreamEngine, selectEngine } from "./engine.js";
import { TabGovernor } from "./governor.js";
import { type HealthContext, NEEDS_AUTH_HOLD_MS, healthDue, needsAuthMessage, readHealth, runHealthCheck, writeHealth } from "./health.js";
import { recordChallenge, watchChallenges } from "./reputation.js";
import { sessionFromMeta } from "./session.js";
import { readIdentitySettings } from "./settings.js";
import { TURNO_TOOLS, type TurnoTool, checkTurnoTools, parseArguments } from "./tools.js";
import { type Tuning, type TuningFlags, resolveTuning } from "./tuning.js";
import {
  type BrowserBackendInstance,
  type ClientInfo,
  type McpConfig,
  type ServerBackend,
  type ServerBackendFactory,
  type ToolResult,
  type ToolSchemaJson,
  type UpstreamTool,
  backendContext,
  toMcpTool,
  upstream,
} from "./upstream.js";

/**
 * turno-browser as the MCP server host (ADR 0043).
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
 * - runs the tab governor on that browser and wraps each stock call with it (ADR 0048): a parked
 *   tab loads again before a call uses it, and what the governor did since the last call is
 *   added to the result.
 *
 * stdio, the transport mcpd and every agent use, is served by turno with the MCP SDK.
 * `--port` keeps upstream's HTTP server (Host check, streamable HTTP and SSE) serving the
 * same session backends.
 */

const PACKAGE_VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }).version;

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
  /** The `turno-browser-mcp` flags of ADR 0048; they win over identity.json. */
  tuning?: TuningFlags;
}

export interface Host {
  config: McpConfig;
  /** Stock tools first, in upstream's order, then turno's. */
  listTools(): ToolSchemaJson[];
  factory: ServerBackendFactory;
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
function withGovernor(result: ToolResult, governor: TabGovernor, json: boolean): ToolResult {
  const notes = governor.takeNotes();
  const first = result.content[0];
  if (!first || first.type !== "text") return result;
  let text = governor.annotateTabs((first as { text: string }).text);
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
    content: [{ type: "text", text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}` }],
    isError: true,
  };
}

/**
 * One MCP session. Implements upstream's server backend contract, so upstream's HTTP server
 * can serve it as well as turno's stdio server.
 */
/** A session's running browser, as the host drives it. */
interface Running {
  backend: BrowserBackendInstance;
  launched: LaunchedBrowser;
  governor: TabGovernor;
  tuning: Tuning;
}

class SessionBackend extends EventEmitter implements ServerBackend {
  private clientInfo: ClientInfo | undefined;
  private current: Promise<Running> | undefined;
  /** The backend of the running browser, for the WebMCP tools a page registers. */
  private live: BrowserBackendInstance | undefined;
  private launched: LaunchedBrowser | undefined;
  private disposed = false;

  constructor(
    private readonly host: {
      config: McpConfig;
      cliOptions: Record<string, unknown>;
      stock: UpstreamTool[];
      turno: Map<string, TurnoTool>;
      engine: Engine;
      identity?: IdentityRef;
      tuning: TuningFlags;
    },
    private readonly title: (clientInfo: ClientInfo) => string,
  ) {
    super();
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this.clientInfo = clientInfo;
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
      const tuning = resolveTuning(identity ? readIdentitySettings(identity.id, identity.env) : undefined, this.host.tuning);
      const launched = await engine.launch({ config, clientInfo, cliOptions, title: this.title(clientInfo), tuning, ...(identity ? { identity } : {}) });
      if (identity) {
        try {
          await afterIdentityLaunch(identity, launched);
        } catch (error) {
          await launched.close().catch(() => {});
          throw error;
        }
      }
      const { BrowserBackend } = upstream().tools;
      const isCurrent = () => this.current === promise;
      let governor: TabGovernor | undefined;
      const gone = () => {
        governor?.dispose();
        if (isCurrent()) {
          this.current = undefined;
          this.live = undefined;
          this.launched = undefined;
        }
      };
      const backend = new BrowserBackend(config, launched.context, stock, {
        ...(launched.idleTimer ? { idleTimer: launched.idleTimer } : {}),
        dispose: async () => {
          gone();
          await launched.close();
        },
      });
      try {
        await backend.initialize(clientInfo);
      } catch (error) {
        await launched.close();
        throw error;
      }
      governor = new TabGovernor(launched.context, tuning.tabs, {
        current: () => backendContext(backend)?.currentTab()?.page,
        tabs: () => backendContext(backend)?.tabs().map((t) => t.page) ?? [],
      });
      governor.start();
      backend.on("dynamictoolschange", () => this.emit("dynamictoolschange"));
      backend.once("disconnected", () => {
        gone();
        void backend.dispose().catch(() => {});
      });
      if (isCurrent()) {
        this.live = backend;
        this.launched = launched;
      }
      return { backend, launched, governor, tuning };
    })();
    promise.catch(() => {
      if (this.current === promise) this.current = undefined;
    });
    this.current = promise;
    return promise;
  }

  /**
   * `session` is the client session mcpd put in the call's `_meta` (ADR 0047). Only turno tools
   * see it; stock tools run exactly as before. Upstream's HTTP server (`--port`) never passes it.
   */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, session?: string): Promise<ToolResult> {
    const tool = this.host.turno.get(name);
    if (!tool) return await this.callStock(name, args, signal);
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    const parsed = parseArguments(tool, args);
    if ("error" in parsed) return errorResult(parsed.error, json);
    const clientInfo = this.info();
    let browserContext: LaunchedBrowser["context"] | undefined;
    if (tool.browser !== false) {
      const { launched } = await this.browser();
      launched.idleTimer?.poke();
      browserContext = launched.context;
    }
    try {
      const context = { config: this.host.config, clientInfo, ...(browserContext ? { browserContext } : {}), ...(signal ? { signal } : {}), ...(session ? { session } : {}) };
      return await tool.handle(context, parsed.params);
    } catch (error) {
      return errorResult(String(error), json);
    }
  }

  /**
   * A stock tool through upstream's `BrowserBackend`, wrapped by the tab governor: a parked tab
   * the call is about to use loads again first, and with `backgroundThrottling` the current tab
   * comes to the front (a tab in the background would not render, and an action on it would
   * wait for its timeout).
   */
  private async callStock(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const { backend, governor, tuning } = await this.browser();
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    governor.beginCall();
    let result: ToolResult;
    try {
      await governor.prepare(name, args);
      if (tuning.backgroundThrottling && name !== "browser_tabs") await backendContext(backend)?.currentTab()?.page.bringToFront().catch(() => {});
      result = await backend.callTool(name, args, signal);
      await governor.settled();
    } finally {
      governor.endCall();
    }
    return withGovernor(result, governor, json);
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

/** After NEEDS_AUTH, fail at once for a short while instead of opening Chrome on every call. */
function refuseWhileNeedsAuth(identity: IdentityRef): void {
  const health = readIdentitySettings(identity.id, identity.env)?.health;
  const last = readHealth(identity.id, identity.env);
  if (health && last?.status === "needs_auth" && last.url === health.url && Date.now() - Date.parse(last.checkedAt) < NEEDS_AUTH_HOLD_MS) {
    throw new Error(needsAuthMessage(identity.id, last));
  }
}

/**
 * Once an identity's Chrome runs (ADR 0044): watch its pages for challenges (the reputation
 * log) and, when identity.json has a health check that is due, run it; a page without the
 * proof of a signed-in session throws NEEDS_AUTH, and the call fails with that message.
 */
async function afterIdentityLaunch(identity: IdentityRef, launched: LaunchedBrowser): Promise<void> {
  const { id, env } = identity;
  watchChallenges(launched.context, (event) => {
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
  const turnoTools = options.turnoTools ?? TURNO_TOOLS;
  checkTurnoTools(turnoTools, tools.browserTools);
  const turno = new Map(turnoTools.map((t) => [t.schema.name, t]));
  const engine = options.engine ?? selectEngine(config, createUpstreamEngine());
  const schemas = [...stock.map((t) => t.schema), ...turnoTools.map((t) => t.schema)];
  const sessionsByName = new Map<string, number>();
  const title = (clientInfo: ClientInfo) => {
    const count = (sessionsByName.get(clientInfo.clientName) ?? 0) + 1;
    sessionsByName.set(clientInfo.clientName, count);
    return count > 1 ? `${clientInfo.clientName} (${count})` : clientInfo.clientName;
  };
  const shared = { config, cliOptions, stock, turno, engine, tuning: options.tuning ?? {}, ...(options.identity ? { identity: options.identity } : {}) };
  return {
    config,
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
  const server = new Server(SERVER_INFO, { capabilities: { tools: { listChanged: true } } });
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
      return { content: [{ type: "text", text: `### Error\n${String(error)}` }], isError: true };
    }
  });
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
export async function runHost(args: string[], options: { identity?: IdentityRef; tuning?: TuningFlags } = {}): Promise<void> {
  const { utils, core, version } = upstream();
  const { identity, tuning } = options;
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
    await serve(createHost({ config, cliOptions: options, ...(identity ? { identity } : {}), ...(tuning ? { tuning } : {}) }));
  });
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    console.error((error as Error).message);
    core.utils.gracefullyProcessExitDoNotHang(1);
  }
}
