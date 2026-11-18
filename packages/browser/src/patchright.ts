import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Install dir of patchright-core, resolved from this package. */
function patchrightDir(): string {
  return dirname(require.resolve("patchright-core/package.json"));
}

/**
 * The Playwright MCP program shipped inside patchright-core (ADR 0003). The subpath is not in
 * the package `exports`, so it is resolved from the install dir. `turno-browser-mcp` no longer
 * runs it (ADR 0043 serves the same tools from turno's host); the contract test still starts it
 * to compare tool lists.
 */
export function mcpEntryPath(): string {
  return join(patchrightDir(), "lib", "entry", "mcp.js");
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
