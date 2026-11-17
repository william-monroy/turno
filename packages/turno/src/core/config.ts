import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { type AgentId, AGENT_IDS, DEFAULT_AGENT, adapter, isAgentId } from "../agents/index.js";
import { distance } from "../cli/io.js";
import { expandHome, paths, tildify } from "./paths.js";

type BrowserMode = "chrome" | "default";

interface ProfileConfig {
  /** The coding agent this profile runs (ADR 0013); Claude Code when unset. */
  agent: AgentId;
  /** How `turno open` shows claude.ai links: an isolated Chrome profile or the default browser. */
  browser: BrowserMode;
  /** Status line pill color (name or 256-color code). */
  color?: string | number;
}

/** Default and fallback profiles of an agent other than Claude Code (`[agents.<id>]`). */
interface AgentRoles {
  default?: string;
  fallback?: string;
}

/**
 * A folder rule. `profile` picks the account for the folder; `mcp` and `mcp_deny` pick which
 * MCP servers mcpd shows to sessions in it (ADR 0031). A rule has a profile, a server set, or both.
 */
export interface ProjectRule {
  path: string;
  profile?: string;
  /** Only these servers (names from mcp.toml) are listed for sessions in the folder. */
  mcp?: string[];
  /** These servers are not listed, whatever `mcp` says. */
  mcpDeny?: string[];
}

export interface Config {
  /**
   * Profile that the plain `claude` command (hub config dir) is logged into. An empty string
   * means "no default account": `turno auto` refuses to start an agent outside a folder rule.
   */
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
  /** `[agents.codex]` and friends; Claude Code uses the top-level default and fallback. */
  agents: Partial<Record<AgentId, AgentRoles>>;
  projects: ProjectRule[];
  open: { chromeDir: string };
  /**
   * `port` of the gateway; whether mcpd keeps the call log (ADR 0026); `maxRequestBody`, the
   * largest request body mcpd accepts in bytes (unset: the gateway default, 32 MiB);
   * `idleUnderPressure`, the idle limit in seconds while memory is tight (ADR 0028; 0 is off).
   */
  mcpd: { port: number; callLog: boolean; maxRequestBody?: number; idleUnderPressure: number };
  /** Keys turno does not know (likely typos), with a suggestion when one is close. */
  warnings?: string[];
}

/** Every key config.toml may hold, by table ("" is the top level; `*` stands for any name). */
const KNOWN_KEYS: Record<string, readonly string[]> = {
  "": ["system", "default", "fallback", "icons", "nerd_terminals", "update_check", "profiles", "agents", "projects", "open", "mcpd"],
  "profiles.*": ["agent", "browser", "color"],
  "agents.*": ["default", "fallback"],
  "projects[]": ["path", "profile", "mcp", "mcp_deny"],
  open: ["chrome_dir"],
  mcpd: ["port", "call_log", "max_request_body", "idle_under_pressure"],
};

const SIZE_UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, kb: 1000, kib: 1024, m: 1024 ** 2, mb: 1000 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1000 ** 3, gib: 1024 ** 3 };
/** Bounds of `mcpd.max_request_body`: below 1 MiB ordinary tool calls fail, above 1 GiB a client can exhaust memory. */
const MIN_REQUEST_BODY = 1024 ** 2;
const MAX_REQUEST_BODY = 1024 ** 3;

/**
 * A size in bytes: a whole number of bytes, or a string such as "64MiB", "512 KiB" or "1GB".
 * Undefined when it is neither.
 */
export function parseSize(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(v);
  const unit = m ? SIZE_UNITS[m[2]!.toLowerCase()] : undefined;
  return m && unit ? Math.round(Number(m[1]) * unit) : undefined;
}

/** Check `mcpd.max_request_body`; the message when it is out of bounds or not a size. */
export function requestBodyProblem(v: unknown): string | undefined {
  const n = parseSize(v);
  if (n === undefined || n < MIN_REQUEST_BODY || n > MAX_REQUEST_BODY) return 'mcpd.max_request_body must be a size between 1MiB and 1GiB, in bytes or like "64MiB"';
  return undefined;
}

