import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import { ConfigError, isValidProfileName } from "../core/config.js";
import { expandHome, paths, tildify } from "../core/paths.js";

/** One service account (a Linear workspace, a Gmail connector) owned by one Claude profile. */
export interface Account {
  /** `service:label`, for example `linear:work`. */
  id: string;
  service: string;
  label: string;
  /** Owning Claude profile: the one whose MCP config reaches this account. */
  profile: string;
  /** Tool patterns that reach the account inside the owning profile (`mcp__linear__*`). */
  tools: string[];
  description?: string;
}

/** Folder rule: inside `path`, prefer these accounts (service name to account id). */
export interface PreferRule {
  /** Absolute path, `~` expanded. */
  path: string;
  accounts: Record<string, string>;
}

export interface Registry {
  accounts: Record<string, Account>;
  prefer: PreferRule[];
}

const ACCOUNT_ID = /^([a-z0-9][a-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9_.@-]*)$/;
const SERVICE = /^[a-z0-9][a-z0-9_-]*$/;

/** Split and validate an account id (`service:label`); undefined when malformed. */
export function parseAccountId(id: string): { service: string; label: string } | undefined {
  const m = ACCOUNT_ID.exec(id);
  return m ? { service: m[1]!, label: m[2]! } : undefined;
}

export function isValidService(name: string): boolean {
  return SERVICE.test(name);
}

function table(v: unknown, file: string, key: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(file, `${key} must be a table`);
  return v as Record<string, unknown>;
}

function optStr(v: unknown, file: string, key: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ConfigError(file, `${key} must be a string`);
  return v;
}

/** Validate one account definition; shared by the parser and `claudio accounts add`. */
export function makeAccount(
  id: string,
  fields: { service?: string; profile?: string; tools?: unknown; description?: string },
  file = "accounts.toml",
): Account {
  const key = `account."${id}"`;
  const parsed = parseAccountId(id);
  if (!parsed) throw new ConfigError(file, `invalid account id "${id}" (expected service:label, like linear:work)`);
  const service = fields.service ?? parsed.service;
  if (service !== parsed.service) {
    throw new ConfigError(file, `${key}.service is "${service}" but the id starts with "${parsed.service}"`);
  }
  if (!fields.profile) throw new ConfigError(file, `${key} needs profile`);
  if (!isValidProfileName(fields.profile)) throw new ConfigError(file, `${key}.profile: invalid profile name "${fields.profile}"`);
  const tools = fields.tools;
  if (!Array.isArray(tools) || tools.length === 0) throw new ConfigError(file, `${key}.tools must be a non-empty array of tool patterns`);
  for (const t of tools) {
    if (typeof t !== "string" || !t.trim() || /\s/.test(t)) {
      throw new ConfigError(file, `${key}.tools: invalid tool pattern ${JSON.stringify(t)}`);
    }
  }
  return {
    id,
    service,
    label: parsed.label,
    profile: fields.profile,
    tools: [...(tools as string[])],
    ...(fields.description ? { description: fields.description } : {}),
  };
}

export function parseRegistry(text: string, file = "accounts.toml", env: NodeJS.ProcessEnv = process.env): Registry {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(file, (err as Error).message);
  }
  const reg: Registry = { accounts: {}, prefer: [] };
  for (const [id, value] of Object.entries(table(raw.account, file, "account"))) {
    const v = table(value, file, `account."${id}"`);
    const service = optStr(v.service, file, `account."${id}".service`);
    const profile = optStr(v.profile, file, `account."${id}".profile`);
    const description = optStr(v.description, file, `account."${id}".description`);
    reg.accounts[id] = makeAccount(
      id,
      {
        ...(service !== undefined ? { service } : {}),
        ...(profile !== undefined ? { profile } : {}),
        tools: v.tools,
        ...(description !== undefined ? { description } : {}),
      },
      file,
    );
  }

  const prefer = raw.prefer ?? [];
  if (!Array.isArray(prefer)) throw new ConfigError(file, "prefer must be an array of tables ([[prefer]])");
  for (const [i, item] of prefer.entries()) {
    const v = table(item, file, `prefer[${i}]`);
    const path = optStr(v.path, file, `prefer[${i}].path`);
    if (!path) throw new ConfigError(file, `prefer[${i}] needs path`);
    const accounts: Record<string, string> = {};
    for (const [service, target] of Object.entries(v)) {
      if (service === "path") continue;
      if (typeof target !== "string") throw new ConfigError(file, `prefer[${i}].${service} must be an account id`);
      const acct = reg.accounts[target];
      if (!acct) throw new ConfigError(file, `prefer[${i}].${service}: unknown account "${target}"`);
      if (acct.service !== service) {
        throw new ConfigError(file, `prefer[${i}].${service}: account "${target}" belongs to service "${acct.service}"`);
      }
      accounts[service] = target;
    }
    reg.prefer.push({ path: normalize(expandHome(path, env)), accounts });
  }
  return reg;
}

/** Load accounts.toml; a missing file is an empty registry. */
export function loadRegistry(env: NodeJS.ProcessEnv = process.env): Registry {
  const file = paths(env).accountsFile;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return parseRegistry(text, file, env);
}

/** TOML text of a registry. Paths under the home are written with `~`. */
export function formatRegistry(reg: Registry, env: NodeJS.ProcessEnv = process.env): string {
  const account: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(reg.accounts).sort()) {
    const a = reg.accounts[id]!;
    account[id] = {
      service: a.service,
      profile: a.profile,
      tools: a.tools,
      ...(a.description ? { description: a.description } : {}),
    };
  }
  const doc: Record<string, unknown> = { account };
  if (reg.prefer.length) doc.prefer = reg.prefer.map((r) => ({ path: tildify(r.path, env), ...r.accounts }));
  return `# Accounts registry, managed by \`claudio accounts\`. Comments are not preserved on rewrite.\n\n${stringify(doc)}\n`;
}

/**
 * Rewrite accounts.toml from a registry. The whole file is regenerated (atomically), so
 * comments and formatting of a hand-edited file are not preserved.
 */
export function saveRegistry(reg: Registry, env: NodeJS.ProcessEnv = process.env): string {
  const file = paths(env).accountsFile;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, formatRegistry(reg, env));
  renameSync(tmp, file);
  return file;
}

function normalize(p: string): string {
  const r = resolve(p);
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function within(dir: string, root: string): boolean {
  return dir === root || root === sep || dir.startsWith(root + sep);
}

/**
 * Preferred account per service for a folder. For each service the rule with the longest
 * matching path wins. Both the folder and the rule paths are also compared through symlinks.
 */
export function preferredFor(reg: Registry, cwd: string): Record<string, string> {
  const dirs = [...new Set([normalize(cwd), normalize(real(cwd))])];
  const best: Record<string, { len: number; account: string }> = {};
  for (const rule of reg.prefer) {
    const roots = [...new Set([rule.path, normalize(real(rule.path))])];
    const match = roots.filter((r) => dirs.some((d) => within(d, r))).map((r) => r.length);
    if (!match.length) continue;
    const len = Math.max(...match);
    for (const [service, account] of Object.entries(rule.accounts)) {
      const cur = best[service];
      if (!cur || len > cur.len) best[service] = { len, account };
    }
  }
  return Object.fromEntries(Object.entries(best).map(([s, v]) => [s, v.account]));
}
