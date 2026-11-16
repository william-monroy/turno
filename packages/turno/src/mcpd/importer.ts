import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { paths, tildify } from "../core/paths.js";

/** Scope defaults for servers we know; unknown servers default to "project" (safe for folder-bound tools). */
const KNOWN: { match: RegExp; scope: "shared" | "project" | "session"; note: string }[] = [
  { match: /chrome-devtools-mcp/, scope: "session", note: "drives its own browser per session" },
  { match: /@playwright\/mcp|playwright-mcp/, scope: "session", note: "drives its own browser per session" },
  { match: /browser-use/, scope: "session", note: "drives its own browser per session" },
  { match: /trigger\.dev/, scope: "project", note: "reads the project in its working folder" },
  { match: /codebase-memory-mcp/, scope: "shared", note: "one index for every repository" },
  { match: /@calcom\/cal-mcp/, scope: "shared", note: "stateless API client" },
];

/** Words in a key name that mark its value as a secret (PWD, PATH and the like do not match). */
const SECRET_WORDS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pass",
  "pat",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "bearer",
]);

/** Values that are tokens whatever their key is called. */
const TOKEN_VALUE = /^(gh[pousr]_|github_pat_|sk-|sk_live_|rk_live_|xox[abprs]-|glpat-|AKIA[0-9A-Z]{12})/;

/** Values that are clearly not secrets even under a secret-looking key (paths, plain URLs, flags). */
const PLAIN_VALUE = /^(?:[/~.]|https?:\/\/[^@?]*$|true$|false$|\d+$)/i;

/** `${VAR}`, `${VAR:-default}` and Cursor's `${env:VAR}`, as the whole value. */
const WHOLE_VAR = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/;
const ANY_VAR = /\$\{[^}]*\}/;
/** Cursor's own placeholders: not environment variables. */
const CURSOR_VARS = new Set(["userHome", "workspaceFolder", "workspaceFolderBasename", "pathSeparator"]);

/** Split a key name into lowercase words: `GITHUB_TOKEN`, `apiKey`, `X-Api-Key`. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSecretKey(key: string): boolean {
  return words(key).some((w) => SECRET_WORDS.has(w));
}

/** Whether a value under `key` holds a secret. */
export function isSecretValue(key: string, value: string): boolean {
  if (!value || value.startsWith("keychain:") || value.startsWith("env:") || ANY_VAR.test(value)) return false;
  if (TOKEN_VALUE.test(value) || /^bearer\s+\S/i.test(value)) return true;
  return isSecretKey(key) && !PLAIN_VALUE.test(value);
}

/** Show the kind of a secret and its last characters, never enough to use it: `ghp_****1234`. */
export function maskSecret(value: string): string {
  const bearer = /^(bearer\s+)(.*)$/i.exec(value);
  if (bearer) return `${bearer[1]}${maskSecret(bearer[2]!)}`;
  const prefix = /^([A-Za-z]{2,10}[_-])/.exec(value)?.[1] ?? "";
  const keepPrefix = prefix && value.length - prefix.length >= 8 ? prefix : "";
  const tail = value.length >= 16 ? value.slice(-4) : "";
  return `${keepPrefix}****${tail}`;
}

/** The `env:` reference for a value that is exactly `${VAR}` or `${VAR:-default}`, if it is one. */
export function envRef(value: string): string | undefined {
  const m = WHOLE_VAR.exec(value);
  if (!m || CURSOR_VARS.has(m[1]!)) return undefined;
  return m[2] !== undefined ? `env:${m[1]}:-${m[2]}` : `env:${m[1]}`;
}

/** Secret values in a stdio server's args: `--api-key=x`, `--token x` and bare tokens. */
export function argSecrets(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = /^--?([A-Za-z][\w-]*)=(.*)$/.exec(a);
    if (eq) {
      if (isSecretValue(eq[1]!, eq[2]!)) out.push(eq[2]!);
      continue;
    }
    const flag = /^--?([A-Za-z][\w-]*)$/.exec(a);
    const next = args[i + 1];
    if (flag && next !== undefined && !next.startsWith("-") && isSecretKey(flag[1]!)) {
      if (isSecretValue(flag[1]!, next)) out.push(next);
      i++;
      continue;
    }
    if (TOKEN_VALUE.test(a)) out.push(a);
  }
  return out;
}