/** Default of `mcpd.idle_under_pressure`, in seconds. */
const DEFAULT_IDLE_UNDER_PRESSURE = 300;

/**
 * `mcpd.idle_under_pressure` in seconds: a duration ("5m", "90s", "1h" or seconds) between 30
 * seconds and 24 hours, `false` (0, off) or `true` (the default). Undefined when invalid.
 */
export function parseIdleUnderPressure(v: unknown): number | undefined {
  if (v === false) return 0;
  if (v === true) return DEFAULT_IDLE_UNDER_PRESSURE;
  let secs: number | undefined;
  if (typeof v === "number") secs = v;
  else if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(v.trim());
    if (m) secs = Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
  }
  return secs !== undefined && Number.isFinite(secs) && secs >= 30 && secs <= 24 * 3600 ? secs : undefined;
}

export const IDLE_UNDER_PRESSURE_PROBLEM = 'mcpd.idle_under_pressure must be a duration between 30s and 24h, like "5m", or false';

/** The known key closest to `key`, when it is a likely typo (or `colour` for `color`). */
export function suggestKey(key: string, known: readonly string[]): string | undefined {
  let best: { k: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(key, k);
    if (d <= Math.max(1, Math.min(3, Math.floor(k.length / 3))) && (!best || d < best.d)) best = { k, d };
  }
  return best?.k;
}

function unknownKeys(table: Record<string, unknown>, known: readonly string[], prefix: string, warnings: string[]): void {
  for (const key of Object.keys(table)) {
    if (known.includes(key)) continue;
    const near = suggestKey(key, known);
    warnings.push(`unknown key ${prefix}${key}${near ? ` (did you mean ${prefix}${near}?)` : ""}; turno ignores it`);
  }
}

/** A friendlier text for TOML syntax errors that smol-toml words in parser terms. */
function tomlMessage(message: string): string {
  const head = message.split("\n", 1)[0]!.replace(/^Invalid TOML document: /, "");
  const pos = /\n(\d+):/.exec(message);
  if (/control characters are not allowed in strings|unterminated string/i.test(head)) {
    return `line ${pos?.[1] ?? "?"}: a string is not closed (a " is missing at the end of the value)`;
  }
  return message;
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

/** A list of MCP server names (`[[projects]] mcp`), or undefined when unset. */
function names(v: unknown, file: string, key: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) throw new ConfigError(file, `${key} must be an array of server names, like ["issues", "docs"]`);
  return v as string[];
}

function table(v: unknown, file: string, key: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(file, `[${key}] must be a table`);
  return v as Record<string, unknown>;
}

