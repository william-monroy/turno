import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";

/** Scope defaults for servers we know; unknown servers default to "project" (safe for folder-bound tools). */
const KNOWN: { match: RegExp; scope: "shared" | "project" | "session"; note: string }[] = [
  { match: /chrome-devtools-mcp/, scope: "session", note: "drives its own browser per session" },
  { match: /@playwright\/mcp|playwright-mcp/, scope: "session", note: "drives its own browser per session" },
  { match: /browser-use/, scope: "session", note: "drives its own browser per session" },
  { match: /trigger\.dev/, scope: "project", note: "reads the project in its working folder" },
  { match: /codebase-memory-mcp/, scope: "shared", note: "one index for every repository" },
  { match: /@calcom\/cal-mcp/, scope: "shared", note: "stateless API client" },
];

const SECRET_KEY = /(key|token|secret|password|passwd|pat|auth|credential)/i;

export interface ImportOptions {
  moveSecrets?: boolean;
  /** Bin name of an npm package (npm view <pkg> bin). Injectable for tests. */
  binOf?: (pkg: string) => Promise<string | undefined>;
  /** Stores a secret and returns its reference. Injectable for tests. */
  store?: (service: string, value: string) => Promise<void>;
}

export interface ImportReport {
  toml: string;
  notes: string[];
  secretsMoved: string[];
  literalSecrets: string[];
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
  return { scope: "project", note: "unknown server: started per project folder (change to shared if it does not use its folder)" };
}

export async function importServers(servers: Record<string, Record<string, unknown>>, opts: ImportOptions = {}): Promise<ImportReport> {
  const out: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  const secretsMoved: string[] = [];
  const literalSecrets: string[] = [];

  const secretRef = async (server: string, key: string, value: string): Promise<string> => {
    if (value.startsWith("keychain:") || value.startsWith("env:") || /^\$\{.+\}$/.test(value)) return value;
    if (!opts.moveSecrets || !opts.store) {
      literalSecrets.push(`${server}.${key}`);
      return value;
    }
    const service = `claudio/${server}/${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    await opts.store(service, value);
    secretsMoved.push(`${server}.${key} -> keychain:${service}`);
    return `keychain:${service}`;
  };

  for (const [name, entry] of Object.entries(servers)) {
    const type = (entry.type as string | undefined) ?? (entry.command ? "stdio" : "http");
    if (type === "stdio") {
      const command = String(entry.command ?? "");
      const args = ((entry.args as string[]) ?? []).map(String);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries((entry.env as Record<string, string>) ?? {})) {
        env[k] = SECRET_KEY.test(k) ? await secretRef(name, k, String(v)) : String(v);
      }
      const { scope, note } = guessScope(`${command} ${args.join(" ")}`);
      const server: Record<string, unknown> = {};
      if (command === "npx" || command.endsWith("/npx")) {
        const { pkg, rest } = parseNpx(args);
        if (pkg) {
          const bin = (await opts.binOf?.(packageName(pkg))) ?? packageName(pkg).replace(/^@[^/]+\//, "");
          server.command = bin;
          server.package = pkg;
          if (rest.length) server.args = rest;
          notes.push(`${name}: runs ${pkg} (claudio mcp install pins it and drops the npx wrapper)`);
        } else {
          server.command = command;
          server.args = args;
        }
      } else {
        server.command = command;
        if (args.length) server.args = args;
      }
      if (Object.keys(env).length) server.env = env;
      server.scope = scope;
      notes.push(`${name}: scope ${scope} (${note})`);
      out[name] = server;
      continue;
    }
    // Remote server: keep it direct unless its headers carry secrets we moved to the Keychain.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((entry.headers as Record<string, string>) ?? {})) {
      headers[k] = SECRET_KEY.test(k) || /^bearer\s/i.test(String(v)) ? await secretRef(name, k, String(v)) : String(v);
    }
    const server: Record<string, unknown> = { url: String(entry.url ?? "") };
    if (type !== "http") server.type = type;
    if (Object.keys(headers).length) server.headers = headers;
    const proxied = Object.values(headers).some((v) => v.startsWith("keychain:"));
    notes.push(`${name}: remote ${proxied ? "(proxied by mcpd, secrets in the Keychain)" : "(written directly into profiles)"}`);
    out[name] = server;
  }

  const header = [
    "# claudio MCP manifest. Generated by `claudio mcp import`; edit freely.",
    "# scope: shared (one process for every session) | project (one per project folder)",
    "#        | session (one per Claude session). Servers start on first use and stop when idle.",
    "# Docs: docs/mcp.md in the claudio repository.",
    "",
  ].join("\n");
  return { toml: `${header}${stringify({ server: out })}\n`, notes, secretsMoved, literalSecrets };
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
