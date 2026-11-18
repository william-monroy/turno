/**
 * `turno mcp call <server> [tool]`: call one tool through mcpd from the terminal, the way an
 * agent session of a profile would (its token, this folder), to debug a server without opening
 * an agent. Loaded only when the subcommand runs: it brings in the MCP SDK client.
 */
import { gatewayUrl } from "../../agents/adapter.js";
import { loadConfig } from "../../core/config.js";
import { loadManifest, servesProfile } from "../../core/manifest.js";
import { resolveProfile } from "../../core/resolve.js";
import { packageInfo } from "../../core/version.js";
import { type FlagSpec, JSON_FLAG, bool, parseFlags, str } from "../args.js";
import { Exit } from "../exit.js";
import { CliError, type Io, UsageError, fail } from "../io.js";
import { emit, jsonOutput } from "../output.js";
import { duration, style } from "../style.js";

export const CALL_FLAGS: FlagSpec = {
  args: { type: "string" },
  arg: { type: "string", multiple: true },
  profile: { type: "string" },
  ...JSON_FLAG,
};

/**
 * `turno mcp call --json` (ADR 0045). A call fills `tool`, `isError`, `content` and
 * `structuredContent`; without a tool, `tools` lists the server's tools and the rest is null.
 */
export const CALL_JSON = jsonOutput(["server", "profile", "tool", "isError", "content", "structuredContent", "tools", "ms"]);

/**
 * The tool arguments: `--args` (a JSON object), then each `--arg key=value` (a string) or
 * `--arg key:=json` (any JSON value) on top of it, as httpie writes them.
 */
export function callArguments(json: string | undefined, pairs: readonly string[]): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  if (json !== undefined) {
    let v: unknown;
    try {
      v = JSON.parse(json);
    } catch (err) {
      throw new UsageError(`--args is not JSON: ${(err as Error).message}`);
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new UsageError("--args must be a JSON object, like '{\"query\": \"x\"}'");
    out = { ...(v as Record<string, unknown>) };
  }
  for (const pair of pairs) {
    const m = /^([^=:]+)(:?=)([\s\S]*)$/.exec(pair);
    if (!m) throw new UsageError(`--arg ${pair}: use key=value (a string) or key:=json (a number, true, a list...)`);
    const [, key, op, raw] = m as unknown as [string, string, string, string];
    if (op === "=") {
      out[key] = raw;
      continue;
    }
    try {
      out[key] = JSON.parse(raw);
    } catch (err) {
      throw new UsageError(`--arg ${key}:= needs JSON: ${(err as Error).message}`);
    }
  }
  return out;
}

/** The profile a session in `cwd` would use: --profile, else the folder's Claude Code profile, else the hub's. */
function callerProfile(given: string | undefined, env: NodeJS.ProcessEnv, cwd: string): string {
  if (given) return given;
  const config = loadConfig(env);
  return resolveProfile(cwd, config, env).chosen || config.system || "default";
}

/** One line from an SDK transport error: the gateway's `{ "error": ... }` text when it sent one. */
function gatewayMessage(err: unknown): { status?: number; message: string } {
  const e = err as { code?: unknown; message?: string };
  const message = e?.message ?? String(err);
  const status = typeof e?.code === "number" && e.code >= 400 && e.code < 600 ? e.code : undefined;
  const body = /Error POSTing to endpoint: (.*)$/s.exec(message)?.[1];
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") return { ...(status ? { status } : {}), message: parsed.error };
      if (parsed.error && typeof (parsed.error as { message?: unknown }).message === "string") {
        return { ...(status ? { status } : {}), message: (parsed.error as { message: string }).message };
      }
    } catch {
      /* not JSON */
    }
    return { ...(status ? { status } : {}), message: body.trim().split("\n")[0]! };
  }
  return { ...(status ? { status } : {}), message: message.split("\n")[0]! };
}

interface ContentItem {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

/** A content item as terminal text: text as it is, anything else as one bracketed line. */
export function contentText(c: ContentItem): string {
  switch (c.type) {
    case "text":
      return c.text ?? "";
    case "image":
    case "audio":
      return `[${c.type} ${c.mimeType ?? "?"}, ${Math.floor(((c.data ?? "").length * 3) / 4)} bytes]`;
    case "resource":
      return c.resource?.text !== undefined ? c.resource.text : `[resource ${c.resource?.uri ?? "?"}${c.resource?.mimeType ? `, ${c.resource.mimeType}` : ""}]`;
    case "resource_link":
      return `[link ${c.uri ?? "?"}${c.name ? ` (${c.name})` : ""}]`;
    default:
      return `[${c.type}]`;
  }
}

export async function call(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, CALL_FLAGS, 2);
  const [server, tool] = p.positionals;
  if (!server) return fail("usage: turno mcp call <server> [tool] [--args JSON] [--arg key=value ...] [--profile p] [--json]");
  const pairs = (p.values.arg as string[] | undefined) ?? [];
  const toolArgs = callArguments(str(p, "args"), pairs);
  if (!tool && (str(p, "args") !== undefined || pairs.length)) fail("--args and --arg go with a tool: turno mcp call <server> <tool> ...");
  const json = bool(p, "json");

