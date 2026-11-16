import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIdentityId, identityDir } from "./identities.js";

/**
 * Turns `turno-browser-mcp [--identity <id>] [playwright-mcp flags]` into the argv for the
 * Patchright MCP program, adding the defaults of ADR 0005 that the user did not set:
 *
 * - `--browser chrome`: the installed Google Chrome, not a bundled Chromium.
 * - `--user-data-dir <dir>`: the identity's persistent profile, or a fresh temporary one.
 *   Patchright recommends persistent contexts, and the upstream default (a profile shared by
 *   every server started in the same folder) is neither isolated nor per identity.
 *
 * Headed mode and `viewport: null` are already the program's defaults for headed runs, so
 * nothing is added for them; no init scripts are ever added.
 *
 * An identity holds saved logins, so serving it over HTTP (`--port`, `--host`) lets any local
 * process drive a signed-in browser without the stdio pipe or mcpd's token. That needs
 * `--allow-http-identity`, and even then the server binds to 127.0.0.1 and keeps the Host check
 * (ADR 0019).
 */

export interface BuiltArgv {
  /** Arguments for the MCP program (without node and script path). */
  args: string[];
  identity?: string;
  /** Profile dir passed to the program, when we chose it. */
  userDataDir?: string;
  /** Temporary dir to delete on exit (only for runs without an identity). */
  tempDir?: string;
}

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  /** Creates the temporary profile root. Injected by tests. */
  makeTempDir?: () => string;
}

/** Flags that point the program at a browser it does not launch itself. */
const EXTERNAL_BROWSER = ["--cdp-endpoint", "--endpoint", "--extension"];

/** Opt-in to serve an identity over HTTP; consumed here, never passed on. */
export const ALLOW_HTTP_IDENTITY = "--allow-http-identity";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Value of `--flag v` or `--flag=v` (the last one wins, as in commander). */
function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag && args[i + 1] !== undefined) out.push(args[++i]!);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  }
  return out;
}

function guardHttp(args: string[], identity: string | undefined, allowed: boolean): void {
  const http = hasFlag(args, "--port") || hasFlag(args, "--host");
  if (allowed && identity === undefined) throw new Error(`${ALLOW_HTTP_IDENTITY} applies only with --identity`);
  if (identity === undefined || !http) return;
  if (!allowed) {
    throw new Error(
      `--identity with --port or --host would serve a signed-in browser over HTTP to any local process; ` +
        `use stdio through mcpd, or pass ${ALLOW_HTTP_IDENTITY} to accept that (it binds to 127.0.0.1 only)`,
    );
  }
  const hosts = flagValues(args, "--host");
  const host = hosts[hosts.length - 1];
  if (host !== undefined && !LOOPBACK.has(host.toLowerCase())) {
    throw new Error(`an identity is only served on a loopback address (127.0.0.1, localhost, ::1), not ${host}`);
  }
  if (flagValues(args, "--allowed-hosts").some((v) => v.split(",").some((h) => h.trim() === "*"))) {
    throw new Error("an identity is never served with --allowed-hosts '*' (the Host check stops DNS rebinding)");
  }
  if (host === undefined) {
    const at = args.findIndex((a) => a === "--port" || a.startsWith("--port="));
    args.splice(at + (args[at] === "--port" ? 2 : 1), 0, "--host", "127.0.0.1");
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

function hasAny(args: string[], flags: string[]): boolean {
  return flags.some((f) => hasFlag(args, f));
}

/** Removes `--identity <id>` / `--identity=<id>` from args and returns the id. */
export function extractIdentity(args: string[]): { identity?: string; rest: string[] } {
  const rest: string[] = [];
  let identity: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--identity") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error("--identity needs a value");
      identity = v;
      i++;
    } else if (a.startsWith("--identity=")) {
      identity = a.slice("--identity=".length);
    } else {
      rest.push(a);
    }
  }
  if (identity !== undefined) assertIdentityId(identity);
  return identity === undefined ? { rest } : { identity, rest };
}

export function defaultTempDir(): string {
  return mkdtempSync(join(tmpdir(), "turno-browser-"));
}

export function buildArgv(rawArgs: string[], options: BuildOptions = {}): BuiltArgv {
  const env = options.env ?? process.env;
  const { identity, rest } = extractIdentity(rawArgs);
  const allowHttp = rest.includes(ALLOW_HTTP_IDENTITY);
  const args = rest.filter((a) => a !== ALLOW_HTTP_IDENTITY);
  guardHttp(args, identity, allowHttp);
  const external = hasAny(args, EXTERNAL_BROWSER);
  const out: BuiltArgv = { args };
  if (identity !== undefined) {
    const clash = ["--user-data-dir", "--isolated", ...EXTERNAL_BROWSER].find((f) => hasFlag(args, f));
    if (clash) throw new Error(`--identity cannot be combined with ${clash}`);
    out.identity = identity;
  }

  if (!external && !hasFlag(args, "--browser")) args.push("--browser", "chrome");

  if (!external && !hasFlag(args, "--user-data-dir") && !hasFlag(args, "--isolated")) {
    if (identity !== undefined) {
      out.userDataDir = identityDir(identity, env);
    } else {
      out.tempDir = (options.makeTempDir ?? defaultTempDir)();
      out.userDataDir = join(out.tempDir, "profile");
    }
    args.push("--user-data-dir", out.userDataDir);
  }
  return out;
}
