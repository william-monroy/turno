import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { ConfigError, isValidProfileName } from "./config.js";
import { paths } from "./paths.js";

export type Scope = "shared" | "project" | "session";

/** Settings a profile variant may override. */
export interface ServerVariant {
  command?: string;
  args?: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface StdioServer {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** npm spec installed by `claudio mcp install` (for example "chrome-devtools-mcp@0.9.0"). */
  package?: string;
  scope: Scope;
  /** Seconds without traffic before the upstream is stopped. */
  idle: number;
  /** One client session at a time (browser identities). */
  exclusive: boolean;
  /** Seconds an idle holder keeps an exclusive lease. */
  lease: number;
  /** Profiles that get this server in their config; ["*"] means all. */
  profiles: string[];
  variants: Record<string, ServerVariant>;
  /** Builtin servers run inside mcpd (no process). */
  builtin?: string;
}

export interface RemoteServer {
  kind: "remote";
  name: string;
  /** Raw entry written as-is into each profile's mcpServers (type, url, headers, ...). */
  entry: Record<string, unknown>;
  profiles: string[];
  /**
   * True when a header value references a secret (keychain:/env:). mcpd then proxies the
   * server and adds the resolved headers upstream, so no secret lands in a profile config.
   */
  proxy: boolean;
  url: string;
  headers: Record<string, string>;
  idle: number;
}

export type ServerDef = StdioServer | RemoteServer;

export interface Manifest {
  servers: Record<string, ServerDef>;
}

/** A value resolved at spawn time: "keychain:<service>" or "env:<NAME>". */
export function isSecretRef(v: string): boolean {
  return v.startsWith("keychain:") || v.startsWith("env:");
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** "90s", "15m", "2h" or a number of seconds. */
export function parseDuration(v: unknown, file: string, key: string): number {
  if (typeof v === "number" && v >= 0) return v;
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(v.trim());
    if (m) return Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
  }
  throw new ConfigError(file, `${key} must be a duration like "15m"`);
}

function strArray(v: unknown, file: string, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ConfigError(file, `${key} must be an array of strings`);
  return v as string[];
}

function strRecord(v: unknown, file: string, key: string): Record<string, string> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(file, `${key} must be a table`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") throw new ConfigError(file, `${key}.${k} must be a string`);
    out[k] = val;
  }
  return out;
}

function optStr(v: unknown, file: string, key: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v) throw new ConfigError(file, `${key} must be a non-empty string`);
  return v;
}

function profilesOf(v: unknown, file: string, key: string): string[] {
  const list = v === undefined ? ["*"] : strArray(v, file, key);
  for (const p of list) if (p !== "*" && !isValidProfileName(p)) throw new ConfigError(file, `${key}: invalid profile "${p}"`);
  return list;
}

export function parseManifest(text: string, file = "mcp.toml"): Manifest {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(file, (err as Error).message);
  }
  const servers: Record<string, ServerDef> = {};
  const table = (raw.server ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(table)) {
    if (!SERVER_NAME.test(name)) throw new ConfigError(file, `invalid server name "${name}"`);
    const v = (value ?? {}) as Record<string, unknown>;
    const key = `server.${name}`;
    const profiles = profilesOf(v.profiles, file, `${key}.profiles`);
    if (v.url !== undefined) {
      if (typeof v.url !== "string") throw new ConfigError(file, `${key}.url must be a string`);
      const { profiles: _p, idle: _i, ...rest } = v;
      const entry: Record<string, unknown> = { type: "http", ...rest };
      const headers = strRecord(v.headers, file, `${key}.headers`);
      const proxy = Object.values(headers).some(isSecretRef);
      servers[name] = {
        kind: "remote",
        name,
        entry,
        profiles,
        proxy,
        url: v.url,
        headers,
        idle: v.idle === undefined ? 30 * 60 : parseDuration(v.idle, file, `${key}.idle`),
      };
      continue;
    }
    const builtin = optStr(v.builtin, file, `${key}.builtin`);
    const command = optStr(v.command, file, `${key}.command`) ?? (builtin ? `builtin:${builtin}` : undefined);
    if (!command) throw new ConfigError(file, `${key} needs command, url or builtin`);
    const scope = (v.scope ?? "shared") as string;
    if (scope !== "shared" && scope !== "project" && scope !== "session") {
      throw new ConfigError(file, `${key}.scope must be shared, project or session`);
    }
    const exclusive = v.exclusive === undefined ? false : v.exclusive;
    if (typeof exclusive !== "boolean") throw new ConfigError(file, `${key}.exclusive must be true or false`);
    if (exclusive && scope !== "shared") throw new ConfigError(file, `${key}: exclusive needs scope = "shared"`);
    const variants: Record<string, ServerVariant> = {};
    for (const [prof, vv] of Object.entries((v.variant ?? {}) as Record<string, unknown>)) {
      if (!isValidProfileName(prof)) throw new ConfigError(file, `${key}.variant: invalid profile "${prof}"`);
      const o = (vv ?? {}) as Record<string, unknown>;
      const variant: ServerVariant = { env: strRecord(o.env, file, `${key}.variant.${prof}.env`) };
      const vc = optStr(o.command, file, `${key}.variant.${prof}.command`);
      if (vc) variant.command = vc;
      if (o.args !== undefined) variant.args = strArray(o.args, file, `${key}.variant.${prof}.args`);
      const vcwd = optStr(o.cwd, file, `${key}.variant.${prof}.cwd`);
      if (vcwd) variant.cwd = vcwd;
      variants[prof] = variant;
    }
    const server: StdioServer = {
      kind: "stdio",
      name,
      command,
      args: strArray(v.args, file, `${key}.args`),
      env: strRecord(v.env, file, `${key}.env`),
      scope,
      idle: v.idle === undefined ? (scope === "shared" ? 30 * 60 : 20 * 60) : parseDuration(v.idle, file, `${key}.idle`),
      exclusive,
      lease: v.lease === undefined ? 5 * 60 : parseDuration(v.lease, file, `${key}.lease`),
      profiles,
      variants,
    };
    const cwd = optStr(v.cwd, file, `${key}.cwd`);
    if (cwd) server.cwd = cwd;
    const pkg = optStr(v.package, file, `${key}.package`);
    if (pkg) server.package = pkg;
    if (builtin) server.builtin = builtin;
    servers[name] = server;
  }
  return { servers };
}

export function loadManifest(env: NodeJS.ProcessEnv = process.env): Manifest {
  const file = paths(env).mcpFile;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return parseManifest(text, file);
}

/** Whether a profile should get this server in its config. */
export function servesProfile(server: ServerDef, profile: string): boolean {
  return server.profiles.includes("*") || server.profiles.includes(profile);
}

/** The variant key for a profile: its name when it has an override block, else "default". */
export function variantKey(server: StdioServer, profile: string | undefined): string {
  return profile && server.variants[profile] ? profile : "default";
}

/** Effective launch settings for a variant. */
export function effectiveLaunch(server: StdioServer, variant: string): { command: string; args: string[]; env: Record<string, string>; cwd?: string } {
  const v = server.variants[variant];
  const out: { command: string; args: string[]; env: Record<string, string>; cwd?: string } = {
    command: v?.command ?? server.command,
    args: v?.args ?? server.args,
    env: { ...server.env, ...(v?.env ?? {}) },
  };
  const cwd = v?.cwd ?? server.cwd;
  if (cwd) out.cwd = cwd;
  return out;
}
