import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Install dir of patchright-core, resolved from this package. */
export function patchrightDir(): string {
  return dirname(require.resolve("patchright-core/package.json"));
}

/**
 * The Playwright MCP program shipped inside patchright-core (ADR 0003). The subpath is not in
 * the package `exports`, so it is resolved from the install dir.
 */
export function mcpEntryPath(): string {
  return join(patchrightDir(), "lib", "entry", "mcp.js");
}

/** True when a package can be resolved from this package or the current folder. */
export function isResolvable(name: string): boolean {
  return resolveFrom(name) !== undefined;
}

export function resolveFrom(name: string): string | undefined {
  for (const base of [import.meta.url, join(process.cwd(), "noop.js")]) {
    try {
      return createRequire(base).resolve(name);
    } catch {
      // try the next base
    }
  }
  return undefined;
}