export function parseConfig(text: string, path = "config.toml", env: NodeJS.ProcessEnv = process.env): Config {
  const file = tildify(path, env);
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(file, tomlMessage((err as Error).message));
  }
  const warnings: string[] = [];
  unknownKeys(raw, KNOWN_KEYS[""]!, "", warnings);
  const p = paths(env);
  const cfg: Config = {
    icons: "auto",
    nerdTerminals: [],
    updateCheck: true,
    profiles: {},
    agents: {},
    projects: [],
    open: { chromeDir: p.chromeProfilesDir },
    mcpd: { port: 47821, callLog: true, idleUnderPressure: DEFAULT_IDLE_UNDER_PRESSURE },
    warnings,
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

  const profiles = table(raw.profiles, file, "profiles");
  for (const [name, value] of Object.entries(profiles)) {
    if (!isValidProfileName(name)) throw new ConfigError(file, `invalid profile name "${name}"`);
    const v = table(value, file, `profiles.${name}`);
    unknownKeys(v, KNOWN_KEYS["profiles.*"]!, `profiles.${name}.`, warnings);
    const browser = str(v.browser, file, `profiles.${name}.browser`) ?? "chrome";
    if (browser !== "chrome" && browser !== "default") {
      throw new ConfigError(file, `profiles.${name}.browser must be chrome or default`);
    }
    const color = v.color;
    if (color !== undefined && typeof color !== "string" && typeof color !== "number") {
      throw new ConfigError(file, `profiles.${name}.color must be a name or a number`);
    }
    const agent = v.agent ?? DEFAULT_AGENT;
    if (!isAgentId(agent)) throw new ConfigError(file, `profiles.${name}.agent must be one of ${AGENT_IDS.join(", ")}`);
    cfg.profiles[name] = { agent, browser, ...(color !== undefined ? { color } : {}) };
  }

  const agents = table(raw.agents, file, "agents");
  for (const [id, value] of Object.entries(agents)) {
    if (!isAgentId(id) || id === DEFAULT_AGENT) {
      throw new ConfigError(file, `[agents.${id}]: use one of ${AGENT_IDS.filter((a) => a !== DEFAULT_AGENT).join(", ")} (${adapter(DEFAULT_AGENT).label} uses the top-level default and fallback)`);
    }
    const v = table(value, file, `agents.${id}`);
    unknownKeys(v, KNOWN_KEYS["agents.*"]!, `agents.${id}.`, warnings);
    const roles: AgentRoles = {};
    const d = str(v.default, file, `agents.${id}.default`);
    const f = str(v.fallback, file, `agents.${id}.fallback`);
    if (d) roles.default = d;
    if (f) roles.fallback = f;
    cfg.agents[id] = roles;
  }

  const projects = raw.projects ?? [];
  if (!Array.isArray(projects)) throw new ConfigError(file, "projects must be an array of tables ([[projects]])");
  for (const [i, item] of projects.entries()) {
    const v = table(item, file, `projects[${i}]`);
    unknownKeys(v, KNOWN_KEYS["projects[]"]!, `projects[${i}].`, warnings);
    const path = str(v.path, file, `projects[${i}].path`);
    const profile = str(v.profile, file, `projects[${i}].profile`);
    const mcp = names(v.mcp, file, `projects[${i}].mcp`);
    const mcpDeny = names(v.mcp_deny, file, `projects[${i}].mcp_deny`);
    if (!path || (!profile && !mcp && !mcpDeny)) throw new ConfigError(file, `projects[${i}] needs path and profile, mcp or mcp_deny`);
    cfg.projects.push({ path: expandHome(path, env), ...(profile ? { profile } : {}), ...(mcp ? { mcp } : {}), ...(mcpDeny ? { mcpDeny } : {}) });
  }

  const open = table(raw.open, file, "open");
  unknownKeys(open, KNOWN_KEYS.open!, "open.", warnings);
  const chromeDir = str(open.chrome_dir, file, "open.chrome_dir");
  if (chromeDir) cfg.open.chromeDir = expandHome(chromeDir, env);

  const mcpd = table(raw.mcpd, file, "mcpd");
  unknownKeys(mcpd, KNOWN_KEYS.mcpd!, "mcpd.", warnings);
  if (mcpd.port !== undefined) {
    if (typeof mcpd.port !== "number" || !Number.isInteger(mcpd.port) || mcpd.port < 1024 || mcpd.port > 65535) {
      throw new ConfigError(file, "mcpd.port must be an integer between 1024 and 65535");
    }
    cfg.mcpd.port = mcpd.port;
  }
  if (mcpd.call_log !== undefined) {
    if (typeof mcpd.call_log !== "boolean") throw new ConfigError(file, "mcpd.call_log must be true or false");
    cfg.mcpd.callLog = mcpd.call_log;
  }
  if (mcpd.max_request_body !== undefined) {
    const problem = requestBodyProblem(mcpd.max_request_body);
    if (problem) throw new ConfigError(file, problem);
    cfg.mcpd.maxRequestBody = parseSize(mcpd.max_request_body)!;
  }
  if (mcpd.idle_under_pressure !== undefined) {
    const secs = parseIdleUnderPressure(mcpd.idle_under_pressure);
    if (secs === undefined) throw new ConfigError(file, IDLE_UNDER_PRESSURE_PROBLEM);
    cfg.mcpd.idleUnderPressure = secs;
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