/** Secret values in a URL: query parameters such as `?api_key=...` and a password in the user part. */
export function urlSecrets(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (u.password) out.push(decodeURIComponent(u.password));
  for (const [k, v] of u.searchParams) if (isSecretValue(k, v)) out.push(v);
  return out;
}

/** A secret the import would store in the Keychain (only with --write --move-secrets). */
export interface PendingSecret {
  /** `server.KEY`, for messages. */
  where: string;
  service: string;
  value: string;
}

export interface ImportOptions {
  moveSecrets?: boolean;
  /** Bin name of an npm package (npm view <pkg> bin). Injectable for tests. */
  binOf?: (pkg: string) => Promise<string | undefined>;
}

export interface ImportReport {
  /** The manifest `--write` writes: Keychain references when moving secrets, literal values otherwise. */
  toml: string;
  /** The same manifest with every literal secret masked and marked, safe to print. */
  preview: string;
  notes: string[];
  /** Secrets to store before writing the manifest. The import itself never stores anything. */
  secrets: PendingSecret[];
  /** Secrets kept literally that --move-secrets would move (env values and headers). */
  literalSecrets: string[];
  /** Secrets kept literally that cannot be moved (args and URLs are used as written). */
  fixedSecrets: string[];
  servers: string[];
}

function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Split `npx [-y] pkg[@ver] args...` into the package spec and the rest. */
export function parseNpx(args: string[]): { pkg?: string; rest: string[] } {
  const rest = [...args];
  while (rest.length && rest[0]!.startsWith("-")) rest.shift();
  const pkg = rest.shift();
  return pkg ? { pkg, rest } : { rest };
}

export function guessScope(text: string): { scope: "shared" | "project" | "session"; note: string } {
  for (const k of KNOWN) if (k.match.test(text)) return { scope: k.scope, note: k.note };
  return { scope: "project", note: 'unknown server, one process per project folder; set scope = "shared" if it ignores its folder' };
}

function serviceKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

const HEADER = [
  "# turno MCP manifest. Generated by `turno mcp import`; edit freely.",
  "# scope: shared (one process for every session) | project (one per project folder)",
  "#        | session (one per Claude session). Servers start on first use and stop when idle.",
  "# Docs: docs/mcp.md in the turno repository.",
  "",
].join("\n");

