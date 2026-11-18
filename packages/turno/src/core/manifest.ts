import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { ConfigError, isValidProfileName } from "./config.js";
import { paths } from "./paths.js";

type Scope = "shared" | "project" | "session";

/**
 * Which tools of a server a session sees: glob patterns (`*` any run of characters,
 * `?` one character) matched against the whole tool name. With `allow`, only matching tools are
 * kept; `deny` then removes matching ones. Unset keys filter nothing.
 */
export interface ToolFilter {
  allow?: string[];
  deny?: string[];
}

/** Settings a profile variant may override. */
interface ServerVariant {
  command?: string;
  args?: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Replaces the server's `tools.allow` / `tools.deny`, key by key, for this profile. */
  tools?: ToolFilter;
}

export interface StdioServer {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** npm spec installed by `turno mcp install` (for example "chrome-devtools-mcp@0.9.0"). */
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
  /** Seconds a single client request may run before mcpd cancels it (off when unset). */
  callTimeout?: number;
  /**
   * Seconds mcpd waits after closing the server's stdin before it sends SIGTERM (`stop_grace`).
   * Unset: `effectiveStopGrace` picks the default.
   */
  stopGrace?: number;
  tools?: ToolFilter;
}

/**
 * `auth = "oauth"` on a remote server: mcpd is the OAuth client and keeps the tokens
 * in the secret store, one login per variant. Every key is optional; discovery fills the rest.
 */
export interface OAuthSettings {
  /** A client registered by hand with the authorization server (pre-registration). */
  clientId?: string;
  /** Its secret, usually `keychain:<name>`; resolved when it is used, never stored by turno. */
  clientSecret?: string;
  /** An HTTPS URL that serves turno's Client ID Metadata Document, used when the server supports it. */
  clientMetadataUrl?: string;
  /** Scopes to ask for instead of what the server advertises (space separated). */
  scope?: string;
  /** Fixed loopback port for the redirect, for clients registered with an exact redirect URI. */
  callbackPort?: number;
  /** Which of the server's authorization servers to use when it lists several. */
  authorizationServer?: string;
}

/** Settings a profile variant of a remote server may override (OAuth servers only). */
interface RemoteVariant {
  tools?: ToolFilter;
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
  /** Seconds a single client request may run before mcpd cancels it (off when unset). */
  callTimeout?: number;
  /** Only for proxied remotes: a direct remote never passes through mcpd. */
  tools?: ToolFilter;
  /** Set when `auth = "oauth"`: mcpd logs in for the profiles (implies proxy). */
  oauth?: OAuthSettings;
  /**
   * Profiles with a login of their own (`[server.<name>.variant.<profile>]`, OAuth servers only).
   * Every other profile shares the "default" login.
   */
  variants: Record<string, RemoteVariant>;
}

export type ServerDef = StdioServer | RemoteServer;

export interface Manifest {
  servers: Record<string, ServerDef>;
}

/** A value resolved at spawn time: "keychain:<service>" or "env:<NAME>". */
function isSecretRef(v: string): boolean {
  return v.startsWith("keychain:") || v.startsWith("env:");
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** "90s", "15m", "2h" or a number of seconds. */
function parseDuration(v: unknown, file: string, key: string): number {
  if (typeof v === "number" && v >= 0) return v;
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(v.trim());
    if (m) return Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
  }
  throw new ConfigError(file, `${key} must be a duration like "15m"`);
}

function strArray(v: unknown, file: string, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new ConfigError(file, `${key} must be an array of strings`);
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

const TOOL_PATTERN = /^[^\s]{1,128}$/;

/** `tools = { allow = [...], deny = [...] }`: a table with only those keys, each a list of patterns. */
function toolFilterOf(v: unknown, file: string, key: string): ToolFilter | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ConfigError(file, `${key} must be a table with allow and/or deny`);
  const out: ToolFilter = {};
  for (const [k, val] of Object.entries(v)) {
    if (k !== "allow" && k !== "deny")
      throw new ConfigError(file, `${key}.${k} is not a tool filter key (allow, deny)`);
    const list = strArray(val, file, `${key}.${k}`);
    for (const p of list)
      if (!TOOL_PATTERN.test(p)) throw new ConfigError(file, `${key}.${k}: invalid tool pattern ${JSON.stringify(p)}`);
    out[k] = list;
  }
  return out;
}

