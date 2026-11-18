/**
 * Optional packages: installed apart from turno-cli and loaded only by the commands that need
 * them (ADR 0019, ADR 0045). turno-browser today; a turno-tui later goes in OPTIONAL the same way.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/**
 * The version of an optional package's API (ADR 0047): `minor` grows when something is added,
 * `major` when something is removed or changes. The package exports it as `API_VERSION`.
 */
export interface ApiVersion {
  readonly major: number;
  readonly minor: number;
}

function isApiVersion(v: unknown): v is ApiVersion {
  const o = v as Partial<ApiVersion> | null | undefined;
  return typeof o === "object" && o !== null && [o.major, o.minor].every((n) => Number.isInteger(n) && (n as number) >= 0);
}

/**
 * Why an installed package's `API_VERSION` does not fit the one this turno was built against,
 * or undefined when it does: the same major and at least the minor. One line that names the
 * command to run: update the package when it is older, update turno when it is newer.
 */
export function apiMismatch(pkg: OptionalPackage, found: unknown, wanted: ApiVersion): string | undefined {
  const needs = `this turno needs ${wanted.major}.${wanted.minor} or a later ${wanted.major}.x`;
  const update = `update it: ${pkg.install}@latest`;
  if (!isApiVersion(found)) return `${pkg.name} is too old for this turno (it has no API_VERSION, ${needs}); ${update}`;
  if (found.major > wanted.major) return `${pkg.name} is too new for this turno (its API is ${found.major}.${found.minor}, this turno speaks ${wanted.major}.x); update turno: turno upgrade`;
  if (found.major < wanted.major || found.minor < wanted.minor) return `${pkg.name} is too old for this turno (its API is ${found.major}.${found.minor}, ${needs}); ${update}`;
  return undefined;
}

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

/**
 * The node_modules folders of every pnpm global group, when `self` (this turno's package
 * folder) is in one. pnpm 11 and later install each global package in its own group
 * (`$PNPM_HOME/global/v11/<group>/node_modules`), so a package added with its own
 * `pnpm add --global` is not next to turno, and npm's global folder does not have it either.
 */
export function pnpmGlobalRoots(self: string): string[] {
  let real = self;
  try {
    real = realpathSync(self);
  } catch {
    /* keep it */
  }
  const parts = real.split(sep);
  const at = parts.findIndex((p, i) => p === "global" && /^v\d+$/.test(parts[i + 1] ?? "") && parts[i + 3] === "node_modules");
  if (at < 0) return [];
  const groups = parts.slice(0, at + 2).join(sep);
  let names: string[];
  try {
    names = readdirSync(groups).sort();
  } catch {
    return [];
  }
  return names.map((g) => join(groups, g, "node_modules")).filter((d) => existsSync(d));
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
  /**
   * The `API_VERSION` this turno was built against. The module's own is compared first
   * (`apiMismatch`); a module that does not fit is a CliError that says what to update.
   */
  api?: ApiVersion;
  /** For tests: how to import a specifier or a file URL. */
  importer?: (specifier: string) => Promise<unknown>;
  /** For tests: the global npm folder. */
  globalRoot?: (env: NodeJS.ProcessEnv) => string | undefined;
  /** For tests: this turno's package folder (where pnpm's global groups are looked for). */
  self?: string;
}

/**
 * Load an optional package: next to this install first, then (with `global`) from the global
 * npm folder. Undefined when it is not installed; any other import error is thrown, as is a
 * module whose API_VERSION does not fit or that the guard rejects (a CliError naming the
 * update command).
 */
export async function loadOptional<T>(pkg: OptionalPackage, options: LoadOptions<T> = {}): Promise<T | undefined> {
  const load = options.importer ?? ((s: string) => import(s));
  const checked = (mod: unknown): T => {
    if (options.api) {
      const problem = apiMismatch(pkg, (mod as { API_VERSION?: unknown } | null | undefined)?.API_VERSION, options.api);
      if (problem) throw new CliError(problem);
    }
    if (options.guard && !options.guard(mod)) throw new CliError(`this ${pkg.name} is too old or not a ${pkg.name} for this turno; update it: ${pkg.install}@latest`);
    return mod as T;
  };
  try {
    return checked(await load(pkg.name));
  } catch (err) {
    if (!isMissingModule(err)) throw err;
  }
  if (!options.global) return undefined;
  const self = options.self ?? fileURLToPath(new URL("../../", import.meta.url));
  for (const root of pnpmGlobalRoots(self)) {
    const found = await loadFrom(root, pkg, load, checked);
    if (found !== undefined) return found;
  }
  const root = (options.globalRoot ?? npmGlobalRoot)(options.env ?? process.env);
  if (!root) return undefined;
  return await loadFrom(root, pkg, load, checked);
}

/** The package as installed in the node_modules folder `root`, undefined when it is not there. */
async function loadFrom<T>(root: string, pkg: OptionalPackage, load: (s: string) => Promise<unknown>, checked: (mod: unknown) => T): Promise<T | undefined> {
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