export async function importServers(servers: Record<string, Record<string, unknown>>, opts: ImportOptions = {}): Promise<ImportReport> {
  const out: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  const secrets: PendingSecret[] = [];
  const literalSecrets: string[] = [];
  const fixedSecrets: string[] = [];
  /** Literal secret values left in the manifest, masked in the preview. */
  const hidden = new Set<string>();

  const secretRef = (server: string, key: string, value: string): string => {
    // Never move a value that still holds a variable: the Keychain would get the placeholder.
    if (value.includes("${")) return value;
    if (!opts.moveSecrets) {
      literalSecrets.push(`${server}.${key}`);
      hidden.add(value);
      return value;
    }
    const service = `turno/${server}/${serviceKey(key)}`;
    secrets.push({ where: `${server}.${key}`, service, value });
    return `keychain:${service}`;
  };

  const fixed = (server: string, where: string, values: string[]): void => {
    if (!values.length) return;
    for (const v of values) hidden.add(v);
    fixedSecrets.push(`${server}.${where}`);
    notes.push(
      where === "args"
        ? `${server}: its args hold a secret, kept in mcp.toml as written (args cannot come from the Keychain; if the server reads it from an environment variable, move it to env)`
        : `${server}: its URL holds a secret, kept in mcp.toml as written (a URL cannot come from the Keychain; use a header if the server accepts one)`,
    );
  };

  for (const [name, entry] of Object.entries(servers)) {
    const type = (entry.type as string | undefined) ?? (entry.command ? "stdio" : "http");
    if (type === "stdio" || type === "local") {
      const command = String(entry.command ?? "");
      const args = ((entry.args as unknown[]) ?? []).map(String);
      const env: Record<string, string> = {};
      const fromEnv: string[] = [];
      for (const [k, raw] of Object.entries((entry.env as Record<string, unknown>) ?? {})) {
        const v = String(raw);
        if (v.startsWith("keychain:") || v.startsWith("env:")) {
          env[k] = v;
          continue;
        }
        const ref = envRef(v);
        if (ref) {
          env[k] = ref;
          fromEnv.push(ref.slice(4).replace(/:-.*$/, ""));
          continue;
        }
        if (ANY_VAR.test(v)) {
          env[k] = v;
          notes.push(
            `${name}: env ${k} mixes text and a variable (${v.match(ANY_VAR)![0]}); mcpd passes it as written. Store the full value with turno secret set turno/${name}/${serviceKey(k)} and set ${k} = "keychain:turno/${name}/${serviceKey(k)}"`,
          );
          continue;
        }
        env[k] = isSecretValue(k, v) ? secretRef(name, k, v) : v;
      }
      if (fromEnv.length) {
        notes.push(
          `${name}: reads ${fromEnv.join(", ")} from mcpd's environment (env:); under the LaunchAgent mcpd only sees variables set with launchctl setenv, so prefer keychain: for secrets`,
        );
      }
      if (args.some((a) => ANY_VAR.test(a))) {
        notes.push(`${name}: its args use \${...} variables; mcpd passes args as written, so move those values to env`);
      }
      fixed(name, "args", argSecrets(args));
      const { scope, note } = guessScope(`${command} ${args.join(" ")}`);
      const server: Record<string, unknown> = {};
      if (command === "npx" || command.endsWith("/npx")) {
        const { pkg, rest } = parseNpx(args);
        if (pkg) {
          const bin = (await opts.binOf?.(packageName(pkg))) ?? packageName(pkg).replace(/^@[^/]+\//, "");
          server.command = bin;
          server.package = pkg;
          if (rest.length) server.args = rest;
          notes.push(`${name}: runs ${pkg}; turno mcp install pins it to an exact version and drops the npx wrapper`);
        } else {
          server.command = command;
          server.args = args;
        }
      } else {
        server.command = command;
        if (args.length) server.args = args;
      }
      if (Object.keys(env).length) server.env = env;
      if (typeof entry.cwd === "string" && entry.cwd) server.cwd = entry.cwd;
      server.scope = scope;
      notes.push(`${name}: scope ${scope}: ${note}`);
      out[name] = server;
      continue;
    }
    // Remote server: keep it direct unless its headers carry secrets moved to the Keychain.
    const url = String(entry.url ?? "");
    const headers: Record<string, string> = {};
    const withVars: string[] = [];
    for (const [k, raw] of Object.entries((entry.headers as Record<string, unknown>) ?? {})) {
      const v = String(raw);
      if (ANY_VAR.test(v)) {
        headers[k] = v;
        withVars.push(k);
        continue;
      }
      headers[k] = isSecretValue(k, v) ? secretRef(name, k, v) : v;
    }
    const proxied = Object.values(headers).some((v) => v.startsWith("keychain:") || v.startsWith("env:"));
    for (const k of withVars) {
      if (!proxied) {
        notes.push(`${name}: header ${k} uses a variable; kept as written so Claude Code expands it when it connects`);
        continue;
      }
      // mcpd proxies this server and does not expand ${...}: whole variables become env: references.
      const ref = envRef(headers[k]!);
      if (ref) headers[k] = ref;
      else notes.push(`${name}: header ${k} mixes text and a variable; mcpd sends it as written. Store the full value in the Keychain instead`);
    }
    fixed(name, "url", urlSecrets(url));
    if (ANY_VAR.test(url)) notes.push(`${name}: its URL uses a variable; kept as written so Claude Code expands it`);
    const server: Record<string, unknown> = { url };
    if (type !== "http") server.type = type;
    if (Object.keys(headers).length) server.headers = headers;
    const proxy = Object.values(headers).some((v) => v.startsWith("keychain:") || v.startsWith("env:"));
    notes.push(`${name}: remote, ${proxy ? "proxied by mcpd so its secrets stay out of profile configs" : "written directly into profiles"}`);
    out[name] = server;
  }

  const toml = `${HEADER}${stringify({ server: out })}\n`;
  const masks = new Map([...hidden].sort((a, b) => b.length - a.length).map((v) => [v, maskSecret(v)] as const));
  const masked = mapStrings(out, (s) => {
    let r = s;
    for (const [v, m] of masks) r = r.split(v).join(m);
    return r;
  });
  const shown = [...masks.values()];
  const preview = `${HEADER}${stringify({ server: masked })}`
    .split("\n")
    .map((l) => (!l.startsWith("#") && shown.some((m) => l.includes(m)) ? `${l}  # secret, hidden` : l))
    .join("\n");
  return { toml, preview: `${preview}\n`, notes, secrets, literalSecrets, fixedSecrets, servers: Object.keys(out) };
}

/** MCP servers found in one agent config file. Entries use Claude Code's shape. */
export interface Source {
  /** Where they came from, for messages: `~/.claude.json`, `~/.codex/config.toml`, ... */
  label: string;
  servers: Record<string, Record<string, unknown>>;
}

/** Entries turno itself wrote (gateway entries): importing them back would loop. */
function isGatewayEntry(e: Record<string, unknown>): boolean {
  const headers = { ...((e.headers as Record<string, unknown>) ?? {}), ...((e.http_headers as Record<string, unknown>) ?? {}) };
  if (Object.keys(headers).some((h) => h.toLowerCase() === "x-turno-profile")) return true;
  return e.bearer_token_env_var === "TURNO_MCPD_TOKEN";
}

function objectsOf(v: unknown): Record<string, Record<string, unknown>> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, e] of Object.entries(v)) {
    if (e && typeof e === "object" && !Array.isArray(e) && !isGatewayEntry(e as Record<string, unknown>)) out[k] = e as Record<string, unknown>;
  }
  return out;
}