const OAUTH_KEYS: Record<string, keyof OAuthSettings> = {
  client_id: "clientId",
  client_secret: "clientSecret",
  client_metadata_url: "clientMetadataUrl",
  scope: "scope",
  callback_port: "callbackPort",
  authorization_server: "authorizationServer",
};

/** `auth = "oauth"` and the optional `[server.<name>.oauth]` table; undefined without OAuth. */
function oauthOf(
  v: Record<string, unknown>,
  file: string,
  key: string,
  headers: Record<string, string>,
): OAuthSettings | undefined {
  if (v.auth === undefined) {
    if (v.oauth !== undefined) throw new ConfigError(file, `${key}.oauth needs auth = "oauth"`);
    return undefined;
  }
  if (v.auth !== "oauth") throw new ConfigError(file, `${key}.auth must be "oauth"`);
  if (Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
    throw new ConfigError(
      file,
      `${key}: auth = "oauth" sets the Authorization header itself; remove headers.Authorization`,
    );
  }
  const raw = v.oauth ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError(file, `${key}.oauth must be a table`);
  const out: OAuthSettings = {};
  for (const [k, val] of Object.entries(raw)) {
    const field = OAUTH_KEYS[k];
    if (!field)
      throw new ConfigError(file, `${key}.oauth.${k} is not an OAuth setting (${Object.keys(OAUTH_KEYS).join(", ")})`);
    if (field === "callbackPort") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1024 || val > 65535) {
        throw new ConfigError(file, `${key}.oauth.callback_port must be a port number from 1024 to 65535`);
      }
      out.callbackPort = val;
      continue;
    }
    const s = optStr(val, file, `${key}.oauth.${k}`) as string;
    if (field === "clientSecret" && !isSecretRef(s)) {
      throw new ConfigError(
        file,
        `${key}.oauth.client_secret must be a keychain: or env: reference (turno secret set <name>), not the secret itself`,
      );
    }
    if ((field === "clientMetadataUrl" || field === "authorizationServer") && !/^https?:\/\/\S+$/.test(s)) {
      throw new ConfigError(file, `${key}.oauth.${k} must be a URL`);
    }
    (out as Record<string, string>)[field] = s;
  }
  return out;
}

