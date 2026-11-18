import type { BrowserContext } from "patchright-core";
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

interface TurnoToolContext {
  config: McpConfig;
  clientInfo: ClientInfo;
  /** The session's browser context; launched on demand for a tool with `browser: true`. */
  browserContext?: BrowserContext;
  signal?: AbortSignal;
}

export interface TurnoTool {
  schema: ToolSchema;
  /** True (the default) when the tool needs the browser: the host launches it first. */
  browser?: boolean;
  handle(context: TurnoToolContext, params: Record<string, unknown>): Promise<ToolResult>;
}

/** The tools turno adds to every session. None yet: the registry is the extension point. */
export const TURNO_TOOLS: readonly TurnoTool[] = [];

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
