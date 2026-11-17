import module from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Node keeps turno's compiled code between runs: the user cache dir
 * ($XDG_CACHE_HOME/turno, else ~/.cache/turno), never the shared temp dir Node uses by default.
 */
export function compileCacheDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "turno", "node-compile-cache");
}

/**
 * Turn on Node's on-disk compile cache (module.enableCompileCache, Node 22.1+), so later runs
 * skip compiling the modules they import. Only the CLI entry calls it, before it imports any
 * command. NODE_COMPILE_CACHE picks another folder and NODE_DISABLE_COMPILE_CACHE turns it off,
 * as for any Node program. A Node without the API, or a cache that cannot be written, only
 * makes turno a little slower. `turno demo` promises to leave HOME as it found it, so it runs
 * without the cache (the turno commands inside the demo cache in the demo's own HOME).
 */
export function enableCompileCache(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (argv[0] === "demo") return;
  const enable = (module as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache;
  if (typeof enable !== "function") return;
  try {
    enable(env.NODE_COMPILE_CACHE ? undefined : compileCacheDir(env));
  } catch {
    /* never fail a command over the cache */
  }
}