function profilesOf(v: unknown, file: string, key: string): string[] {
  const list = v === undefined ? ["*"] : strArray(v, file, key);
  for (const p of list)
    if (p !== "*" && !isValidProfileName(p)) throw new ConfigError(file, `${key}: invalid profile "${p}"`);
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
      const { profiles: _p, idle: _i, call_timeout: _t, tools: _f, auth: _a, oauth: _o, variant: _v, ...rest } = v;
      const entry: Record<string, unknown> = { type: "http", ...rest };
      const headers = strRecord(v.headers, file, `${key}.headers`);
      const oauth = oauthOf(v, file, key, headers);
      const proxy = oauth !== undefined || Object.values(headers).some(isSecretRef);
      const tools = toolFilterOf(v.tools, file, `${key}.tools`);
      if (tools && !proxy) {
        throw new ConfigError(
          file,
          `${key}.tools only works for servers that go through mcpd; a remote server does when a header uses keychain: or env:, or with auth = "oauth"`,
        );
      }
      const remoteVariants: Record<string, RemoteVariant> = {};
      for (const [prof, vv] of Object.entries((v.variant ?? {}) as Record<string, unknown>)) {
        if (!oauth)
          throw new ConfigError(
            file,
            `${key}.variant: a remote server has variants only with auth = "oauth" (one login per variant)`,
          );
        if (!isValidProfileName(prof)) throw new ConfigError(file, `${key}.variant: invalid profile "${prof}"`);
        const o = (vv ?? {}) as Record<string, unknown>;
        const variant: RemoteVariant = {};
        const vtools = toolFilterOf(o.tools, file, `${key}.variant.${prof}.tools`);
        if (vtools) variant.tools = vtools;
        remoteVariants[prof] = variant;
      }
      const remote: RemoteServer = {
        kind: "remote",
        name,
        entry,
        profiles,
        proxy,
        url: v.url,
        headers,
        idle: v.idle === undefined ? 30 * 60 : parseDuration(v.idle, file, `${key}.idle`),
        variants: remoteVariants,
      };
      if (oauth) remote.oauth = oauth;
      if (v.call_timeout !== undefined) remote.callTimeout = parseDuration(v.call_timeout, file, `${key}.call_timeout`);
      if (tools) remote.tools = tools;
      servers[name] = remote;
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
      const vtools = toolFilterOf(o.tools, file, `${key}.variant.${prof}.tools`);
      if (vtools) variant.tools = vtools;
      variants[prof] = variant;
    }
    const server: StdioServer = {
      kind: "stdio",
      name,
      command,
      args: strArray(v.args, file, `${key}.args`),
      env: strRecord(v.env, file, `${key}.env`),
      scope,
      idle:
        v.idle === undefined ? (scope === "shared" ? 30 * 60 : 20 * 60) : parseDuration(v.idle, file, `${key}.idle`),
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
    if (v.call_timeout !== undefined) server.callTimeout = parseDuration(v.call_timeout, file, `${key}.call_timeout`);
    if (v.stop_grace !== undefined) {
      const grace = parseDuration(v.stop_grace, file, `${key}.stop_grace`);
      if (grace > MAX_STOP_GRACE) throw new ConfigError(file, `${key}.stop_grace must be at most ${MAX_STOP_GRACE}s`);
      server.stopGrace = grace;
    }
    const tools = toolFilterOf(v.tools, file, `${key}.tools`);
    if (tools) server.tools = tools;
    servers[name] = server;
  }
  return { servers };
}

export function loadManifest(env: NodeJS.ProcessEnv): Manifest {
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
export function variantKey(server: { variants: Record<string, unknown> }, profile: string | undefined): string {
  return profile && server.variants[profile] ? profile : "default";
}

/** Effective launch settings for a variant. */
/** The MCP SDK's fixed wait between closing stdin and SIGTERM, in seconds. */
const SDK_STOP_GRACE = 2;
/** turno-browser-mcp closes Chrome within about 2.5 s of stdin closing; 5 s leaves room. */
const BROWSER_STOP_GRACE = 5;
const MAX_STOP_GRACE = 60;

/**
 * Seconds mcpd gives a stdio server between closing its stdin and SIGTERM: its
 * `stop_grace`, else 5 for turno-browser-mcp however it is started (a path, npx), else the
 * SDK's 2.
 */
export function effectiveStopGrace(server: StdioServer, variant: string): number {
  if (server.stopGrace !== undefined) return server.stopGrace;
  const { command, args } = effectiveLaunch(server, variant);
  return [command, ...args].some((a) => a.split(/[\\/]/).pop() === "turno-browser-mcp")
    ? BROWSER_STOP_GRACE
    : SDK_STOP_GRACE;
}

export function effectiveLaunch(
  server: StdioServer,
  variant: string,
): { command: string; args: string[]; env: Record<string, string>; cwd?: string } {
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

/** The tool filter a profile's sessions get: the server's, with the variant's keys in place of its own. */
export function toolFilterFor(server: ServerDef, profile: string | undefined): ToolFilter {
  const base = server.tools ?? {};
  const v = server.variants[variantKey(server, profile)]?.tools;
  return v ? { ...base, ...v } : base;
}

function globRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/** Whether a tool passes a filter. */
export function toolAllowed(filter: ToolFilter, tool: string): boolean {
  const hit = (patterns: string[]) => patterns.some((p) => globRegExp(p).test(tool));
  if (filter.allow && !hit(filter.allow)) return false;
  return !(filter.deny && hit(filter.deny));
}

/** Whether a filter can hide anything. */
export function filtersTools(filter: ToolFilter): boolean {
  return filter.allow !== undefined || filter.deny !== undefined;
}
