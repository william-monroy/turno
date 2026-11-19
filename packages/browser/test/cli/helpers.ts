import type { Io } from "turno-core/cli";
import type { BrowserFunctions } from "../../src/api.js";
import { type BrowserCli, browserCli } from "../../src/cli/commands.js";
import { type BrowserCliHost, type CliDeps, type Ctx, context, standaloneHost } from "../../src/cli/context.js";

/** An Io that records output lines. */
export function fakeIo(env: NodeJS.ProcessEnv): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    env,
    isTty: false,
    out: (line = "") => lines.push(...line.split("\n")),
    err: (line = "") => errors.push(...line.split("\n")),
  };
}

/** The dependencies of the commands: `api` (often a fake), nobody to ask, then `over`. */
export function deps(api: BrowserFunctions, over: Partial<CliDeps> = {}): CliDeps {
  return { api, interactive: () => false, confirm: async () => false, ...over };
}

/** A command context on turno-browser's own host. */
export function ctx(api: BrowserFunctions, over: Partial<CliDeps> = {}, host: BrowserCliHost = standaloneHost()): Ctx {
  return context(host, deps(api, over));
}

/** The commands on turno-browser's own host. */
export function cli(
  api: BrowserFunctions,
  over: Partial<CliDeps> = {},
  host: BrowserCliHost = standaloneHost(),
): BrowserCli {
  return browserCli(host, deps(api, over));
}

/** The real functions, as the commands call them. */
export async function real(): Promise<BrowserFunctions> {
  return (await import("../../src/api.js")).api;
}
