import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerDef } from "../core/manifest.js";
import { effectiveLaunch } from "../core/manifest.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../core/paths.js";
import { type SecretResolver, expandVars, resolveRecord, secretStore } from "../core/secrets.js";
import type { ClientContext, Connector } from "./instances.js";
import { isDirectory, resolveCommand } from "./instances.js";
import { OAuthSessions, oauthFetch } from "./oauth.js";

/** A builtin server runs inside mcpd; one is created per client session with its context. */
export type BuiltinFactory = (ctx: ClientContext) => Server | Promise<Server>;

export interface ConnectorOptions {
  resolve: SecretResolver;
  serversDir: string;
  logsDir: string;
  builtins?: Record<string, BuiltinFactory>;
  /** Base environment for stdio servers (PATH and friends). */
  baseEnv?: Record<string, string>;
  /**
   * Environment that `${VAR}` in a stdio server's args expands from (mcpd's own). Without it,
   * args are passed as written.
   */
  vars?: NodeJS.ProcessEnv;
  /** Bytes a server log may reach before it is rotated to `<name>.log.1`. */
  maxLogBytes?: number;
  /**
   * Logins of `auth = "oauth"` servers (ADR 0029). Defaults to sessions on the secret store
   * found on the PATH of `vars`, logging to each server's log file.
   */
  oauth?: OAuthSessions;
}

const MAX_LOG = 5 * 1024 * 1024;

function logFileOf(logsDir: string, label: string): string {
  return join(logsDir, `${label.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`);
}

/**
 * Append-only log that rotates by size while it is written, not only when a server starts:
 * a long-lived, chatty server would otherwise fill the disk.
 */
export class RotatingLog {
  private fd?: number;
  private size = 0;

  constructor(
    readonly file: string,
    private readonly maxBytes = MAX_LOG,
  ) {
    mkdirSync(join(file, ".."), { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
      this.size = statSync(file).size;
    } catch {
      this.size = 0;
    }
    if (this.size > this.maxBytes) this.rotate();
  }

  /** Synchronous, like mcpd.log: chunks are small and the order must survive a rotation. */
  write(chunk: string | Buffer): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    try {
      if (this.size > 0 && this.size + buf.length > this.maxBytes) this.rotate();
      if (this.fd === undefined) {
        // Server logs can quote tokens and file contents: 0600 like every file turno keeps.
        this.fd = openSync(this.file, "a", PRIVATE_FILE_MODE);
        if (fstatSync(this.fd).mode & 0o077) fchmodSync(this.fd, PRIVATE_FILE_MODE);
      }
      writeSync(this.fd, buf);
      this.size += buf.length;
    } catch {
      /* a full or read-only disk must not take mcpd down */
    }
  }

  end(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      /* already closed */
    }
    delete this.fd;
  }

  private rotate(): void {
    this.end();
    try {
      renameSync(this.file, `${this.file}.1`);
    } catch {
      /* nothing to rotate */
    }
    this.size = 0;
  }
}

/** The last lines of a file (at most 16 KiB are read). */
function tailFile(file: string, lines = 10): string | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 16 * 1024);
    const buf = Buffer.alloc(len);
    fd = openSync(file, "r");
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8").trimEnd();
    return text ? text.split("\n").slice(-lines).join("\n") : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class DefaultConnector implements Connector {
  private oauthSessions?: OAuthSessions;
  private oauthLogs = new Map<string, RotatingLog>();

  constructor(private readonly opts: ConnectorOptions) {}

  private sessions(): OAuthSessions {
    this.oauthSessions ??=
      this.opts.oauth ??
      new OAuthSessions((name, variant) => ({
        store: () => secretStore(this.opts.vars ?? process.env),
        resolve: this.opts.resolve,
        log: (line) => this.oauthLog(name, variant).write(`turno: ${line}\n`),
      }));
    return this.oauthSessions;
  }

  private oauthLog(name: string, variant: string): RotatingLog {
    const label = `${name}${variant === "default" ? "" : `@${variant}`}`;
    let log = this.oauthLogs.get(label);
    if (!log) {
      log = new RotatingLog(logFileOf(this.opts.logsDir, label), this.opts.maxLogBytes ?? MAX_LOG);
      this.oauthLogs.set(label, log);
    }
    return log;
  }

  forgetLogin(server: string, variants?: string[]): void {
    this.oauthSessions?.forget(server, variants);
  }

  async flushLogins(): Promise<string[]> {
    return this.oauthSessions ? this.oauthSessions.flush() : [];
  }

  logTail(server: ServerDef, variant: string, lines = 10): string | undefined {
    return tailFile(logFileOf(this.opts.logsDir, `${server.name}${variant === "default" ? "" : `@${variant}`}`), lines);
  }

  async connect(server: ServerDef, variant: string, ctx: ClientContext, workdir: string) {
    if (server.kind === "remote") {
      const headers = await resolveRecord(server.headers, this.opts.resolve);
      let fetchOpt: { fetch?: ReturnType<typeof oauthFetch> } = {};
      if (server.oauth) {
        // mcpd is the OAuth client (ADR 0029). Asking for a token now fails fast with the login
        // hint instead of a failed initialize; every request then gets a current token.
        const session = this.sessions().get(server.name, variant);
        await session.accessToken(server);
        fetchOpt = { fetch: oauthFetch(session, () => server) };
      }
      // `type = "sse"` is the legacy HTTP+SSE transport; everything else is Streamable HTTP.
      const transport =
        server.entry.type === "sse"
          ? new SSEClientTransport(new URL(server.url), { requestInit: { headers }, ...fetchOpt })
          : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers }, ...fetchOpt });
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
    const cwd = launch.cwd ?? workdir;
    if (!isDirectory(cwd)) {
      throw new Error(
        launch.cwd
          ? `the folder ${cwd} (cwd in mcp.toml) does not exist`
          : `the session folder ${cwd} does not exist or is not readable by mcpd`,
      );
    }
    const env = { ...(this.opts.baseEnv ?? {}), ...(await resolveRecord(launch.env, this.opts.resolve)) };
    const vars = this.opts.vars;
    const args = vars ? launch.args.map((a) => expandVars(a, vars)) : launch.args;
    const resolved = resolveCommand(server, launch.command, args, this.opts.serversDir);
    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env,
      cwd,
      stderr: "pipe",
    });
    const log = new RotatingLog(
      logFileOf(this.opts.logsDir, `${server.name}${variant === "default" ? "" : `@${variant}`}`),
      this.opts.maxLogBytes ?? MAX_LOG,
    );
    const warnings = resolved.warning ? [resolved.warning] : [];
    for (const w of warnings) log.write(`turno: ${w}\n`);
    const origStart = transport.start.bind(transport);
    transport.start = async () => {
      await origStart();
      const err = transport.stderr as NodeJS.ReadableStream | null;
      if (err) {
        err.on("data", (chunk: Buffer) => log.write(chunk));
        err.on("end", () => log.end());
      }
    };
    return { transport, pid: () => transport.pid, warnings };
  }
}
