/**
 * Optional packages: installed apart from turno-cli and loaded only by the commands that need
 * them (ADR 0019, ADR 0045). turno-browser today; a turno-tui later goes in OPTIONAL the same way.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "./io.js";

/** An optional package: its npm name and how to install it. */
export interface OptionalPackage {
  name: string;
  install: string;
}

export const OPTIONAL = {
  browser: { name: "turno-browser", install: "npm install --global turno-browser" },
  tui: { name: "turno-tui", install: "npm install --global turno-tui" },
} as const satisfies Record<string, OptionalPackage>;

/** "turno-browser is not installed: npm install --global turno-browser". */
export function notInstalled(pkg: OptionalPackage): string {
  return `${pkg.name} is not installed: ${pkg.install}`;
}

/** Whether an import failed because the package (or its entry) is not there. */
export function isMissingModule(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

/** The global npm folder, where `npm install --global <pkg>` puts packages. */
function npmGlobalRoot(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync("npm", ["root", "--global"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface LoadOptions<T> {
  /** Also look in the global npm folder, which a Homebrew or npx install of turno cannot see on its own. */
  global?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Whether the module is one this turno can use (an API it needs is there). A module that fails
   * it is an error that says to update the package, not a TypeError later.
   */
  guard?: (mod: unknown) => mod is T;
  /** For tests: how to import a specifier or a file URL. */
  importer?: (specifier: string) => Promise<unknown>;
  /** For tests: the global npm folder. */
  globalRoot?: (env: NodeJS.ProcessEnv) => string | undefined;
}

/**
 * Load an optional package: next to this install first, then (with `global`) from the global
 * npm folder. Undefined when it is not installed; any other import error is thrown, as is a
 * module the guard rejects (a CliError naming the update command).
 */
export async function loadOptional<T>(pkg: OptionalPackage, options: LoadOptions<T> = {}): Promise<T | undefined> {
  const load = options.importer ?? ((s: string) => import(s));
  const checked = (mod: unknown): T => {
    if (options.guard && !options.guard(mod)) throw new CliError(`this ${pkg.name} is too old or not a ${pkg.name} for this turno; update it: ${pkg.install}@latest`);
    return mod as T;
  };
  try {
    return checked(await load(pkg.name));
  } catch (err) {
    if (!isMissingModule(err)) throw err;
  }
  if (!options.global) return undefined;
  const root = (options.globalRoot ?? npmGlobalRoot)(options.env ?? process.env);
  if (!root) return undefined;
  let entry: string;
  try {
    entry = createRequire(join(root, "noop.js")).resolve(pkg.name);
  } catch (err) {
    if (isMissingModule(err)) return undefined;
    throw err;
  }
  try {
    return checked(await load(pathToFileURL(entry).href));
  } catch (err) {
    if (isMissingModule(err)) return undefined;
    throw err;
  }
}
