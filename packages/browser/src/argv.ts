import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIdentityId, identityDir } from "./identities.js";

/**
 * Turns `claudio-browser-mcp [--identity <id>] [playwright-mcp flags]` into the argv for the
 * Patchright MCP program, adding stealth defaults the user did not set (see ADR 0005):
 *
 * - `--browser chrome`: the installed Google Chrome, not a bundled Chromium.
 * - `--user-data-dir <dir>`: the identity's persistent profile, or a fresh temporary one.
 *   Patchright recommends persistent contexts, and the upstream default (a profile shared by
 *   every server started in the same folder) is neither isolated nor per identity.
 *
 * Headed mode and `viewport: null` are already the program's defaults for headed runs, so
 * nothing is added for them; no init scripts are ever added.
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
  return mkdtempSync(join(tmpdir(), "claudio-browser-"));
}

export function buildArgv(rawArgs: string[], options: BuildOptions = {}): BuiltArgv {
  const env = options.env ?? process.env;
  const { identity, rest } = extractIdentity(rawArgs);
  const args = [...rest];
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
