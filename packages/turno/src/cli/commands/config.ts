import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parse } from "smol-toml";
import { loadRegistry } from "../../accounts/registry.js";
import { editConfig, migrationPending, readConfigText } from "../../core/config-edit.js";
import { loadConfig } from "../../core/config.js";
import { Journal } from "../../core/journal.js";
import { loadManifest } from "../../core/manifest.js";
import { paths, tildify } from "../../core/paths.js";
import { type TomlValue, removeValue, setValue } from "../../core/toml-edit.js";
import { DRY_RUN, JSON_FLAG, bool, parseFlags, printJson } from "../args.js";
import { group } from "../group.js";
import { type Io, fail, paint } from "../io.js";

/** Keys `config set` may change; tables of their own have their own commands. */
const KEYS: Record<string, string> = {
  system: "profile the plain claude command (~/.claude) is logged into",
  default: "profile for folders without a rule",
  fallback: "profile used while the assigned one is exhausted",
  icons: "auto, nerd or unicode",
  nerd_terminals: "terminals whose font draws Nerd icons",
  update_check: "true or false: look for new turno releases once a day",
  "open.chrome_dir": "folder of the isolated Chrome profiles",
  "mcpd.port": "port of the MCP gateway",
  "profiles.<name>.color": "status line pill color",
  "profiles.<name>.browser": "chrome or default",
};

/** Split a dotted key into its table and key. */
export function splitKey(key: string): { table: string | undefined; key: string } {
  const allowed = Object.keys(KEYS).some((k) => new RegExp(`^${k.replace(/\./g, "\\.").replace("<name>", "[a-z0-9][a-z0-9_-]*")}$`).test(key));
  if (!allowed) fail(`unknown key '${key}'. Keys: ${Object.keys(KEYS).join(", ")}`);
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
  return key.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), doc);
}

async function path(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const env = io.env;
  const pp = paths(env);
  const files = { config: pp.configFile, mcp: pp.mcpFile, accounts: pp.accountsFile, state: pp.state, backups: pp.backupsDir };
  if (bool(p, "json")) {
    printJson(io.out, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { path: tildify(v, env), exists: existsSync(v) }])));
    return 0;
  }
  for (const [k, v] of Object.entries(files)) io.out(`${k.padEnd(9)} ${tildify(v, env)}${existsSync(v) ? "" : paint(io, "  (not there yet)", "2")}`);
  return 0;
}

async function get(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  const key = p.positionals[0];
  const text = readConfigText(io.env);
  loadConfig(io.env); // report a broken file before reading from it
  const doc = parse(text) as Record<string, unknown>;
  const v = key ? lookup(doc, key) : doc;
  if (v === undefined) {
    if (!key) return 0;
    io.err(`${key} is not set`);
    return 1;
  }
  if (bool(p, "json") || typeof v === "object") printJson(io.out, v);
  else io.out(String(v));
  return 0;
}

async function set(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 2);
  const [key, raw] = p.positionals;
  if (!key || raw === undefined) return fail("usage: turno config set <key> <value>");
  const k = splitKey(key);
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `config set ${key}`, dry);
  const { changed } = editConfig(io.env, journal, (t) => setValue(t, k.table, k.key, parseValue(raw)));
  io.out(`${key} = ${JSON.stringify(parseValue(raw))}${changed ? "" : " (unchanged)"}${dry ? " (dry run)" : ""}`);
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
  one(pp.configFile, () => loadConfig(io.env));
  one(pp.mcpFile, () => loadManifest(io.env));
  one(pp.accountsFile, () => loadRegistry(io.env));
  return failed ? 1 : 0;
}

export const command = group(
  "config",
  "read and change config.toml without losing its comments; check every config file",
  {
    path: { summary: "where each config and state file lives", synopsis: "[--json]", flags: ["--json"], run: path },
    get: { summary: "print a value (the whole file as JSON without a key)", synopsis: "[key] [--json]", args: ["key"], flags: ["--json"], run: get },
    set: { summary: "set a value; the file must still parse", synopsis: "<key> <value> [--dry-run]", args: ["key", "any"], flags: ["--dry-run"], run: set },
    unset: { summary: "remove a value", synopsis: "<key> [--dry-run]", args: ["key"], flags: ["--dry-run"], run: unset },
    edit: { summary: "open config.toml in $VISUAL or $EDITOR, then check it", run: edit },
    check: { summary: "parse config.toml, mcp.toml and accounts.toml", run: check },
  },
  {
    fallback: "path",
    footer: `Keys:\n${Object.entries(KEYS)
      .map(([k, d]) => `  ${k.padEnd(26)} ${d}`)
      .join("\n")}\n\nProjects use turno profile assign; MCP servers live in mcp.toml (turno mcp).`,
  },
);

export const CONFIG_KEYS = Object.keys(KEYS);