/** A Codex `[mcp_servers.<name>]` table in Claude Code's shape. */
function fromCodex(e: Record<string, unknown>): Record<string, unknown> {
  if (typeof e.command === "string") {
    const env: Record<string, string> = { ...((e.env as Record<string, string>) ?? {}) };
    for (const v of (e.env_vars as unknown[]) ?? []) if (typeof v === "string") env[v] = `\${${v}}`;
    return {
      type: "stdio",
      command: e.command,
      args: (e.args as unknown[]) ?? [],
      ...(Object.keys(env).length ? { env } : {}),
      ...(typeof e.cwd === "string" ? { cwd: e.cwd } : {}),
    };
  }
  const headers: Record<string, string> = { ...((e.http_headers as Record<string, string>) ?? {}) };
  for (const [h, v] of Object.entries((e.env_http_headers as Record<string, string>) ?? {})) headers[h] = `\${${v}}`;
  if (typeof e.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${e.bearer_token_env_var}}`;
  return { type: "http", url: e.url, ...(Object.keys(headers).length ? { headers } : {}) };
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Every MCP server configured for an agent on this machine: Claude Code (user and project
 * servers in ~/.claude.json, the folder's .mcp.json), Codex (~/.codex/config.toml), Cursor
 * (~/.cursor/mcp.json) and Copilot CLI (~/.copilot/mcp-config.json). Missing files are skipped;
 * unreadable ones are reported in `problems`.
 */
export function collectSources(env: NodeJS.ProcessEnv, cwd: string): { sources: Source[]; problems: string[] } {
  const p = paths(env);
  const sources: Source[] = [];
  const problems: string[] = [];
  const t = (f: string) => tildify(f, env);
  const attempt = (file: string, read: () => void) => {
    try {
      read();
    } catch (err) {
      problems.push(`cannot read ${t(file)}: ${(err as Error).message.split("\n")[0]}`);
    }
  };
  const add = (label: string, servers: Record<string, Record<string, unknown>>) => {
    if (Object.keys(servers).length) sources.push({ label, servers });
  };

  attempt(p.hubConfig, () => {
    const hub = readJson(p.hubConfig);
    if (!hub) return;
    add(t(p.hubConfig), objectsOf(hub.mcpServers));
    for (const [dir, proj] of Object.entries((hub.projects as Record<string, Record<string, unknown>>) ?? {})) {
      add(`${t(p.hubConfig)} project ${t(dir)}`, objectsOf(proj?.mcpServers));
    }
  });
  const folder = join(cwd, ".mcp.json");
  attempt(folder, () => {
    const m = readJson(folder);
    if (m) add(t(folder), objectsOf(m.mcpServers));
  });
  const codex = join(p.home, ".codex", "config.toml");
  attempt(codex, () => {
    if (!existsSync(codex)) return;
    const raw = objectsOf((parse(readFileSync(codex, "utf8")) as Record<string, unknown>).mcp_servers);
    add(t(codex), Object.fromEntries(Object.entries(raw).map(([k, e]) => [k, fromCodex(e)])));
  });
  const cursor = join(p.home, ".cursor", "mcp.json");
  attempt(cursor, () => {
    const m = readJson(cursor);
    if (m) add(t(cursor), objectsOf(m.mcpServers));
  });
  const copilot = join(p.home, ".copilot", "mcp-config.json");
  attempt(copilot, () => {
    const m = readJson(copilot);
    if (m) add(t(copilot), objectsOf(m.mcpServers));
  });
  return { sources, problems };
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** One server map from every source: first source wins a name; differing duplicates are noted. */
export function mergeSources(sources: Source[]): { servers: Record<string, Record<string, unknown>>; from: Record<string, string>; notes: string[] } {
  const servers: Record<string, Record<string, unknown>> = {};
  const from: Record<string, string> = {};
  const notes: string[] = [];
  for (const src of sources) {
    for (const [raw, entry] of Object.entries(src.servers)) {
      let name = raw;
      if (!SERVER_NAME.test(name)) {
        name = raw.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9_.-]+/g, "-") || "server";
        notes.push(`${raw}: renamed to ${name} (mcp.toml names use letters, digits, ".", "_" and "-")`);
      }
      const prev = servers[name];
      if (prev) {
        if (JSON.stringify(prev) !== JSON.stringify(entry)) notes.push(`${name}: also in ${src.label} with other settings; kept the one from ${from[name]}`);
        continue;
      }
      servers[name] = entry;
      from[name] = src.label;
    }
  }
  return { servers, from, notes };
}

/** `found 3 servers: 2 in ~/.claude.json (a, b); 1 in ~/.codex/config.toml (c)`. */
export function foundSummary(names: string[], from: Record<string, string>): string {
  const by = new Map<string, string[]>();
  for (const n of names) by.set(from[n]!, [...(by.get(from[n]!) ?? []), n]);
  const parts = [...by].map(([src, ns]) => `${ns.length} in ${src} (${ns.join(", ")})`);
  return `found ${names.length} server${names.length === 1 ? "" : "s"}: ${parts.join("; ")}`;
}

export interface PluginServer {
  plugin: string;
  name: string;
  /** Tool prefix Claude Code gives it. */
  toolPrefix: string;
  transport: "stdio" | "remote";
  command?: string;
}

/** Stdio servers provided by enabled plugins: they bypass mcpd and start in every session. */
export function pluginServers(hub: string): PluginServer[] {
  let enabled: Record<string, boolean> = {};
  try {
    const settings = JSON.parse(readFileSync(join(hub, "settings.json"), "utf8")) as { enabledPlugins?: Record<string, boolean> };
    enabled = settings.enabledPlugins ?? {};
  } catch {
    return [];
  }
  const found: PluginServer[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    const [plugin, marketplace] = id.split("@");
    if (!plugin || !marketplace) continue;
    const base = join(hub, "plugins", "cache", marketplace, plugin);
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .map((v) => join(base, v))
      .filter((d) => existsSync(join(d, ".mcp.json")))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const latest = versions[0];
    if (!latest) continue;
    let mcp: Record<string, unknown> = {};
    try {
      mcp = JSON.parse(readFileSync(join(latest, ".mcp.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const servers = (mcp.mcpServers ?? mcp) as Record<string, Record<string, unknown>>;
    for (const [name, def] of Object.entries(servers)) {
      if (typeof def !== "object" || def === null) continue;
      const stdio = typeof def.command === "string";
      found.push({
        plugin,
        name,
        toolPrefix: `mcp__plugin_${plugin}_${name}__`,
        transport: stdio ? "stdio" : "remote",
        ...(stdio ? { command: `${def.command} ${((def.args as string[]) ?? []).join(" ")}`.trim() } : {}),
      });
    }
  }
  return found;
}
