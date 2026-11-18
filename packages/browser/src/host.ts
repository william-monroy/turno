import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Engine, type LaunchedBrowser, createUpstreamEngine, selectEngine } from "./engine.js";
import { TURNO_TOOLS, type TurnoTool, checkTurnoTools, parseArguments } from "./tools.js";
import {
  type BrowserBackendInstance,
  type ClientInfo,
  type McpConfig,
  type ServerBackend,
  type ServerBackendFactory,
  type ToolResult,
  type ToolSchemaJson,
  type UpstreamTool,
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
 *   next call, with the same profile.
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
class SessionBackend extends EventEmitter implements ServerBackend {
  private clientInfo: ClientInfo | undefined;
  private current: Promise<{ backend: BrowserBackendInstance; launched: LaunchedBrowser }> | undefined;
  /** The backend of the running browser, for the WebMCP tools a page registers. */
  private live: BrowserBackendInstance | undefined;
  private launched: LaunchedBrowser | undefined;
  private disposed = false;

  constructor(
    private readonly host: { config: McpConfig; cliOptions: Record<string, unknown>; stock: UpstreamTool[]; turno: Map<string, TurnoTool>; engine: Engine },
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
  private browser(): Promise<{ backend: BrowserBackendInstance; launched: LaunchedBrowser }> {
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
    const { config, cliOptions, stock, engine } = this.host;
    const promise = (async () => {
      const launched = await engine.launch({ config, clientInfo, cliOptions, title: this.title(clientInfo) });
      const { BrowserBackend } = upstream().tools;
      const isCurrent = () => this.current === promise;
      const gone = () => {
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
      backend.on("dynamictoolschange", () => this.emit("dynamictoolschange"));
      backend.once("disconnected", () => {
        gone();
        void backend.dispose().catch(() => {});
      });
      if (isCurrent()) {
        this.live = backend;
        this.launched = launched;
      }
      return { backend, launched };
    })();
    promise.catch(() => {
      if (this.current === promise) this.current = undefined;
    });
    this.current = promise;
    return promise;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const tool = this.host.turno.get(name);
    if (!tool) {
      const { backend } = await this.browser();
      return await backend.callTool(name, args, signal);
    }
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
      return await tool.handle({ config: this.host.config, clientInfo, ...(browserContext ? { browserContext } : {}), ...(signal ? { signal } : {}) }, parsed.params);
    } catch (error) {
      return errorResult(String(error), json);
    }
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
  const shared = { config, cliOptions, stock, turno, engine };
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
      const result = await b.callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, extra.signal);
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
export async function runHost(args: string[]): Promise<void> {
  const { utils, core, version } = upstream();
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
    await serve(createHost({ config, cliOptions: options }));
  });
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    console.error((error as Error).message);
    core.utils.gracefullyProcessExitDoNotHang(1);
  }
}
