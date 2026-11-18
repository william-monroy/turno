import type { BrowserContext, Page } from "patchright-core";
import { batchTool } from "./batch.js";
import { type VaultAccess, loginTool } from "./login-tool.js";
import { type ClientInfo, type McpConfig, type ToolResult, type ToolSchema, type UpstreamTool, type Zod, type ZodObject, upstream } from "./upstream.js";

/**
 * The turno tool registry (ADR 0043). A turno tool is listed after the stock Playwright MCP
 * tools and called by the host itself; stock tools keep going to upstream's `BrowserBackend`.
 *
 * Rules, checked when the host starts and by the contract test:
 *
 * - A turno tool never takes the name of an upstream tool, whatever its capability, so a stock
 *   tool name always means the stock tool (ADR 0003). An upgrade of patchright-core that adds a
 *   tool with the same name fails the contract test, not a user's session.
 * - Names are unique and match `^[a-z][a-z0-9_]*$`.
 * - The input schema is a zod object of the bundled zod (`turnoZod()`), so `tools/list` renders
 *   it exactly like a stock tool's and arguments are validated the same way.
 */

/** The session's stock tools, for a turno tool that runs them (`browser_batch`). */
export interface StockAccess {
  /** Input schema of each stock tool this session lists. */
  schemas: ReadonlyMap<string, ZodObject>;
  /** A zod error as upstream words it. */
  formatError(error: unknown): string;
  /**
   * Runs a stock tool the way a call of its own runs (tab governor, click diagnosis); with
   * `snapshot: false` the result leaves out the page snapshot an action would add.
   */
  call(name: string, args: Record<string, unknown>, options: { snapshot: boolean }): Promise<ToolResult>;
  /** URL and title of the current tab, when there is one. */
  page(): Promise<{ url: string; title: string } | undefined>;
  /** The current tab itself (`browser_login` fills it). */
  currentPage(): Page | undefined;
}

interface TurnoToolContext {
  config: McpConfig;
  clientInfo: ClientInfo;
  /** The session's browser context; launched on demand for a tool with `browser: true`. */
  browserContext?: BrowserContext;
  signal?: AbortSignal;
  /**
   * The client session mcpd relays this call for (`_meta["io.turno/session"]`, ADR 0047): an
   * opaque id, the same for every call of one agent session and different for every other.
   * Undefined when the call did not come through mcpd.
   */
  session?: string;
  /** The session's stock tools; set by the host for a tool with `browser: true`. */
  stock?: StockAccess;
  /** The identity's vault, its redactor and guard; set by the host when it serves an identity (ADR 0054). */
  vault?: VaultAccess;
}

export interface TurnoTool {
  schema: ToolSchema;
  /** True (the default) when the tool needs the browser: the host launches it first. */
  browser?: boolean;
  handle(context: TurnoToolContext, params: Record<string, unknown>): Promise<ToolResult>;
}

/** The tools turno adds to every session (ADRs 0051 and 0054). */
export const TURNO_TOOLS: readonly TurnoTool[] = [batchTool(), loginTool()];

/** The zod of the bundle, to build a turno tool's `inputSchema` with. */
export function turnoZod(): Zod {
  return upstream().utils.z;
}

const NAME = /^[a-z][a-z0-9_]*$/;

/** Throws when a turno tool would shadow an upstream tool or another turno tool. */
export function checkTurnoTools(turno: readonly TurnoTool[], upstreamTools: readonly UpstreamTool[]): void {
  const stock = new Set(upstreamTools.map((t) => t.schema.name));
  const seen = new Set<string>();
  for (const tool of turno) {
    const name = tool.schema.name;
    if (!NAME.test(name)) throw new Error(`turno tool name "${name}" must match ${NAME}`);
    if (stock.has(name)) throw new Error(`turno tool "${name}" has the name of a Playwright MCP tool`);
    if (seen.has(name)) throw new Error(`turno tool "${name}" is registered twice`);
    seen.add(name);
  }
}

/** Upstream's argument error, word for word, for a turno tool. */
export function parseArguments(tool: TurnoTool, args: Record<string, unknown>): { params: Record<string, unknown> } | { error: string } {
  const { z } = upstream().utils;
  const schema: ZodObject = tool.schema.inputSchema;
  const { _meta: _ignored, ...rest } = args;
  try {
    return { params: schema.parse(rest) };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: `Invalid arguments for tool "${tool.schema.name}":\n${z.prettifyError(error)}` };
    throw error;
  }
}
