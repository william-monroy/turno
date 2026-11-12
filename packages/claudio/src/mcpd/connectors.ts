import { createWriteStream, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerDef } from "../core/manifest.js";
import { effectiveLaunch } from "../core/manifest.js";
import { type SecretResolver, resolveRecord } from "../core/secrets.js";
import type { ClientContext, Connector } from "./instances.js";
import { resolveCommand } from "./instances.js";

/** A builtin server runs inside mcpd; one is created per client session with its context. */
export type BuiltinFactory = (ctx: ClientContext) => Server | Promise<Server>;

export interface ConnectorOptions {
  resolve: SecretResolver;
  serversDir: string;
  logsDir: string;
  builtins?: Record<string, BuiltinFactory>;
  /** Base environment for stdio servers (PATH and friends). */
  baseEnv?: Record<string, string>;
}

const MAX_LOG = 5 * 1024 * 1024;

function openLog(logsDir: string, name: string): NodeJS.WritableStream {
  mkdirSync(logsDir, { recursive: true });
  const file = join(logsDir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`);
  try {
    if (statSync(file).size > MAX_LOG) renameSync(file, `${file}.1`);
  } catch {
    /* new file */
  }
  return createWriteStream(file, { flags: "a" });
}

export class DefaultConnector implements Connector {
  constructor(private readonly opts: ConnectorOptions) {}

  async connect(server: ServerDef, variant: string, ctx: ClientContext, workdir: string) {
    if (server.kind === "remote") {
      const headers = await resolveRecord(server.headers, this.opts.resolve);
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
      return { transport };
    }
    if (server.builtin) {
      const factory = this.opts.builtins?.[server.builtin];
      if (!factory) throw new Error(`unknown builtin server "${server.builtin}"`);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const srv = await factory(ctx);
      await srv.connect(serverSide);
      return { transport: clientSide };
    }
    const launch = effectiveLaunch(server, variant);
    const env = { ...(this.opts.baseEnv ?? {}), ...(await resolveRecord(launch.env, this.opts.resolve)) };
    const transport = new StdioClientTransport({
      command: resolveCommand(server, launch.command, this.opts.serversDir),
      args: launch.args,
      env,
      cwd: launch.cwd ?? workdir,
      stderr: "pipe",
    });
    const log = openLog(this.opts.logsDir, `${server.name}${variant === "default" ? "" : `@${variant}`}`);
    const origStart = transport.start.bind(transport);
    transport.start = async () => {
      await origStart();
      const err = transport.stderr;
      if (err) (err as NodeJS.ReadableStream).pipe(log);
    };
    return { transport, pid: () => transport.pid };
  }
}