  const manifest = loadManifest(io.env);
  const def = manifest.servers[server];
  if (!def) return fail(`unknown server '${server}' (turno mcp list shows them)`);
  if (def.kind === "remote" && !def.proxy) {
    throw new CliError(`${server} is a remote server that agents reach directly (no keychain: or env: header and no auth = "oauth"), so mcpd does not relay it; call it from the agent`);
  }
  const cwd = process.cwd();
  const profile = callerProfile(str(p, "profile"), io.env, cwd);
  if (!servesProfile(def, profile)) {
    throw new CliError(`${server} is not served to profile ${profile} (profiles = ${JSON.stringify(def.profiles)} in mcp.toml); pick another with --profile`);
  }

  const { mcpdPort, readToken } = await import("../../mcpd/state.js");
  const { profileToken } = await import("../../mcpd/tokens.js");
  const master = readToken(io.env);
  const down = () => new CliError("mcpd is not running (turno mcp daemon start)", Exit.gatewayDown);
  if (!master) throw down();
  const port = mcpdPort(io.env);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl(server, port)), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${profileToken(master, profile)}`,
        "X-Turno-Profile": profile,
        "X-Turno-Pid": String(process.pid),
        // This folder, so its [[projects]] rules apply as they would to an agent here.
        "X-Turno-Cwd-B64": Buffer.from(cwd, "utf8").toString("base64url"),
      },
    },
  });
  const client = new Client({ name: "turno-mcp-call", version: packageInfo().version }, { capabilities: {} });
  const started = Date.now();
  try {
    try {
      await client.connect(transport);
    } catch (err) {
      const g = gatewayMessage(err);
      if (g.status === undefined && /ECONNREFUSED|fetch failed|connect/i.test(g.message)) throw down();
      throw new CliError(`mcpd refused the session for ${server} as profile ${profile}: ${g.message}`);
    }
    // A server the folder's set leaves out answers with no capabilities and says why (ADR 0031).
    if (client.getServerVersion()?.version === "hidden") throw new CliError(client.getInstructions() ?? `${server} is hidden in this folder`);
    if (!tool) {
      const { tools } = await client.listTools();
      const ms = Date.now() - started;
      if (json) {
        emit(io, p, CALL_JSON, { server, profile, tool: null, isError: null, content: null, structuredContent: null, tools: tools.map((t) => ({ name: t.name, description: t.description ?? null })), ms });
        return 0;
      }
      const st = style(io);
      if (!tools.length) io.out(st.muted(`${server} has no tools for profile ${profile}`));
      for (const t of tools) io.out(st.wrap(`${st.bold(t.name)}  `, st.muted((t.description ?? "").split("\n")[0] ?? "")));
      if (io.isTty) io.err(st.muted(`${tools.length} tools of ${server} as profile ${profile} in ${duration(ms)}; call one with: turno mcp call ${server} <tool> --arg key=value`));
      return 0;
    }
    let result: Awaited<ReturnType<typeof client.callTool>>;
    try {
      result = await client.callTool({ name: tool, arguments: toolArgs });
    } catch (err) {
      throw new CliError(`${server}/${tool}: ${gatewayMessage(err).message}`);
    }
    const ms = Date.now() - started;
    const content = (Array.isArray(result.content) ? result.content : []) as ContentItem[];
    const isError = result.isError === true;
    if (json) {
      emit(io, p, CALL_JSON, { server, profile, tool, isError, content, structuredContent: result.structuredContent ?? null, tools: null, ms });
      return isError ? 1 : 0;
    }
    for (const c of content) io.out(contentText(c));
    if (!content.length && result.structuredContent !== undefined) io.out(JSON.stringify(result.structuredContent, null, 2));
    const st = style(io);
    if (isError) io.err(`turno: ${server}/${tool} returned an error (isError)`);
    else if (io.isTty) io.err(st.muted(`${server}/${tool} as profile ${profile} in ${duration(ms)}`));
    return isError ? 1 : 0;
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}
