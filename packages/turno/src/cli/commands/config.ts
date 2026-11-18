import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parse } from "smol-toml";
import { loadRegistry } from "../../accounts/registry.js";
import { editConfig, migrationPending, readConfigText } from "../../core/config-edit.js";
import {
  IDLE_UNDER_PRESSURE_PROBLEM,
  loadConfig,
  parseIdleUnderPressure,
  requestBodyProblem,
} from "../../core/config.js";
import { type AgentId, DEFAULT_AGENT, adapter, isAgentId } from "../../agents/index.js";
import { agentOf, configProblems, listProfiles } from "../../core/profiles.js";
import { Journal } from "../../core/journal.js";
import { loadManifest } from "../../core/manifest.js";
import { paths, tildify } from "../../core/paths.js";
import { type TomlValue, removeValue, setValue } from "../../core/toml-edit.js";
import { DRY_RUN, JSON_FLAG, bool, flagsOf, parseFlags } from "../args.js";
import { emit, emitConfigValue, jsonOutput } from "../output.js";
import { group } from "../group.js";
import { highlightToml } from "../highlight.js";
import { CliError, type Io, colors, columns, fail, paint } from "../io.js";
import { parseColor } from "./profile.js";

/**
 * `turno config path --json`: one entry per file, each {path, exists} (ADR 0045); with --all,
 * `all` lists every path turno uses, each {name, path, exists, about}.
 */
const PATH_JSON = jsonOutput(["config", "mcp", "accounts", "state", "backups", "all"]);
const PATH_FLAGS = { all: { type: "boolean" as const }, ...JSON_FLAG };

/** Keys `config set` may change; tables of their own have their own commands. */
const KEYS: Record<string, string> = {
  system: 'profile the plain claude command (~/.claude) is logged into; "" for none (then turno auto needs a rule)',
  default: "Claude Code profile for folders without a rule",
  fallback: "Claude Code profile used while the assigned one is exhausted (opt-in)",
  "agents.<agent>.default": "the same for codex, copilot or cursor",
  "agents.<agent>.fallback": "the same for codex, copilot or cursor (opt-in)",
  icons: "auto, nerd or unicode",
  nerd_terminals: "terminals whose font draws Nerd icons",
  update_check: "true or false: look for new turno releases once a day",
  hints: "true or false: print the next step after a command that writes",
  "open.chrome_dir": "folder of the isolated Chrome profiles",
  "mcpd.port": "port of the MCP gateway",
  "mcpd.call_log": "true or false: keep the log of tool calls (turno mcp log)",
  "mcpd.max_request_body": 'largest request mcpd accepts, like "64MiB" (default 32MiB)',
  "mcpd.idle_under_pressure": 'idle limit of MCP servers while memory is low, like "5m" (default), or false',
  "profiles.<name>.color": "status line pill color",
  "profiles.<name>.browser": "chrome or default",
};

/** Split a dotted key into its table and key. */
export function splitKey(key: string): { table: string | undefined; key: string } {
  const pattern = (k: string) =>
    new RegExp(
      `^${k.replace(/\./g, "\\.").replace("<name>", "[a-z0-9][a-z0-9_-]*").replace("<agent>", "(codex|copilot|cursor)")}$`,
    );
  const allowed = Object.keys(KEYS).some((k) => pattern(k).test(key));
  if (!allowed) fail(`unknown key '${key}' (turno config --help lists them)`);
  const i = key.lastIndexOf(".");
  return i < 0 ? { table: undefined, key } : { table: key.slice(0, i), key: key.slice(i + 1) };
}

/** A command-line value as TOML: booleans, integers and [a, b] lists, else a string. */
export function parseValue(raw: string): TomlValue {
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith("[")) {
    try {
      const v = (parse(`v = ${raw}`) as { v: unknown }).v;
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
    } catch {
      /* fall through */
    }
    fail(`invalid list ${raw} (use ["a", "b"])`);
  }
  return raw;
}

function lookup(doc: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), doc);
}

