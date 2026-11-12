import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { expandHome, paths } from "./paths.js";

export type BrowserMode = "chrome" | "default";

export interface ProfileConfig {
  /** How `turno open` shows claude.ai links: an isolated Chrome profile or the default browser. */
  browser: BrowserMode;
  /** Status line pill color (name or 256-color code). */
  color?: string | number;
}

export interface ProjectRule {
  path: string;
  profile: string;
}

export interface Config {
  /** Profile that the plain `claude` command (hub config dir) is logged into. */
  system?: string;
  /** Profile for folders without a rule. */
  default?: string;
  /** Profile used when the assigned one is marked exhausted. */
  fallback?: string;
  icons: "auto" | "nerd" | "unicode";
  /** Terminals whose font draws Nerd Font icons (set by `turno ui install`), for `auto` icons. */
  nerdTerminals: string[];
  /** Look for new turno releases once a day (`update_check = false` turns it off). */
  updateCheck: boolean;
  profiles: Record<string, ProfileConfig>;
  projects: ProjectRule[];
  open: { chromeDir: string };
  mcpd: { port: number };
}

export class ConfigError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
  }
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidProfileName(name: string): boolean {
  return NAME.test(name);
}

function str(v: unknown, file: string, key: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ConfigError(file, `${key} must be a string`);
  return v;
}

export function parseConfig(text: string, file = "config.toml", env: NodeJS.ProcessEnv = process.env): Config {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(file, (err as Error).message);
  }
  const p = paths(env);
  const cfg: Config = {
    icons: "auto",
    nerdTerminals: [],
    updateCheck: true,
    profiles: {},
    projects: [],
    open: { chromeDir: p.chromeProfilesDir },
    mcpd: { port: 47821 },
  };
  cfg.system = str(raw.system, file, "system");
  cfg.default = str(raw.default, file, "default");
  cfg.fallback = str(raw.fallback, file, "fallback");
  const icons = str(raw.icons, file, "icons");
  if (icons !== undefined) {
    if (icons !== "auto" && icons !== "nerd" && icons !== "unicode") {
      throw new ConfigError(file, "icons must be auto, nerd or unicode");
    }
    cfg.icons = icons;
  }
  const nerd = raw.nerd_terminals;
  if (nerd !== undefined) {
    if (!Array.isArray(nerd) || nerd.some((t) => typeof t !== "string")) {
      throw new ConfigError(file, "nerd_terminals must be an array of terminal names");
    }
    cfg.nerdTerminals = nerd as string[];
  }

  if (raw.update_check !== undefined) {
    if (typeof raw.update_check !== "boolean") throw new ConfigError(file, "update_check must be true or false");
    cfg.updateCheck = raw.update_check;
  }

  const profiles = raw.profiles ?? {};
  if (typeof profiles !== "object" || Array.isArray(profiles)) throw new ConfigError(file, "[profiles] must be a table");
  for (const [name, value] of Object.entries(profiles as Record<string, unknown>)) {
    if (!isValidProfileName(name)) throw new ConfigError(file, `invalid profile name "${name}"`);
    const v = (value ?? {}) as Record<string, unknown>;
    const browser = str(v.browser, file, `profiles.${name}.browser`) ?? "chrome";
    if (browser !== "chrome" && browser !== "default") {
      throw new ConfigError(file, `profiles.${name}.browser must be chrome or default`);
    }
    const color = v.color;
    if (color !== undefined && typeof color !== "string" && typeof color !== "number") {
      throw new ConfigError(file, `profiles.${name}.color must be a name or a number`);
    }
    cfg.profiles[name] = { browser, ...(color !== undefined ? { color } : {}) };
  }

  const projects = raw.projects ?? [];
  if (!Array.isArray(projects)) throw new ConfigError(file, "projects must be an array of tables ([[projects]])");
  for (const [i, item] of projects.entries()) {
    const v = item as Record<string, unknown>;
    const path = str(v.path, file, `projects[${i}].path`);
    const profile = str(v.profile, file, `projects[${i}].profile`);
    if (!path || !profile) throw new ConfigError(file, `projects[${i}] needs path and profile`);
    cfg.projects.push({ path: expandHome(path, env), profile });
  }

  const open = (raw.open ?? {}) as Record<string, unknown>;
  const chromeDir = str(open.chrome_dir, file, "open.chrome_dir");
  if (chromeDir) cfg.open.chromeDir = expandHome(chromeDir, env);

  const mcpd = (raw.mcpd ?? {}) as Record<string, unknown>;
  if (mcpd.port !== undefined) {
    if (typeof mcpd.port !== "number" || !Number.isInteger(mcpd.port) || mcpd.port < 1024 || mcpd.port > 65535) {
      throw new ConfigError(file, "mcpd.port must be an integer between 1024 and 65535");
    }
    cfg.mcpd.port = mcpd.port;
  }
  return cfg;
}

/** Load ~/.config/turno/config.toml; a missing file means all defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = paths(env).configFile;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return parseConfig(text, file, env);
}