async function path(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, PATH_FLAGS, 0);
  const env = io.env;
  const pp = paths(env);
  const files = {
    config: pp.configFile,
    mcp: pp.mcpFile,
    accounts: pp.accountsFile,
    state: pp.state,
    backups: pp.backupsDir,
  };
  const all = bool(p, "all") ? (await import("../diagnostics.js")).allPaths(env) : undefined;
  if (bool(p, "json")) {
    emit(io, p, PATH_JSON, {
      ...Object.fromEntries(
        Object.entries(files).map(([k, v]) => [k, { path: tildify(v, env), exists: existsSync(v) }]),
      ),
      ...(all
        ? {
            all: all.map((e) => ({
              name: e.name,
              path: tildify(e.path, env),
              exists: existsSync(e.path),
              about: e.about,
            })),
          }
        : {}),
    });
    return 0;
  }
  if (all) {
    const w = Math.max(...all.map((e) => e.name.length));
    for (const e of all)
      io.out(
        `${e.name.padEnd(w)}  ${tildify(e.path, env)}${existsSync(e.path) ? "" : paint(io, "  (not there yet)", "2")}  ${paint(io, e.about, "2")}`,
      );
    return 0;
  }
  for (const [k, v] of Object.entries(files))
    io.out(`${k.padEnd(9)} ${tildify(v, env)}${existsSync(v) ? "" : paint(io, "  (not there yet)", "2")}`);
  return 0;
}

async function get(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  // A config value has config.toml's shape, not a schema of fields (ADR 0045).
  if (p.json) fail("config get --json takes no fields: it prints the value as config.toml holds it");
  const key = p.positionals[0];
  const text = readConfigText(io.env);
  loadConfig(io.env); // report a broken file before reading from it
  const doc = parse(text) as Record<string, unknown>;
  const v = key ? lookup(doc, key) : doc;
  if (v === undefined) {
    if (!key) return 0;
    if (bool(p, "json")) throw new CliError(`${key} is not set`);
    io.err(`${key} is not set`);
    return 1;
  }
  if (bool(p, "json") || typeof v === "object") emitConfigValue(io, v);
  else io.out(String(v));
  return 0;
}

/**
 * Check a value before it is written, with the messages `profile add` uses: profile names
 * must exist (and run the right agent), colors and enums must be valid. Returns the value to write.
 */
export function checkValue(key: string, raw: string, env: NodeJS.ProcessEnv): TomlValue {
  const value = parseValue(raw);
  const profile = (name: TomlValue, agent: AgentId) => {
    if (typeof name !== "string" || !name) fail(`${key} must be a profile name`);
    const config = loadConfig(env);
    if (!listProfiles(config, env).includes(name)) fail(`no profile '${name}' (turno profile list)`);
    const has = agentOf(name, config);
    if (has !== agent) fail(`${name} is a ${adapter(has).label} profile, but ${key} is for ${adapter(agent).label}`);
    return name;
  };
  const roles = /^(?:agents\.([a-z]+)\.)?(system|default|fallback)$/.exec(key);
  if (roles) {
    if (key === "system" && (value === "" || raw === '""')) return "";
    const agent = roles[1] ?? DEFAULT_AGENT;
    if (!isAgentId(agent)) fail(`unknown agent '${agent}'`);
    return profile(value, agent);
  }
  const prof = /^profiles\.([^.]+)\.(color|browser)$/.exec(key);
  if (prof) {
    if (!listProfiles(loadConfig(env), env).includes(prof[1]!)) fail(`no profile '${prof[1]}' (turno profile list)`);
    if (prof[2] === "color") return parseColor(raw, key);
    if (raw !== "chrome" && raw !== "default") fail(`${key} must be chrome or default`);
    return raw;
  }
  switch (key) {
    case "icons":
      if (raw !== "auto" && raw !== "nerd" && raw !== "unicode") fail("icons must be auto, nerd or unicode");
      return raw;
    case "update_check":
    case "hints":
      if (typeof value !== "boolean") fail(`${key} must be true or false`);
      return value;
    case "mcpd.port":
      if (typeof value !== "number" || value < 1024 || value > 65535)
        fail("mcpd.port must be an integer between 1024 and 65535");
      return value;
    case "mcpd.max_request_body": {
      const problem = requestBodyProblem(value);
      if (problem) fail(problem);
      return value;
    }
    case "mcpd.idle_under_pressure":
      if (parseIdleUnderPressure(value) === undefined) fail(IDLE_UNDER_PRESSURE_PROBLEM);
      return value;
    case "nerd_terminals":
      if (!Array.isArray(value)) fail('nerd_terminals must be a list, like ["warp", "vscode"]');
      return value;
    case "open.chrome_dir":
      return raw;
  }
  return value;
}

const SET_SPEC = { ...DRY_RUN };

async function set(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, SET_SPEC, 2);
  const [key, raw] = p.positionals;
  if (!key || raw === undefined) return fail("usage: turno config set <key> <value>");
  const k = splitKey(key);
  const value = checkValue(key, raw, io.env);
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `config set ${key}`, dry);
  const { changed } = editConfig(io.env, journal, (t) => setValue(t, k.table, k.key, value));
  const line = `${key} = ${JSON.stringify(value)}`;
  io.out(`${colors(io) ? highlightToml(line) : line}${changed ? "" : " (unchanged)"}${dry ? " (dry run)" : ""}`);
  if (/(^|\.)fallback$/.test(key))
    io.out('fallback is opt-in: read "Vendor terms" in the README before relying on it.');
  if (journal.hint()) io.out(journal.hint()!);
  return 0;
}

async function unset(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const key = p.positionals[0];
  if (!key) return fail("usage: turno config unset <key>");
  const k = splitKey(key);
  const journal = new Journal(io.env, `config unset ${key}`, bool(p, "dry-run"));
  const { changed } = editConfig(io.env, journal, (t) => removeValue(t, k.table, k.key));
  io.out(changed ? `${key} removed${bool(p, "dry-run") ? " (dry run)" : ""}` : `${key} was not set`);
  if (journal.hint()) io.out(journal.hint()!);
  return 0;
}

async function edit(args: string[], io: Io): Promise<number> {
  parseFlags(args, {}, 0);
  if (migrationPending(io.env)) fail("run turno migrate first: it writes config.toml from the bash config");
  const file = paths(io.env).configFile;
  const editor = io.env.VISUAL || io.env.EDITOR || "vi";
  const journal = new Journal(io.env, "config edit");
  journal.save(file);
  const r = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit", env: io.env });
  journal.settle(file);
  if (r.status !== 0) io.err(`${editor} exited with ${r.status ?? r.signal}`);
  return check([], io);
}

/** Parse config.toml, mcp.toml and accounts.toml; exit 1 when one is broken. */
async function check(args: string[], io: Io): Promise<number> {
  parseFlags(args, {}, 0);
  const pp = paths(io.env);
  let failed = 0;
  const one = (file: string, load: () => void) => {
    if (!existsSync(file)) {
      io.out(`${paint(io, "none", "2")}  ${tildify(file, io.env)}`);
      return;
    }
    try {
      load();
      io.out(`${paint(io, "ok  ", "32")}  ${tildify(file, io.env)}`);
    } catch (err) {
      failed++;
      io.out(`${paint(io, "FAIL", "31")}  ${(err as Error).message}`);
    }
  };
  const problems: string[] = [];
  one(pp.configFile, () => problems.push(...configProblems(loadConfig(io.env), io.env)));
  for (const w of problems) io.out(`${paint(io, "warn", "33")}  ${w}`);
  one(pp.mcpFile, () => loadManifest(io.env));
  one(pp.accountsFile, () => loadRegistry(io.env));
  return failed ? 1 : 0;
}

export const command = group(
  "config",
  "read and change config.toml without losing its comments; check every config file",
  {
    path: {
      summary: "where each config and state file lives (--all: every path turno uses)",
      synopsis: "[--all] [--json]",
      flags: flagsOf(PATH_FLAGS),
      json: PATH_JSON,
      details:
        "--all adds the logs, tokens, caches, service file, launchers, each agent's\nfolder and each profile's folder and launcher, with what turno keeps there.\nThe paths only, never what is in them.",
      run: path,
    },
    get: {
      summary: "print a value (the whole file as JSON without a key)",
      synopsis: "[key] [--json]",
      args: ["key"],
      flags: ["--json"],
      run: get,
    },
    set: {
      summary: "set a value, checked like profile add checks it",
      synopsis: "<key> <value> [--dry-run]",
      args: ["key", "any"],
      flags: flagsOf(SET_SPEC),
      run: set,
    },
    unset: {
      summary: "remove a value",
      synopsis: "<key> [--dry-run]",
      args: ["key"],
      flags: ["--dry-run"],
      run: unset,
    },
    edit: { summary: "open config.toml in $VISUAL or $EDITOR, then check it", run: edit },
    check: { summary: "parse config.toml, mcp.toml and accounts.toml", run: check },
  },
  {
    fallback: "path",
    footer: `Keys:\n${columns(Object.entries(KEYS), 2, 26)}\n\nProjects use turno profile assign; MCP servers live in mcp.toml (turno mcp).
A [[projects]] rule with mcp = [...] limits the servers of that folder.`,
    examples: [
      "turno config path --json",
      "turno config path --all",
      "turno config get default",
      "turno config get mcpd --json",
      "turno config set default work",
      "turno config set icons unicode --dry-run",
      "turno config unset fallback",
      "turno config edit",
      "turno config check",
    ],
  },
);

export const CONFIG_KEYS = Object.keys(KEYS);
